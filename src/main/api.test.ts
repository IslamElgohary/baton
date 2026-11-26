import { expect, test } from 'vitest'
import { createApi } from './api'
import { createDb } from './db'
import { fake } from '../../test/fake-harness'

/** API with real DB and stubbed side effects: enough to test input validation. */
function setup() {
  const db = createDb(':memory:')
  const boardId = db.createBoard('b', '/repo', 'main', 'fake')
  const api = createApi({
    db, harnesses: [fake],
    runner: { pump: () => {}, onEnter: () => {} } as never,
    breakdowns: {} as never, finisher: {} as never,
    git: { assertBranch: async (_r: string, n: string) => { if (n !== 'main') throw new Error('bad') } } as never,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }), resolveBin: () => null,
    pickDirectory: async () => null, openPath: async () => {}, openExternal: async () => {}, openTerminal: async () => {}
  })
  return { db, api, col: db.getBoard(boardId).columns[1], boardId }
}

test('updateColumn rejects malformed triggers and unknown permissions (renderer input is untrusted)', () => {
  const { api, col } = setup()
  const t = { harness: 'fake', model: '', prompt: 'go', permission: 'read', onSuccess: null, onFailure: null }
  expect(() => api.updateColumn(col.id, { trigger: { ...t, permission: 'yolo' } as never })).toThrow(/Invalid permission/)
  expect(() => api.updateColumn(col.id, { trigger: { ...t, harness: 'nope' } as never })).toThrow(/Unknown harness/)
  expect(() => api.updateColumn(col.id, { trigger: { ...t, onSuccess: 'x' } as never })).toThrow(/Invalid trigger/)
  expect(() => api.updateColumn(col.id, { trigger: { ...t, prompt: 42 } as never })).toThrow(/Invalid trigger/)
  expect(() => api.updateColumn(col.id, { trigger: t as never })).not.toThrow()
})

test('updateBaseBranch refuses names that are not real branches', async () => {
  const { api, db, boardId } = setup()
  await expect(api.updateBaseBranch(boardId, '--output=/tmp/x')).rejects.toThrow()
  await api.updateBaseBranch(boardId, ' main ')
  expect(db.getBoard(boardId).board.base_branch).toBe('main')
})

test('createTask refuses a column from another board', () => {
  const { api, db, col } = setup()
  const other = db.createBoard('o', '/other', 'main', 'fake')
  expect(() => api.createTask(other, col.id, 't')).toThrow(/not on this board/)
  expect(db.getBoard(other).tasks).toEqual([])
})

test('deleteBoard stops the breakdown sessions of its epics', async () => {
  const { db, boardId } = setup()
  const epic = db.createEpic(boardId, 'e', 'd', '#000000')
  const stopped: number[] = []
  const api = createApi({
    db, harnesses: [fake],
    runner: { forget: () => {} } as never,
    breakdowns: { stop: (id: number) => stopped.push(id) } as never,
    finisher: { cleanup: async () => {} } as never,
    git: {} as never, exec: async () => ({ code: 0, stdout: '', stderr: '' }), resolveBin: () => null,
    pickDirectory: async () => null, openPath: async () => {}, openExternal: async () => {}, openTerminal: async () => {}
  })
  await api.deleteBoard(boardId)
  expect(stopped).toEqual([epic])
})

test('startBrainstorm and answerBreakdown delegate to the breakdown session', () => {
  const { db, boardId } = setup()
  const epic = db.createEpic(boardId, 'e', 'd', '#000000')
  const started: unknown[][] = []
  const answers: unknown[][] = []
  const api = createApi({
    db, harnesses: [fake],
    runner: { pump: () => {}, onEnter: () => {} } as never,
    breakdowns: {
      startBrainstorm: (...a: unknown[]) => started.push(a),
      answer: (...a: unknown[]) => answers.push(a)
    } as never,
    finisher: {} as never, git: {} as never,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }), resolveBin: () => null,
    pickDirectory: async () => null, openPath: async () => {}, openExternal: async () => {}, openTerminal: async () => {}
  })

  api.startBrainstorm(epic, 'fake', 'model-x')
  expect(started).toEqual([[epic, 'fake', 'model-x']])

  expect(() => api.answerBreakdown(epic, '')).toThrow(/Answer is empty/)
  expect(() => api.answerBreakdown(epic, '   ')).toThrow(/Answer is empty/)
  expect(answers).toEqual([])

  api.answerBreakdown(epic, '  use sqlite  ')
  expect(answers).toEqual([[epic, 'use sqlite']])
})

test('saveSettings rejects out-of-range or malformed values and drops unknown keys', () => {
  const { api, db } = setup()
  const notifications = { question: true, done: false, failed: true, finished: false }
  const ok = { maxConcurrency: 2, idleTimeoutMin: 5, maxTurns: 4, binPaths: { fake: '/bin/x' }, notifications }
  for (const bad of [{ ...ok, maxConcurrency: NaN }, { ...ok, maxConcurrency: 0 }, { ...ok, maxTurns: 1.5 }, { ...ok, binPaths: { fake: 1 } },
    { ...ok, notifications: null }, { ...ok, notifications: { ...notifications, done: 'no' } }, { ...ok, notifications: { question: true } }, null]) {
    expect(() => api.saveSettings(bad as never)).toThrow(/Invalid settings/)
  }
  api.saveSettings({ ...ok, extra: 'x', notifications: { ...notifications, extra: true } } as never)
  expect(db.getSettings()).toEqual(ok)
})

test('seenTask clears the attention mark', () => {
  const { db, api, col, boardId } = setup()
  const id = db.createTask(boardId, col.id, 't')
  db.setTaskState(id, { attention: 'failed' })
  api.seenTask(id)
  expect(db.getTask(id).attention).toBeNull()
})
