import { expect, test } from 'vitest'
import { createDb } from '../../main/db'
import { moveLocal } from './Board'

test('moveLocal reorders exactly like the main process (no flicker when the refetch lands)', () => {
  const db = createDb(':memory:')
  const board = db.createBoard('b', '/r', 'main', 'h')
  const [a, b] = db.getBoard(board).columns
  for (const t of ['1', '2', '3']) db.createTask(board, a.id, t)
  for (const t of ['4', '5']) db.createTask(board, b.id, t)
  const ids = db.getBoard(board).tasks.map((t) => t.id)
  const pos = (tasks: { id: number; column_id: number; position: number }[]) =>
    tasks.map(({ id, column_id, position }) => ({ id, column_id, position })).sort((x, y) => x.id - y.id)

  // [task, column, index]: down and up within a column, to another column (middle, end), back to the top
  for (const [i, col, index] of [[0, a.id, 2], [2, a.id, 0], [1, b.id, 1], [4, a.id, 9], [3, a.id, 0]] as const) {
    const local = moveLocal(db.getBoard(board).tasks, ids[i], col, index)
    db.moveTask(ids[i], col, index)
    expect(pos(local)).toEqual(pos(db.getBoard(board).tasks))
  }
})

test('moveLocal skips archived cards like the main process does', () => {
  const db = createDb(':memory:')
  const board = db.createBoard('b', '/r', 'main', 'h')
  const cols = db.getBoard(board).columns
  const done = cols.find((c) => c.is_done)!
  for (const t of ['old1', 'old2']) db.createTask(board, done.id, t)
  db.archiveDone(done.id)
  for (const t of ['x', 'y', 'z']) db.createTask(board, cols[0].id, t)
  const ids = db.getBoard(board).tasks.filter((t) => !t.archived_at).map((t) => t.id)
  const pos = (tasks: { id: number; column_id: number; position: number; archived_at: string | null }[]) =>
    tasks.map(({ id, column_id, position, archived_at }) => ({ id, column_id, position, archived: !!archived_at })).sort((p, q) => p.id - q.id)
  for (const [i, index] of [[0, 0], [1, 0], [2, 1]] as const) {
    const local = moveLocal(db.getBoard(board).tasks, ids[i], done.id, index)
    db.moveTask(ids[i], done.id, index)
    expect(pos(local)).toEqual(pos(db.getBoard(board).tasks))
  }
})
