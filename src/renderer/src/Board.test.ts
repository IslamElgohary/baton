import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { createDb } from '../../main/db'
import type { BoardData, Task } from '../../shared/types'
import { BoardHeader, CardView, moveLocal, type Meta } from './Board'

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

test('BoardHeader renders finish mode options with exact labels and mode-neutral tooltips', () => {
  const data: BoardData = {
    board: {
      id: 1,
      name: 'Test Board',
      repo_path: '/repo/path',
      base_branch: 'main',
      finish_mode: 'publish'
    },
    columns: [],
    tasks: [],
    epics: []
  }
  const act = vi.fn().mockResolvedValue([])
  const html = renderToStaticMarkup(createElement(BoardHeader, { data, act }))

  // Mode-neutral tooltips
  expect(html).toContain('title="Branch tasks start from (and merge or target PRs into)"')
  expect(html).toContain('title="What happens when a task enters a finish column"')

  // Finish options and labels
  expect(html).toContain('<option value="pr">pull request (stacked for epics)</option>')
  expect(html).toContain('<option value="merge">local merge</option>')
  expect(html).toContain('<option value="publish" selected="">publish branch</option>')
  expect(html).toContain('<option value="notify">notify only</option>')
})

test('CardView renders finish status badges appropriately', () => {
  const baseTask: Task = {
    id: 1,
    board_id: 1,
    epic_id: null,
    column_id: 1,
    position: 0,
    title: 'Task title',
    description: '',
    branch: 'feat/test',
    worktree_path: null,
    status: 'idle',
    artifacts: 0,
    blocked_by: [],
    blocked: false,
    resolved: false,
    auto_start: 0,
    merged_at: null,
    merge_base: null,
    pr_url: null,
    published_at: null,
    finished_at: null,
    finish_error: null,
    archived_at: null,
    attention: null
  }
  const meta: Meta = new Map()

  // No badges rendered initially
  const noBadgesHtml = renderToStaticMarkup(createElement(CardView, { task: baseTask, meta }))
  expect(noBadgesHtml).not.toContain('merged')
  expect(noBadgesHtml).not.toContain('PR')
  expect(noBadgesHtml).not.toContain('published')
  expect(noBadgesHtml).not.toContain('finished')

  // Each badge rendered when field is set
  const mergedHtml = renderToStaticMarkup(createElement(CardView, { task: { ...baseTask, merged_at: '2026-01-01' }, meta }))
  expect(mergedHtml).toContain('merged')

  const prHtml = renderToStaticMarkup(createElement(CardView, { task: { ...baseTask, pr_url: 'https://github.com/pr/1' }, meta }))
  expect(prHtml).toContain('PR')

  const publishedHtml = renderToStaticMarkup(createElement(CardView, { task: { ...baseTask, published_at: '2026-01-01' }, meta }))
  expect(publishedHtml).toContain('published')

  const finishedHtml = renderToStaticMarkup(createElement(CardView, { task: { ...baseTask, finished_at: '2026-01-01' }, meta }))
  expect(finishedHtml).toContain('finished')
})
