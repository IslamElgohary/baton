import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createDb } from './db'

const setup = () => {
  const db = createDb(':memory:')
  const id = db.createBoard('b', '/repo', 'main', 'antigravity')
  return { db, id, cols: db.getBoard(id).columns }
}
const order = (db: ReturnType<typeof createDb>, boardId: number, columnId: number) =>
  db.getBoard(boardId).tasks.filter((t) => t.column_id === columnId).sort((a, b) => a.position - b.position)
    .map((t) => [t.title, t.position])

test('new board gets the default columns', () => {
  const { cols } = setup()
  expect(cols.map((c) => c.name)).toEqual(['Backlog', 'Plan', 'Build', 'Review', 'Done'])
  expect(cols.map((c) => c.is_done)).toEqual([0, 0, 0, 0, 1])
  expect(cols[1].trigger).toMatchObject({ harness: 'antigravity', permission: 'read' })
  // pipeline is chained on success: Plan → Build → Review → Done
  expect(cols.slice(1, 4).map((c) => [c.trigger?.onSuccess, c.trigger?.onFailure])).toEqual([[cols[2].id, null], [cols[3].id, null], [cols[4].id, null]])
  expect(cols[2].trigger?.permission).toBe('full')
  expect(cols[0].trigger).toBeNull()
})

test('moveTask renumbers source and target without gaps', () => {
  const { db, id, cols } = setup()
  const [a, b, c] = ['a', 'b', 'c'].map((t) => db.createTask(id, cols[0].id, t))
  db.createTask(id, cols[1].id, 'x')
  expect(db.moveTask(b, cols[1].id, 0)).toBe(cols[0].id)
  expect(order(db, id, cols[0].id)).toEqual([['a', 0], ['c', 1]])
  expect(order(db, id, cols[1].id)).toEqual([['b', 0], ['x', 1]])
  db.moveTask(a, cols[0].id, 5) // same column, index past the end
  expect(order(db, id, cols[0].id)).toEqual([['c', 0], ['a', 1]])
  void c
})

test('moveTask refuses a column on another board', () => {
  const { db, id, cols } = setup()
  const other = db.createBoard('o', '/r2', 'main', 'antigravity')
  const t = db.createTask(id, cols[0].id, 't')
  expect(() => db.moveTask(t, db.getBoard(other).columns[0].id, 0)).toThrow()
})

test('deleting a non-empty column is refused; columns renumber', () => {
  const { db, id, cols } = setup()
  db.createTask(id, cols[0].id, 't')
  expect(() => db.deleteColumn(cols[0].id)).toThrow(/tasks/)
  db.deleteColumn(cols[1].id)
  expect(db.getBoard(id).columns.map((c) => [c.name, c.position]))
    .toEqual([['Backlog', 0], ['Build', 1], ['Review', 2], ['Done', 3]])
})

test('recover closes cut-off runs; the queue survives, first in first out', () => {
  const { db, id, cols } = setup()
  const t1 = db.createTask(id, cols[1].id, 'running')
  const t2 = db.createTask(id, cols[1].id, 'queued')
  const t3 = db.createTask(id, cols[1].id, 'answered')
  db.enqueue(t1, false)
  db.setStatus(t1, 'running')
  db.enqueue(t3, true, 'blue')
  db.enqueue(t2, false)
  const r = db.createRun({ task_id: t1, column_id: cols[1].id, harness: 'h', model: '' })
  db.recover()
  expect(db.getTask(t1).status).toBe('failed')
  expect(db.listRuns(t1)[0]).toMatchObject({ id: r, ok: 0 })
  expect(db.queued()).toEqual([{ taskId: t3, resume: true, message: 'blue' }, { taskId: t2, resume: false, message: undefined }])
  db.enqueue(t3, false) // re-queued: goes to the back, old answer dropped
  expect(db.queued()).toEqual([{ taskId: t2, resume: false, message: undefined }, { taskId: t3, resume: false, message: undefined }])
})

test('task status only changes along the allowed transitions', () => {
  const { db, id, cols } = setup()
  const t = db.createTask(id, cols[1].id, 't')
  expect(() => db.setStatus(t, 'running')).toThrow(/idle → running/) // must be queued first
  db.enqueue(t, false)
  db.setStatus(t, 'running')
  db.setStatus(t, 'waiting')
  expect(() => db.setStatus(t, 'succeeded')).toThrow(/waiting → succeeded/) // only an answer (queued) resumes it
  db.setStatus(t, 'failed')
  expect(() => db.setStatus(t, 'idle')).toThrow()
  db.enqueue(t, true) // "Run again"
  expect(db.getTask(t).status).toBe('queued')
})

test('ids of deleted tasks are not reused (worktree paths are derived from them)', () => {
  const { db, id, cols } = setup()
  const a = db.createTask(id, cols[0].id, 'a')
  db.deleteTask(a)
  expect(db.createTask(id, cols[0].id, 'b')).not.toBe(a)
})

test('session events round-trip; reopen clears the result', () => {
  const { db, id, cols } = setup()
  const t = db.createTask(id, cols[1].id, 't')
  const r = db.createRun({ task_id: t, column_id: cols[1].id, harness: 'h', model: 'm' })
  db.setRunSession(r, 'abc')
  db.appendEvent(r, { kind: 'user', text: 'hi\nthere' })
  db.appendEvent(r, { kind: 'tool', id: '1', name: 'read_file', input: { Path: '/x' }, done: true })
  db.finishRun(r, true, 'ok')
  expect(db.lastRun(t, cols[1].id)).toMatchObject({ session_id: 'abc', ok: 1, events: [{ kind: 'user', text: 'hi\nthere' }, { kind: 'tool', name: 'read_file' }] })
  db.reopenRun(r)
  expect(db.listRuns(t)[0]).toMatchObject({ ended_at: null, ok: null, summary: null })
})

