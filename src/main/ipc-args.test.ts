import { expect, test } from 'vitest'
import { checkArgs } from './ipc-args'

test('valid calls pass', () => {
  expect(() => checkArgs('listBoards', [])).not.toThrow()
  expect(() => checkArgs('moveTask', [3, 7, 0])).not.toThrow()
  expect(() => checkArgs('createTask', [1, 2, 'title'])).not.toThrow()
  expect(() => checkArgs('createTask', [1, 2, 'title', '', null])).not.toThrow()
  expect(() => checkArgs('updateColumn', [1, { name: 'x', is_done: 1, trigger: null }])).not.toThrow()
  expect(() => checkArgs('approveDraft', [1, [{ title: 'a', description: '', blockedBy: [] }, { title: 'b', description: 'd', blockedBy: [0] }]])).not.toThrow()
  expect(() => checkArgs('setFinishMode', [1, 'pr'])).not.toThrow()
})

test('malformed calls are rejected before reaching the method', () => {
  const bad: [string, unknown[]][] = [
    ['getBoard', ['1']], ['getBoard', [0]], ['getBoard', [1.5]], ['getBoard', []],
    ['moveTask', [3, 7, -1]], ['getBoard', [1, 'extra']],
    ['setFinishMode', [1, 'yolo']],
    ['updateColumn', [1, { name: 'x', evil: true }]], ['updateColumn', [1, { is_done: 2 }]], ['updateColumn', [1, null]],
    ['updateTask', [1, { epic_id: 'x' }]], ['updateTask', [1, { __proto__: 1, toString: 'x' }]],
    ['createEpic', [1, 'E', '', 'red']], ['setBlockers', [1, [2, 'x']]],
    ['approveDraft', [1, [{ title: 'a', description: '' }]]], ['approveDraft', [1, [{ title: 'a', description: '', blockedBy: [], x: 1 }]]],
    ['renameBoard', [1, 'x'.repeat(300_000)]]
  ]
  for (const [name, args] of bad) expect(() => checkArgs(name, args), `${name} ${JSON.stringify(args).slice(0, 60)}`).toThrow(/Invalid arguments/)
  expect(() => checkArgs('toString', [])).toThrow(/Unknown method/)
  expect(() => checkArgs('nope', [])).toThrow(/Unknown method/)
})
