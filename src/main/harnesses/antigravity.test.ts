import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { antigravity } from './antigravity'
import type { ParsedEvent } from './types'

/** Feed a captured `agy --output-format stream-json` stream through the parser. */
function replay(fixture: string): ParsedEvent[] {
  const p = antigravity.parser()
  return readFileSync(join(__dirname, '../../../test/fixtures', fixture), 'utf8')
    .split('\n').filter(Boolean).flatMap((l) => p.line(l))
}

test('two-turn session: session id, tool calls with output, streamed text, one turn_end per turn', () => {
  const events = replay('antigravity-session.jsonl')
  expect(events[0]).toEqual({ kind: 'session', id: 'aa5d4040-20a5-498f-b311-18dfdf812375' })
  const ends = events.filter((e) => e.kind === 'turn_end')
  expect(ends).toHaveLength(2)
  expect(ends[1]).toMatchObject({ ok: true, response: '42\n' })
  const tool = events.find((e) => e.kind === 'tool' && e.done)
  expect(tool).toMatchObject({ name: 'run_command', input: { CommandLine: 'ls -la' } })
  expect((tool as { output: string }).output).toContain('Command exited with code 0')
  const text = events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('')
  expect(text).toContain('41')
})

test('tool start and finish share an id so the UI can merge them', () => {
  const tools = replay('antigravity-full.jsonl').filter((e) => e.kind === 'tool')
  expect(tools.map((t) => (t as { done: boolean }).done)).toEqual([false, true])
  expect(new Set(tools.map((t) => (t as { id: string }).id)).size).toBe(1)
})

test('sessionArgs: stream mode, read-only via deny settings, resume, model', () => {
  const ro = antigravity.sessionArgs({ model: '', permission: 'read' })
  expect(ro.slice(0, 5)).toEqual(['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json'])
  const settings = JSON.parse(ro[ro.indexOf('--settings') + 1])
  expect(settings.permissions.deny).toEqual(expect.arrayContaining(['command(*)', 'write_file(*)']))
  expect(ro).not.toContain('--dangerously-skip-permissions')
  const full = antigravity.sessionArgs({ model: 'm', permission: 'full', resume: 'abc' })
  expect(full).toEqual(expect.arrayContaining(['--model', 'm', '--conversation', 'abc', '--dangerously-skip-permissions']))
  expect(full).not.toContain('--settings')
})

test('encodeTurn is a stream-json user message', () => {
  expect(JSON.parse(antigravity.encodeTurn('hi'))).toEqual({ event: 'user', message: { role: 'user', content: 'hi' } })
})

test('probe parses `agy models`', async () => {
  const p = await antigravity.probe(async (args) => args[0] === 'models'
    ? { code: 0, stdout: 'Fetching available models...\ngemini-a\tGemini A\ngemini-b\tGemini B\n', stderr: '' }
    : { code: 0, stdout: '1.5.17\n', stderr: '' })
  expect(p).toMatchObject({ version: '1.5.17', loggedIn: true, models: ['gemini-a', 'gemini-b'] })
})

test('fails closed: an unexpected permission value gets the read-only rules', () => {
  const args = antigravity.sessionArgs({ model: '', permission: 'bogus' as never })
  expect(args).not.toContain('--dangerously-skip-permissions')
  expect(args).toContain('--settings')
})
