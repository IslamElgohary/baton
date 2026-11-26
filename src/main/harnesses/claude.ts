import type { Harness, ParsedEvent } from './types'

/**
 * Read-only: only Claude Code's built-in read tools exist in the session (Bash, Edit, Write, Agent… are
 * not loaded, so calls to them fail), no MCP servers, and the repo's own .claude/settings*.json is ignored:
 * print mode skips the workspace-trust prompt, so its hooks would otherwise run shell commands.
 */
const READ_ONLY_ARGS = ['--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--setting-sources', 'user']
const MAX_TOOL_OUTPUT = 20_000
/** Model aliases the CLI resolves to the latest version; any full model id works too. */
const MODELS = ['opus', 'sonnet', 'haiku', 'fable']

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string | Block[]; is_error?: boolean }

const textOf = (c: string | Block[] | undefined) =>
  typeof c === 'string' ? c : (c ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')

/**
 * Claude Code (`claude -p --input-format stream-json`): one process, a stream-json user message per turn on
 * stdin, Agent SDK messages on stdout; each turn ends with a `result` message. Closing stdin ends the process.
 * See test/fixtures/claude-*.jsonl.
 */
export const claude: Harness = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  loginArgs: ['auth', 'login'],
  // Background subagents and shell commands end the turn (`result`) while they still run, then start a turn of
  // their own when they finish. Baton reads a turn end as "your move", so keep everything in the foreground.
  env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },

  async probe(run) {
    const [v, a] = await Promise.all([run(['--version']), run(['auth', 'status'])])
    let auth: { loggedIn?: boolean; authMethod?: string } = {}
    try { auth = JSON.parse(a.stdout) } catch { /* not signed in, or an old CLI */ }
    const loggedIn = auth.loggedIn === true
    return {
      version: v.code === 0 ? v.stdout.trim() : null,
      loggedIn,
      detail: loggedIn ? `Signed in (${auth.authMethod ?? 'unknown method'})` : 'Not signed in: run `claude auth login`',
      models: loggedIn ? MODELS : []
    }
  },

  sessionArgs({ model, permission, resume }) {
    return [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose', // required for stream-json output in print mode
      '--include-partial-messages', // stream text as it's written
      // Nobody can answer a permission prompt in a headless session: deny instead of waiting forever.
      '--permission-prompts', 'none',
      ...(model ? ['--model', model] : []),
      ...(resume ? ['--resume', resume] : []),
      // Fail closed: anything but an explicit 'full' gets the read-only tool set.
      ...(permission === 'full' ? ['--permission-mode', 'bypassPermissions'] : READ_ONLY_ARGS)
    ]
  },

  encodeTurn: (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }),

  promptNote: (permission) => permission !== 'full'
    ? '\n\n(Read-only session: only the Read, Grep and Glob tools are available. You cannot edit files or run commands.)'
    : '',

  parser() {
    let sessionId: string | undefined
    const names = new Map<string, string>() // tool_use id → tool name, for its result
    return {
      line(line): ParsedEvent[] {
        let e: any
        try { e = JSON.parse(line) } catch { return [{ kind: 'info', text: line }] }
        switch (e.type) {
          case 'system':
            // `init` repeats at the start of every turn.
            if (e.subtype === 'init' && e.session_id && e.session_id !== sessionId) {
              sessionId = e.session_id
              return [{ kind: 'session', id: e.session_id }]
            }
            return []
          case 'stream_event': {
            const d = e.event?.type === 'content_block_delta' ? e.event.delta : undefined
            if (d?.type === 'text_delta' && d.text) return [{ kind: 'text', text: d.text }]
            if (d?.type === 'thinking_delta' && d.thinking) return [{ kind: 'thinking', text: d.thinking }]
            return []
          }
          case 'assistant': // complete messages: text already streamed above, so only tool calls
            return (e.message?.content as Block[] ?? []).filter((b) => b.type === 'tool_use').map((b): ParsedEvent => {
              names.set(b.id!, b.name!)
              return { kind: 'tool', id: b.id!, name: b.name!, input: b.input, done: false }
            })
          case 'user': {
            const content = e.message?.content
            if (!Array.isArray(content)) return []
            return (content as Block[]).filter((b) => b.type === 'tool_result').map((b): ParsedEvent => ({
              kind: 'tool',
              id: b.tool_use_id!,
              name: names.get(b.tool_use_id!) ?? 'tool',
              output: ((b.is_error ? 'Error: ' : '') + textOf(b.content)).slice(0, MAX_TOOL_OUTPUT),
              done: true
            }))
          }
          case 'result': {
            const ok = e.subtype === 'success' && !e.is_error
            const response = typeof e.result === 'string' ? e.result : ''
            return [{ kind: 'turn_end', ok, response, error: ok ? undefined : response || e.errors?.join('\n') || e.subtype }]
          }
          default:
            return []
        }
      }
    }
  }
}
