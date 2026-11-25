import { spawn } from 'node:child_process'
import { expect, test } from 'vitest'
import type { PushEvent } from '../shared/types'
import { compactDraft, createBreakdowns, parseDraft } from './breakdown'
import { createDb } from './db'
import { fake } from '../../test/fake-harness'

test('parseDraft: sanitizes titles and keeps only earlier blockers; accepts fenced JSON', () => {
  expect(parseDraft('[{"title":" A "},{"title":"B","description":"d","blockedBy":[0,1,3,"x"]},{"title":""},{"nope":1}]'))
    .toEqual([{ title: 'A', description: '', blockedBy: [] }, { title: 'B', description: 'd', blockedBy: [0] }])
  expect(parseDraft('Here:\n```json\n[{"title":"A"}]\n```')).toEqual([{ title: 'A', description: '', blockedBy: [] }])
  expect(parseDraft('[]')).toBeNull()
  expect(parseDraft('{"title":"A"}')).toBeNull()
  expect(parseDraft('not json')).toBeNull()
})

test('a breakdown session stores the tasks.json artifact as the epic draft', async () => {
  const db = createDb(':memory:')
  db.saveSettings({ maxConcurrency: 3, idleTimeoutMin: 1, maxTurns: 3, binPaths: {} })
  const boardId = db.createBoard('b', process.cwd(), 'main', 'fake')
  const epic = db.createEpic(boardId, 'E', 'Build auth', '#000')
  const events: PushEvent[] = []
  const bd = createBreakdowns({ db, harnesses: [fake], resolveBin: () => process.execPath, spawn, push: (e) => events.push(e) })
  expect(() => bd.start(db.createEpic(boardId, 'empty', '', '#000'), 'fake', 'draft')).toThrow(/description/)
  bd.start(epic, 'fake', 'draft') // model = fake scenario
  expect(bd.get(epic).running).toBe(true)
  const end = Date.now() + 5000
  while (bd.get(epic).running && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  expect(bd.get(epic).error).toBeNull()
  expect(db.getEpic(epic)?.draft).toEqual([
    { title: 'Schema', description: 'db', blockedBy: [] }, { title: 'API', description: '', blockedBy: [0] }])
  expect(events.some((e) => e.type === 'breakdown' && e.event.kind === 'artifact')).toBe(true)
})

test('a breakdown that ends without a draft reports an error', async () => {
  const db = createDb(':memory:')
  db.saveSettings({ maxConcurrency: 3, idleTimeoutMin: 1, maxTurns: 3, binPaths: {} })
  const epic = db.createEpic(db.createBoard('b', process.cwd(), 'main', 'fake'), 'E', 'x', '#000')
  const bd = createBreakdowns({ db, harnesses: [fake], resolveBin: () => process.execPath, spawn, push: () => {} })
  bd.start(epic, 'fake', 'fail')
  const end = Date.now() + 5000
  while (bd.get(epic).running && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  expect(bd.get(epic).error).toMatch(/cannot/)
  expect(db.getEpic(epic)?.draft).toBeNull()
})

test('compactDraft keeps dependencies on the same tasks when blank rows are dropped', () => {
  const t = (title: string, blockedBy: number[] = []) => ({ title, description: '', blockedBy })
  expect(compactDraft([t('A'), t(''), t('C'), t('D'), t('E', [2, 3, 1])]).map((x) => [x.title, x.blockedBy]))
    .toEqual([['A', []], ['C', []], ['D', []], ['E', [1, 2]]])
  expect(parseDraft('[{"title":"A"},{"title":""},{"title":"C","blockedBy":[0]},{"title":"D","blockedBy":[2]}]')!.map((x) => x.blockedBy))
    .toEqual([[], [0], [1]])
})
