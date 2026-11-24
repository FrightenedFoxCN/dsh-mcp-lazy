/**
 * dsh-mcp-lazy — start MCP servers when they are needed, not at boot.
 *
 * The MCP client plugin connects and performs tool discovery while the harness
 * starts, so every configured server costs boot time even when a session never
 * touches it. This plugin keeps one tool that flips the configured Loader rows:
 *
 *   mcp_lazy action=status                     → what is on/off right now
 *   mcp_lazy action=enable  server=wolfram     → start it now (tools appear)
 *   mcp_lazy action=disable server=wolfram     → stop it now (tools disappear)
 *
 * It is not "resolve on first call": the model must see a tool's schema before
 * it can call that tool, so a server has to be started before its tools exist.
 * Enabling is therefore one explicit step, which the model can take as soon as
 * a task needs that server.
 */

export const name = 'mcp-lazy'
export const inject = ['tools']

const DEFAULTS = {
  toolName: 'mcp_lazy',
  servers: [],
}

function normalize(config) {
  const out = { ...DEFAULTS }
  if (config && typeof config === 'object') {
    if (typeof config.toolName === 'string' && config.toolName) out.toolName = config.toolName
    if (Array.isArray(config.servers)) out.servers = config.servers
  }
  out.servers = out.servers
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      name: String(entry.name ?? ''),
      entry: String(entry.entry ?? ''),
      note: entry.note === undefined ? undefined : String(entry.note),
    }))
    .filter((entry) => entry.name !== '' && entry.entry !== '')
  return out
}

export function apply(ctx, config = {}) {
  const cfg = normalize(config)
  const loader = () => ctx.get?.('loader') ?? ctx.loader

  const byName = (name) => cfg.servers.find((server) => server.name === name)

  const describe = (server) => {
    const entry = loader()?.resolve?.(server.entry)
    // Absent `disabled` means the row is running.
    const disabled = entry === undefined ? undefined : Boolean(entry?.options?.disabled)
    return {
      server: server.name,
      entry: server.entry,
      disabled,
      note: server.note,
    }
  }

  /** @param wanted - the target `disabled` value: true stops the row. */
  const toggle = async (server, wanted) => {
    const activeLoader = loader()
    if (!activeLoader || typeof activeLoader.resolve !== 'function' || typeof activeLoader.update !== 'function') {
      throw new Error('mcp_lazy: the Loader service is unavailable, so MCP rows cannot be toggled at runtime')
    }
    const entry = activeLoader.resolve(server.entry)
    if (!entry) throw new Error(`mcp_lazy: no Loader entry "${server.entry}" — check the configured entry id`)
    const options = entry.options ?? {}
    if (Boolean(options.disabled) === wanted) return describe(server)
    await activeLoader.update(server.entry, { ...options, disabled: wanted })
    return describe(server)
  }

  const disposer = ctx.tools.register({
    name: cfg.toolName,
    description:
      'Start or stop a heavy MCP server on demand. MCP servers connect and discover tools while the harness '
      + 'boots, so unused ones cost startup time; this tool keeps them off until a task needs them. '
      + 'Call `status` first to see what is available, then `enable` the server you need — its tools appear '
      + 'in your tool list for later steps of this same session. Use `disable` when you are done to give the '
      + 'process and its memory back.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'enable', 'disable'],
          description: 'status lists configured servers; enable/disable toggle one of them.',
        },
        server: {
          type: 'string',
          description: 'Server name from `status` (required for enable/disable).',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          servers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                server: { type: 'string' },
                entry: { type: 'string' },
                disabled: { type: 'boolean' },
                note: { type: 'string' },
              },
              required: ['server', 'entry'],
            },
          },
        },
        required: ['servers'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.servers.length === 0
          ? `${cfg.toolName}: no servers configured`
          : value.servers.map((row) => {
            const state = row.disabled === undefined ? 'unknown' : row.disabled ? 'off' : 'ON'
            const note = row.note ? `  — ${row.note}` : ''
            return `${state.padEnd(7)} ${row.server.padEnd(8)} (${row.entry})${note}`
          }).join('\n'),
      }],
    },
    async execute(args) {
      const action = String(args?.action ?? '')
      if (action === 'status') {
        return { servers: cfg.servers.map(describe) }
      }
      if (action !== 'enable' && action !== 'disable') {
        throw new Error(`mcp_lazy: unknown action "${action}" (expected status, enable, or disable)`)
      }
      const server = byName(String(args?.server ?? ''))
      if (server === undefined) {
        const known = cfg.servers.map((row) => row.name).join(', ') || '(none)'
        throw new Error(`mcp_lazy: unknown server "${args?.server ?? ''}"; configured servers: ${known}`)
      }
      const row = await toggle(server, action === 'disable')
      return { servers: [row] }
    },
  })

  return disposer
}