test('epics: tasks join an epic; deleting the epic keeps its tasks', () => {
  const { db, id, cols } = setup()
  const e = db.createEpic(id, 'Auth', 'Login & signup', '#ff0000')
  const t = db.createTask(id, cols[0].id, 't')
  db.updateTask(t, { epic_id: e })
  expect(db.getBoard(id).epics).toMatchObject([{ id: e, title: 'Auth', draft: null }])
  expect(db.getTask(t).epic_id).toBe(e)
  const other = db.createBoard('o', '/r2', 'main', 'h')
  expect(() => db.updateTask(t, { epic_id: db.createEpic(other, 'x', '', '#000') })).toThrow(/board/)
  db.deleteEpic(e)
  expect(db.getTask(t).epic_id).toBeNull()
})

test('blockers: self, other board and cycles are refused; isBlocked follows done columns', () => {
  const { db, id, cols } = setup()
  const [a, b, c] = ['a', 'b', 'c'].map((x) => db.createTask(id, cols[0].id, x))
  db.setBlockers(b, [a])
  db.setBlockers(c, [b])
  expect(() => db.setBlockers(a, [c])).toThrow(/depends on this task/) // a ← b ← c ← a
  expect(() => db.setBlockers(a, [a])).toThrow(/itself/)
  const other = db.createBoard('o', '/r2', 'main', 'h')
  expect(() => db.setBlockers(a, [db.createTask(other, db.getBoard(other).columns[0].id, 'x')])).toThrow(/another board/)
  expect(db.getTask(c).blocked_by).toEqual([b])
  expect(db.isBlocked(b)).toBe(true)
  db.moveTask(a, cols[4].id, 0) // Done
  expect(db.isBlocked(b)).toBe(false)
  db.deleteTask(b)
  expect(db.getTask(c).blocked_by).toEqual([]) // deps cascade
})

test('createTasksFromDraft: first column, in order, only backward dependencies, clears the draft', () => {
  const { db, id, cols } = setup()
  const e = db.createEpic(id, 'E', 'd', '#000')
  db.setEpicDraft(e, [{ title: 'x', description: '', blockedBy: [] }])
  const ids = db.createTasksFromDraft(e, [
    { title: 'one', description: 'd1', blockedBy: [] },
    { title: 'two', description: '', blockedBy: [0, 1, 7] }, // self and out-of-range ignored
    { title: 'three', description: '', blockedBy: [0, 1] }
  ])
  const tasks = ids.map((t) => db.getTask(t))
  expect(tasks.map((t) => [t.title, t.column_id, t.epic_id, t.position])).toEqual([
    ['one', cols[0].id, e, 0], ['two', cols[0].id, e, 1], ['three', cols[0].id, e, 2]])
  expect(tasks.map((t) => t.blocked_by.sort())).toEqual([[], [ids[0]], [ids[0], ids[1]].sort()])
  expect(db.getEpic(e)?.draft).toBeNull()
})

test('deleting a column resets routes that pointed at it to "stay"', () => {
  const { db, id, cols } = setup()
  const [, plan, build, review, done] = cols
  db.updateColumn(build.id, { trigger: { ...build.trigger!, onSuccess: review.id, onFailure: done.id } })
  db.deleteColumn(review.id)
  const after = db.getColumn(build.id)!.trigger!
  expect([after.onSuccess, after.onFailure]).toEqual([null, done.id])
  expect(db.getColumn(plan.id)!.trigger!.onSuccess).toBe(build.id)
})

test('upgrade backfills auto_start for tasks that already have blockers', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'baton-db-')), 'x.db')
  let db = createDb(file)
  const id = db.createBoard('b', '/r', 'main', 'h')
  const [backlog] = db.getBoard(id).columns
  const a = db.createTask(id, backlog.id, 'a'), b = db.createTask(id, backlog.id, 'b')
  db.setBlockers(b, [a])
  db.close()
  const raw = new DatabaseSync(file) // simulate a DB from before the column existed (and before versioning)
  raw.exec('ALTER TABLE tasks DROP COLUMN auto_start; PRAGMA user_version = 0')
  raw.close()
  db = createDb(file)
  expect([db.getTask(a).auto_start, db.getTask(b).auto_start]).toEqual([0, 1])
})

test('upgrade moves session events from the old text blob into run_events', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'baton-db-')), 'x.db')
  let db = createDb(file)
  const id = db.createBoard('b', '/r', 'main', 'h')
  const col = db.getBoard(id).columns[1]
  const run = db.createRun({ task_id: db.createTask(id, col.id, 't'), column_id: col.id, harness: 'h', model: '' })
  db.close()
  const raw = new DatabaseSync(file) // a pre-versioning DB: events stored as JSONL text on runs
  raw.exec(`DROP TABLE run_events; ALTER TABLE runs ADD COLUMN events TEXT NOT NULL DEFAULT ''; PRAGMA user_version = 0`)
  raw.prepare('UPDATE runs SET events = ? WHERE id = ?').run('{"kind":"user","text":"a\\nb"}\n{"kind":"info","text":"x"}\n', run)
  raw.close()
  db = createDb(file)
  expect(db.listRuns(1)[0].events).toEqual([{ kind: 'user', text: 'a\nb' }, { kind: 'info', text: 'x' }])
  db.appendEvent(run, { kind: 'info', text: 'y' })
  expect(db.listRuns(1)[0].events.at(-1)).toEqual({ kind: 'info', text: 'y' })
})
