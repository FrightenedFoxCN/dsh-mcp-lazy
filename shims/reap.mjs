#!/usr/bin/env node
/**
 * MCP process-tree reaper.
 *
 * The harness closes an MCP server's stdio on shutdown and waits its close
 * budget, but it does not walk the process tree: a launcher like `uvx` or `npx`
 * keeps its real server as a grandchild, and that grandchild survives. Observed
 * here: a `uvx lean-lsp-mcp` pair still alive 12 minutes after its DSH parent
 * exited, reparented to init.
 *
 * This shim becomes the direct child instead. It starts the real command in its
 * own process group (detached), forwards stdio verbatim, and on stdin EOF or any
 * termination signal sends SIGTERM then SIGKILL to the whole group, so the
 * launcher's grandchildren die with it.
 *
 * Configured through the environment so one file serves every server:
 *   MCP_SHIM_COMMAND   executable to run (required)
 *   MCP_SHIM_ARGS      JSON array of arguments (default [])
 *   MCP_SHIM_CWD       working directory (default: inherit)
 *   MCP_SHIM_GRACE_MS  SIGTERM→SIGKILL grace (default 2000)
 */
import { spawn } from 'node:child_process'

const command = process.env.MCP_SHIM_COMMAND
if (!command) {
  process.stderr.write('mcp reaper: MCP_SHIM_COMMAND is not set\n')
  process.exit(2)
}

let args = []
try {
  const raw = process.env.MCP_SHIM_ARGS
  if (raw !== undefined && raw.trim() !== '') args = JSON.parse(raw)
  if (!Array.isArray(args)) throw new Error('not an array')
} catch (error) {
  process.stderr.write(`mcp reaper: MCP_SHIM_ARGS is not a JSON array: ${String(error?.message ?? error)}\n`)
  process.exit(2)
}

const graceMs = Number(process.env.MCP_SHIM_GRACE_MS ?? 2000)

const child = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'inherit'],
  // Own process group: kill(-pid) then reaches the launcher's grandchildren.
  detached: true,
  cwd: process.env.MCP_SHIM_CWD || undefined,
  env: process.env,
})

child.stdout.pipe(process.stdout)
child.stdin.on('error', () => { /* EPIPE once the server is gone */ })
process.stdin.on('data', (chunk) => {
  try {
    child.stdin.write(chunk)
  } catch {
    /* ignore */
  }
})

let stopping = false
function stop(signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  const pid = child.pid
  const signalGroup = (name) => {
    if (pid === undefined) return
    try {
      process.kill(-pid, name)
    } catch {
      try {
        child.kill(name)
      } catch {
        /* already gone */
      }
    }
  }
  signalGroup(signal)
  setTimeout(() => signalGroup('SIGKILL'), graceMs)
  // Give the tree a moment, then leave regardless: the harness timeout is shorter
  // than waiting on an unresponsive server.
  setTimeout(() => process.exit(0), graceMs + 1000)
}

process.stdin.on('end', () => stop('SIGTERM'))
process.stdin.on('close', () => stop('SIGTERM'))
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGHUP', () => stop('SIGHUP'))

child.on('exit', () => process.exit(0))
child.on('error', (error) => {
  process.stderr.write(`mcp reaper: failed to start ${command}: ${error.message}\n`)
  process.exit(1)
})
