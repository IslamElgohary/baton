import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { pi } from './pi'
import type { ParsedEvent } from './types'

/** Feed a captured `pi --mode rpc` stdout through the parser. */
function replay(fixture: string): ParsedEvent[] {
  const p = pi.parser()
  return readFileSync(join(__dirname, '../../../test/fixtures', fixture), 'utf8')
    .split('\n').filter(Boolean).flatMap((l) => p.line(l))
}
const ends = (events: ParsedEvent[]) => events.filter((e) => e.kind === 'turn_end') as Extract<ParsedEvent, { kind: 'turn_end' }>[]

test('read-only two-turn session: session id from get_state, one turn_end per agent_settled', () => {
  const events = replay('pi-session-read.jsonl')
  expect(events[0]).toEqual({ kind: 'session', id: '01a21428-d724-73f0-bf37-c986a6f53b7b' })
  const turns = ends(events)
  expect(turns).toHaveLength(2)
  expect(turns.every((t) => t.ok)).toBe(true)
  expect(turns[0].response).toContain('BLOCKED')
  expect(turns[1].response).toMatch(/x\.txt/)
  expect(events.some((e) => e.kind === 'thinking')).toBe(true) // pi streams its reasoning
})

test('full-auto session: tool start (args) and end (output) share the call id', () => {
  const events = replay('pi-session-full.jsonl')
  const tools = events.filter((e) => e.kind === 'tool') as Extract<ParsedEvent, { kind: 'tool' }>[]
  expect(tools.map((t) => [t.name, t.done])).toEqual([['write', false], ['write', true]])
  expect(tools[0].id).toBe(tools[1].id)
  expect(tools[0].input).toEqual({ content: 'hi', path: 'x.txt' })
  expect(tools[1].output).toBe('Successfully wrote to x.txt')
  expect(ends(events)).toEqual([{ kind: 'turn_end', ok: true, response: expect.stringContaining('DONE'), error: undefined }])
  // setStatus UI requests are display-only: no replies
  expect(events.some((e) => e.kind === 'reply')).toBe(false)
})

test('extension dialogs are cancelled (pi would block on them); notify becomes info', () => {
  const p = pi.parser()
  const out = p.line(JSON.stringify({ type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'Allow dangerous command?' }))
  expect(out[0]).toEqual({ kind: 'reply', line: JSON.stringify({ type: 'extension_ui_response', id: 'u1', cancelled: true }) })
  expect(out[1]).toMatchObject({ kind: 'info', text: expect.stringContaining('Allow dangerous command?') })
  expect(p.line(JSON.stringify({ type: 'extension_ui_request', id: 'u2', method: 'notify', message: 'hello' }))).toEqual([{ kind: 'info', text: 'hello' }])
})

test('errors: a model error or abort fails the turn; a rejected prompt fails immediately', () => {
  const p = pi.parser()
  p.line(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 unauthorized' } }))
  expect(p.line(JSON.stringify({ type: 'agent_settled', aborted: false }))).toEqual([{ kind: 'turn_end', ok: false, response: '', error: '401 unauthorized' }])
  expect(p.line(JSON.stringify({ type: 'agent_settled', aborted: true }))).toMatchObject([{ kind: 'turn_end', ok: false, error: 'Aborted' }])
  expect(p.line(JSON.stringify({ type: 'response', command: 'prompt', success: false, error: 'busy' }))).toEqual([{ kind: 'turn_end', ok: false, response: '', error: 'busy' }])
})

test('sessionArgs: rpc mode, read-only tool allowlist (fail closed), resume, model', () => {
  const ro = pi.sessionArgs({ model: '', permission: 'read' })
  expect(ro).toEqual(['--mode', 'rpc', '--tools', 'read,grep,find,ls', '--no-mcp', '--no-approve'])
  expect(pi.sessionArgs({ model: '', permission: 'bogus' as never })).toEqual(ro)
  expect(pi.sessionArgs({ model: 'litellm/x', permission: 'full', resume: 'abc' })).toEqual(['--mode', 'rpc', '--model', 'litellm/x', '--session', 'abc'])
  expect(JSON.parse(pi.encodeTurn('hi'))).toEqual({ type: 'prompt', message: 'hi' })
  expect(JSON.parse(pi.startup![0])).toMatchObject({ type: 'get_state' })
})

test('probe parses the `pi --list-models` table into provider/model ids', async () => {
  const table = 'provider    model                 context  max-out\nlitellm     moonshotai.kimi-k3    1M       128K\nopenrouter  qwen/qwen3-coder      256K     32K\n'
  const p = await pi.probe(async (args) => args[0] === '--list-models'
    ? { code: 0, stdout: table, stderr: '' }
    : { code: 0, stdout: '1.5.2\n', stderr: '' })
  expect(p).toMatchObject({ version: '1.5.2', loggedIn: true, models: ['litellm/moonshotai.kimi-k3', 'openrouter/qwen/qwen3-coder'] })
})
