import { expect, test } from 'vitest'
import { fold } from './Transcript'

test('fold merges streamed text and thinking, and updates a tool call in place', () => {
  expect(fold([
    { kind: 'user', text: 'go' },
    { kind: 'thinking', text: 'hm' }, { kind: 'thinking', text: 'm' },
    { kind: 'text', text: 'Hel' }, { kind: 'text', text: 'lo' },
    { kind: 'tool', id: 't1', name: 'read', input: { path: 'a' }, done: false },
    { kind: 'text', text: 'after' },
    { kind: 'tool', id: 't1', name: 'read', output: 'A', done: true },
    { kind: 'turn_end', ok: true, response: '' }
  ])).toEqual([
    { type: 'user', text: 'go' },
    { type: 'thinking', text: 'hmm' },
    { type: 'assistant', text: 'Hello' },
    expect.objectContaining({ type: 'tool', id: 't1', name: 'read', input: { path: 'a' }, output: 'A', done: true }),
    { type: 'assistant', text: 'after' },
    { type: 'turn', ok: true, error: undefined }
  ])
})
