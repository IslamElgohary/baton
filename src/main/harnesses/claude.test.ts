import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { claude } from './claude'
import type { ParsedEvent } from './types'

/** Feed a captured `claude -p --output-format stream-json` stdout through the parser. */
function replay(fixture: string): ParsedEvent[] {
  const p = claude.parser()
  return readFileSync(join(__dirname, '../../../test/fixtures', fixture), 'utf8')
    .split('\n').filter(Boolean).flatMap((l) => p.line(l))
}
const ends = (events: ParsedEvent[]) => events.filter((e) => e.kind === 'turn_end') as Extract<ParsedEvent, { kind: 'turn_end' }>[]
const tools = (events: ParsedEvent[]) => events.filter((e) => e.kind === 'tool') as Extract<ParsedEvent, { kind: 'tool' }>[]

test('read-only two-turn session: one session event, streamed text, a blocked Bash call, one turn_end per result', () => {
  const events = replay('claude-read.jsonl')
  expect(events.filter((e) => e.kind === 'session')).toEqual([{ kind: 'session', id: 'a5e266b3-db7b-46eb-8017-344125e51538' }])
  const turns = ends(events)
  expect(turns).toHaveLength(2)
  expect(turns.every((t) => t.ok)).toBe(true)
  expect(turns[1].response).toBe('42')
  const text = events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('')
  expect(text).toContain(turns[0].response) // streamed deltas add up to the final reply
  const bash = tools(events).filter((t) => t.name === 'Bash')
  expect(bash.map((t) => t.done)).toEqual([false, true])
  expect(bash[1].output).toMatch(/^Error: .*No such tool available: Bash/)
  expect(events.some((e) => e.kind === 'thinking')).toBe(false) // empty thinking deltas are dropped
})

test('full-auto session: tool_use and tool_result share the id and name', () => {
  const t = tools(replay('claude-full.jsonl'))
  expect(t.map((x) => [x.name, x.done])).toEqual([['Write', false], ['Write', true], ['Bash', false], ['Bash', true]])
  expect(t[0].id).toBe(t[1].id)
  expect(t[0].input).toMatchObject({ file_path: '/work/repo/x.txt', content: 'hi' })
  expect(t[3].output).toBe('notes.txt\nx.txt')
})

test('an API error fails the turn with the CLI message', () => {
  expect(ends(replay('claude-err.jsonl'))).toEqual([{
    kind: 'turn_end', ok: false, response: expect.stringContaining('no-such-model'), error: expect.stringContaining('no-such-model')
  }])
})

test('tool_result content blocks and non-JSON lines', () => {
  const p = claude.parser()
  p.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }))
  expect(p.line(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }] } })))
    .toEqual([{ kind: 'tool', id: 't1', name: 'Read', output: 'ab', done: true }])
  expect(p.line('oops')).toEqual([{ kind: 'info', text: 'oops' }])
  expect(p.line(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }))).toEqual([{ kind: 'turn_end', ok: false, response: '', error: 'error_max_turns' }])
})

test('sessionArgs: stream-json both ways, read-only tool set without MCP (fail closed), resume, model', () => {
  const ro = claude.sessionArgs({ model: '', permission: 'read' })
  expect(ro.slice(0, 7)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'])
  expect(ro).toEqual(expect.arrayContaining(['--permission-prompts', 'none', '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--setting-sources', 'user']))
  expect(claude.sessionArgs({ model: '', permission: 'full' })).not.toContain('--setting-sources')
  expect(ro.join(' ')).not.toContain('bypassPermissions')
  expect(claude.sessionArgs({ model: '', permission: 'bogus' as never })).toEqual(ro)
  const full = claude.sessionArgs({ model: 'opus', permission: 'full', resume: 'abc' })
  expect(full).toEqual(expect.arrayContaining(['--model', 'opus', '--resume', 'abc', '--permission-mode', 'bypassPermissions']))
  expect(full).not.toContain('--tools')
  expect(claude.env).toEqual({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }) // a background subagent would end the turn early
  expect(JSON.parse(claude.encodeTurn('hi'))).toEqual({ type: 'user', message: { role: 'user', content: 'hi' } })
})

test('probe reads `claude auth status`', async () => {
  const run = (auth: string, code = 0) => claude.probe(async (args) => args[0] === 'auth'
    ? { code, stdout: auth, stderr: '' }
    : { code: 0, stdout: '2.1.325 (Claude Code)\n', stderr: '' })
  expect(await run(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'x@y' })))
    .toMatchObject({ version: '2.1.325 (Claude Code)', loggedIn: true, detail: 'Signed in (claude.ai)', models: expect.arrayContaining(['opus', 'sonnet']) })
  expect(await run(JSON.stringify({ loggedIn: false }), 1)).toMatchObject({ loggedIn: false, detail: expect.stringContaining('claude auth login') })
  expect(await run('not json', 1)).toMatchObject({ loggedIn: false })
})
