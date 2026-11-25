import type { Harness, ParsedEvent } from './types'

/** Read-only: only pi's read tools (the allowlist also drops extension tools), no MCP tools, no repo extensions. */
const READ_ONLY_ARGS = ['--tools', 'read,grep,find,ls', '--no-mcp', '--no-approve']
const MAX_TOOL_OUTPUT = 20_000
/** Extension dialogs block pi until answered; nobody can answer in a headless session. */
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor'])

type Content = { type: string; text?: string }
type AssistantMessage = { role: string; content?: Content[] | string; stopReason?: string; errorMessage?: string }

const textOf = (content: Content[] | string | undefined) =>
  typeof content === 'string' ? content : (content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')

/**
 * pi (`pi --mode rpc`): one long-lived process, JSONL commands on stdin, session events on stdout.
 * A turn is a `prompt` command and ends with `agent_settled`. See docs/rpc.md and docs/json.md in the pi
 * package, and test/fixtures/pi-*.jsonl.
 */
export const pi: Harness = {
  id: 'pi',
  name: 'pi',
  bin: 'pi',
  loginArgs: [], // interactive pi; sign in with /login

  async probe(run) {
    const [v, m] = await Promise.all([run(['--version']), run(['--list-models'])])
    // `pi --list-models` prints a table: "provider  model  context …"; models are addressed as provider/model.
    const models = m.stdout.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 2 && c[0]).map((c) => `${c[0]}/${c[1]}`)
    const loggedIn = m.code === 0 && models.length > 0
    return {
      version: v.code === 0 ? v.stdout.trim() : null,
      loggedIn,
      detail: loggedIn ? `${models.length} models` : (m.stderr || m.stdout).trim().slice(0, 300) || 'No models available: sign in with /login in pi',
      models
    }
  },

  sessionArgs({ model, permission, resume }) {
    return [
      '--mode', 'rpc',
      ...(model ? ['--model', model] : []),
      ...(resume ? ['--session', resume] : []),
      // Fail closed: anything but an explicit 'full' gets the read-only tool set. pi never asks before tool calls.
      ...(permission === 'full' ? [] : READ_ONLY_ARGS)
    ]
  },

  startup: [JSON.stringify({ id: 'baton-state', type: 'get_state' })], // its response carries the session id

  encodeTurn: (text) => JSON.stringify({ type: 'prompt', message: text }),

  promptNote: (permission) => permission !== 'full'
    ? '\n\n(Read-only session: only the read, grep, find and ls tools are available. You cannot edit files or run commands.)'
    : '',

  parser() {
    let last: AssistantMessage | undefined // final assistant message of the current turn
    return {
      line(line): ParsedEvent[] {
        let e: any
        try { e = JSON.parse(line) } catch { return [{ kind: 'info', text: line }] }
        switch (e.type) {
          case 'response':
            if (e.command === 'get_state' && e.success && e.data?.sessionId) return [{ kind: 'session', id: e.data.sessionId }]
            if (e.command === 'prompt' && !e.success) return [{ kind: 'turn_end', ok: false, response: '', error: e.error || 'Prompt rejected' }]
            return []
          case 'message_update': {
            const u = e.assistantMessageEvent
            if (u?.type === 'text_delta' && u.delta) return [{ kind: 'text', text: u.delta }]
            if (u?.type === 'thinking_delta' && u.delta) return [{ kind: 'thinking', text: u.delta }]
            return []
          }
          case 'message_end':
            if (e.message?.role === 'assistant') last = e.message
            return []
          case 'tool_execution_start':
            return [{ kind: 'tool', id: e.toolCallId, name: e.toolName, input: e.args, done: false }]
          case 'tool_execution_end': {
            const out = textOf(e.result?.content)
            return [{ kind: 'tool', id: e.toolCallId, name: e.toolName, output: ((e.isError ? 'Error: ' : '') + out).slice(0, MAX_TOOL_OUTPUT), done: true }]
          }
          case 'agent_settled': {
            // A turn is over only once pi has no automatic work left (retries, compaction, queued messages).
            const failed = e.aborted || last?.stopReason === 'error' || last?.stopReason === 'aborted'
            const ended: ParsedEvent = {
              kind: 'turn_end',
              ok: !failed,
              response: textOf(last?.content),
              error: failed ? last?.errorMessage || (e.aborted ? 'Aborted' : 'The model returned an error') : undefined
            }
            last = undefined
            return [ended]
          }
          case 'auto_retry_start':
            return [{ kind: 'info', text: `Retrying (attempt ${e.attempt}/${e.maxAttempts}): ${e.errorMessage ?? ''}` }]
          case 'compaction_start':
            return [{ kind: 'info', text: `Compacting the conversation (${e.reason})` }]
          case 'extension_error':
            return [{ kind: 'info', text: `Extension error (${e.extensionPath}): ${e.error}` }]
          case 'extension_ui_request':
            if (DIALOGS.has(e.method)) {
              return [
                { kind: 'reply', line: JSON.stringify({ type: 'extension_ui_response', id: e.id, cancelled: true }) },
                { kind: 'info', text: `An extension asked "${e.title ?? e.method}": cancelled (no one can answer in a headless session)` }
              ]
            }
            if (e.method === 'notify' && e.message) return [{ kind: 'info', text: String(e.message) }]
            return [] // setStatus, setWidget, setTitle…: display-only
          default:
            return []
        }
      }
    }
  }
}
