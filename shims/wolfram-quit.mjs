#!/usr/bin/env node
/**
 * Wolfram MCP shim — turns stdin EOF into the "Quit" line the server needs.
 *
 * StartMCPServer.wl only exits when it reads the literal string "Quit":
 *
 *     If[ stdin === "Quit", Exit[ 0 ] ];
 *     If[ ! StringQ @ stdin || StringTrim @ stdin === "", Throw @ EndOfFile ];
 *     ...
 *     If[ AssociationQ @ response, WriteLine[...], Pause[ 0.1 ] ]
 *
 * After a client closes the transport, `stdin` becomes EndOfFile, which is not
 * an Association, so the loop keeps pausing instead of exiting. The client then
 * waits out its whole close budget (5s by default) before giving up, and the
 * kernel (plus the MathematicaServer child it spawned) may survive.
 *
 * This shim forwards stdio verbatim and, on EOF or a termination signal, writes
 * "Quit" so the server exits cleanly — measured at ~3ms instead of hanging.
 */
import { spawn } from 'node:child_process'

const KERNEL = '/Applications/Wolfram Engine.app/Contents/Resources/Wolfram Player.app/Contents/MacOS/WolframKernel'
const START = 'PacletSymbol["Wolfram/AgentTools","Wolfram`AgentTools`StartMCPServer"][]'

const child = spawn(KERNEL, ['-run', START, '-noinit', '-noprompt'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
  // Own process group: the kernel spawns MathematicaServer as a child, so the
  // group kill below is what stops the whole tree.
  detached: true,
})

child.stdout.pipe(process.stdout)
// Forward stdin manually: `.pipe()` would end the child's stdin on EOF, and the
// final "Quit" write would then fail with ERR_STREAM_WRITE_AFTER_END.
child.stdin.on('error', () => { /* EPIPE when the kernel is already gone */ })
process.stdin.on('data', (chunk) => {
  try {
    child.stdin.write(chunk)
  } catch {
    /* ignore */
  }
})

let quitting = false
function quit() {
  if (quitting) return
  quitting = true
  try {
    child.stdin.write('Quit\n')
  } catch {
    /* the kernel may already be gone */
  }
  try {
    child.stdin.end()
  } catch {
    /* ignore */
  }
  // Escalate only if "Quit" did not take effect.
  const signalGroup = (name) => {
    const pid = child.pid
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
  setTimeout(() => signalGroup('SIGTERM'), 2000)
  setTimeout(() => {
    signalGroup('SIGKILL')
    process.exit(0)
  }, 4000)
}

process.stdin.on('end', quit)
process.stdin.on('close', quit)
process.on('SIGTERM', quit)
process.on('SIGINT', quit)
process.on('SIGHUP', quit)
child.on('exit', () => process.exit(0))
child.on('error', () => process.exit(1))
