import type { Harness, ParsedEvent } from './types'

/**
 * Read-only = session settings that replace the user's global allow-list and deny
 * every shell command, file write and MCP tool. Denied calls are reported back to the
 * model, which keeps going with its file-reading tools. (Plain "needs approval" would
 * instead end the turn with no output in headless mode.)
 */
const READ_ONLY_SETTINGS = JSON.stringify({
  permissions: { allow: [], deny: ['command(*)', 'write_file(*)', 'mcp(*)'] }
})

const MAX_TOOL_OUTPUT = 20_000

/**
 * Antigravity CLI (`agy`) in stream mode: `--print= --input-format stream-json` keeps one
 * conversation open and runs a turn per stdin line. See test/fixtures/antigravity-session.jsonl.
 */
export const antigravity: Harness = {
  id: 'antigravity',
  name: 'Antigravity',
  bin: 'agy',
  loginArgs: [], // first interactive launch signs in

  async probe(run) {
    const [v, m] = await Promise.all([run(['--version']), run(['models'])])
    // `agy models` prints "id<TAB>name" per model; it only succeeds when signed in.
    const models = m.stdout.split('\n').filter((l) => l.includes('\t')).map((l) => l.split('\t')[0].trim())
    const loggedIn = m.code === 0 && models.length > 0
    return {
      version: v.code === 0 ? v.stdout.trim() : null,
      loggedIn,
      detail: loggedIn ? `${models.length} models` : (m.stderr || m.stdout).trim().slice(0, 300) || 'Not signed in',
      models
    }
  },

  sessionArgs({ model, permission, resume }) {
    return [
      '--print=', // stream mode: the prompt comes from stdin
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      ...(model ? ['--model', model] : []),
      ...(resume ? ['--conversation', resume] : []),
      // Fail closed: anything but an explicit 'full' gets the read-only rules.
      ...(permission === 'full' ? ['--dangerously-skip-permissions'] : ['--settings', READ_ONLY_SETTINGS])
    ]
  },

  encodeTurn: (text) => JSON.stringify({ event: 'user', message: { role: 'user', content: text } }),

  promptNote: (permission) => permission !== 'full'
    // Under these deny rules only read_file works: list_dir / find_by_name / grep_search are blocked too.
    ? '\n\n(Read-only session: shell commands, directory listing/search tools, file edits and MCP tools are blocked. Inspect the code with read_file — start from manifests and entry points and follow imports.)'
    : '',

  parser() {
    return {
      line(line): ParsedEvent[] {
        let e: any
        try { e = JSON.parse(line) } catch { return [{ kind: 'info', text: line }] }
        if (e.event === 'init') return e.conversation_id ? [{ kind: 'session', id: e.conversation_id }] : []
        if (e.event === 'result') {
          const r = e.result ?? {}
          return [{ kind: 'turn_end', ok: r.status === 'SUCCESS', response: r.response ?? '', error: r.error || undefined }]
        }
        const s = e.step_update
        if (!s) return []
        if (s.text_delta) return [{ kind: 'text', text: s.text_delta }]
        if (s.step_type === 'tool') {
          const output = s.tool_info?.output
          return [{
            kind: 'tool',
            id: `${s.conversation_id}:${s.step_index}`,
            name: s.tool_name,
            input: s.tool_info?.parameters,
            output: typeof output === 'string' ? output.slice(0, MAX_TOOL_OUTPUT) : undefined,
            done: s.state === 'DONE'
          }]
        }
        return []
      }
    }
  }
}
