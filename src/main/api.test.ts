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

test('saveSettings rejects out-of-range or malformed values and drops unknown keys', () => {
  const { api, db } = setup()
  const ok = { maxConcurrency: 2, idleTimeoutMin: 5, maxTurns: 4, binPaths: { fake: '/bin/x' } }
  for (const bad of [{ ...ok, maxConcurrency: NaN }, { ...ok, maxConcurrency: 0 }, { ...ok, maxTurns: 1.5 }, { ...ok, binPaths: { fake: 1 } }, null]) {
    expect(() => api.saveSettings(bad as never)).toThrow(/Invalid settings/)
  }
  api.saveSettings({ ...ok, extra: 'x' } as never)
  expect(db.getSettings()).toEqual(ok)
})
