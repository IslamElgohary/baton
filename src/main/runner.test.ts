import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { PushEvent, Trigger } from '../shared/types'
import { createDb } from './db'
import { fake } from '../../test/fake-harness'
import { createRunner, render, type RunnerDeps } from './runner'
import { CONTINUE_PROMPT, extractArtifacts, markerOf } from './session'

test('render fills known vars and blanks unknown ones', () => {
  expect(render('{{task.title}} on {{ branch }} {{nope}}!', { 'task.title': 'T', branch: 'b' })).toBe('T on b !')
})

test('markerOf reads [DONE] / [FAILED] / [QUESTION] at the end of a reply', () => {
  expect(markerOf('All good.\n[DONE]')).toEqual({ type: 'done', text: 'All good.' })
  expect(markerOf('All good. **[DONE]**\n')).toEqual({ type: 'done', text: 'All good.' })
  expect(markerOf('Tried.\n[FAILED] no access')).toEqual({ type: 'failed', text: 'Tried.\nno access' })
  expect(markerOf('Two options.\n[QUESTION]\nPostgres or SQLite?\nI recommend SQLite.'))
    .toEqual({ type: 'question', text: 'Postgres or SQLite?\nI recommend SQLite.' })
  expect(markerOf('I launched a subagent, will report back.')).toBeNull()
  expect(markerOf('[DONE] but then more text')).toBeNull()
  expect(markerOf('[QUESTION]')).toBeNull() // no question text
  // question written first, bare marker last (seen from kimi via pi)
  expect(markerOf('I need the order.\n\nPlease tell me: **newest first** or **oldest first**?\n\n**[QUESTION]**'))
    .toEqual({ type: 'question', text: 'I need the order.\n\nPlease tell me: **newest first** or **oldest first**?' })
})

test('extractArtifacts pulls named blocks and leaves stubs', () => {
  const r = extractArtifacts('Here.\n<artifact name="plan.md">\n# Plan\n1. a\n</artifact>\n<artifact name="../evil name">x</artifact>\n[DONE]')
  expect(r.artifacts).toEqual([{ name: 'plan.md', content: '# Plan\n1. a' }, { name: '..-evil-name', content: 'x' }])
  expect(r.rest).toBe('Here.\n[artifact: plan.md]\n[artifact: ..-evil-name]\n[DONE]')
})

test('render supports artifact names with dots and dashes', () => {
  expect(render('{{artifact.plan-v2.md}}', { 'artifact.plan-v2.md': 'P' })).toBe('P')
})

function setup(o: { maxConcurrency?: number; maxTurns?: number } = {}) {
  const db = createDb(':memory:')
  db.saveSettings({ maxConcurrency: o.maxConcurrency ?? 3, idleTimeoutMin: 1, maxTurns: o.maxTurns ?? 5, binPaths: {} })
  const boardId = db.createBoard('b', '/repo', 'main', 'fake')
  const [backlog, plan, build, review] = db.getBoard(boardId).columns
  db.updateColumn(review.id, { trigger: null })
  const events: PushEvent[] = []
  const root = mkdtempSync(join(tmpdir(), 'baton-runner-'))
  const merges: [string, string][] = [] // [worktree, branch]
  const deps: RunnerDeps = {
    db, harnesses: [fake], spawn,
    git: {
      ensureWorktree: async (_r, _b, _br, dir) => void mkdirSync(dir, { recursive: true }),
      freeBranch: async (_r, name) => name,
      diff: async () => 'DIFF',
      isDirty: async () => false,
      commitAll: async () => {},
      merge: async (dir, branch) => { merges.push([dir, branch]); return { ok: true, changed: true, conflicts: [], error: '' } },
      abortMerge: async () => {}
    },
    resolveBin: () => process.execPath,
    worktreeRoot: root,
    push: (e) => events.push(e)
  }
  const runner = createRunner(deps)
  const trigger = (model: string, prompt = 'go', onSuccess: number | null = null, onFailure: number | null = null): Trigger =>
    ({ harness: 'fake', model, permission: 'read', prompt, onSuccess, onFailure })
  return { db, boardId, backlog, plan, build, review, runner, events, trigger, merges, root, restart: () => createRunner(deps) }
}

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const userTurns = (db: ReturnType<typeof createDb>, taskId: number) =>
  db.listRuns(taskId)[0].events.filter((e) => e.kind === 'user').map((e) => (e as { text: string }).text)

test('[DONE] routes the card; next column gets a new session with prev.summary', async () => {
  const { db, boardId, backlog, plan, build, review, runner, trigger } = setup()
  db.updateColumn(plan.id, { trigger: trigger('echo', 'planned-{{task.title}}', build.id) })
  db.updateColumn(build.id, { trigger: trigger('echo', 'got:{{prev.summary}} {{diff}}', review.id) })
  const id = db.createTask(boardId, backlog.id, 'x')
  db.moveTask(id, plan.id, 0)
  runner.onEnter(id)
  await until(() => db.getTask(id).column_id === review.id && db.getTask(id).status === 'succeeded')
  const runs = db.listRuns(id)
  expect(runs.map((r) => [r.ok, r.summary])).toEqual([[1, 'got:planned-x DIFF'], [1, 'planned-x']])
  expect(new Set(runs.map((r) => r.session_id)).size).toBe(2)
  expect(db.getTask(id).branch).toBe(`baton/${id}-x`)
})

test('a turn without a marker gets a continue turn in the same session', async () => {
  const { db, boardId, plan, runner, trigger } = setup()
  db.updateColumn(plan.id, { trigger: trigger('continue') })
  const id = db.createTask(boardId, plan.id, 'x')
  runner.onEnter(id)
  await until(() => db.getTask(id).status === 'succeeded')
  expect(userTurns(db, id)[1]).toBe(CONTINUE_PROMPT)
  expect(db.listRuns(id)).toHaveLength(1)
})

test('gives up after maxTurns without a marker', async () => {
  const { db, boardId, plan, runner, trigger } = setup({ maxTurns: 3 })
  db.updateColumn(plan.id, { trigger: trigger('never') })
  const id = db.createTask(boardId, plan.id, 'x')
  runner.onEnter(id)
  await until(() => db.getTask(id).status === 'failed')
  expect(userTurns(db, id)).toHaveLength(3)
  expect(db.listRuns(id)[0].summary).toMatch(/Not finished after 3 turns/)
})

test('[FAILED] routes to onFailure; a turn error fails immediately', async () => {
  const { db, boardId, backlog, plan, build, runner, trigger } = setup()
  db.updateColumn(plan.id, { trigger: trigger('fail', 'go', null, backlog.id) })
  db.updateColumn(build.id, { trigger: trigger('error') })
  const a = db.createTask(boardId, plan.id, 'a')
  const b = db.createTask(boardId, build.id, 'b')
  runner.onEnter(a)
  runner.onEnter(b)
  await until(() => db.getTask(a).column_id === backlog.id && db.getTask(b).status === 'failed')
  expect(db.listRuns(a)[0]).toMatchObject({ ok: 0, summary: 'boom\ncannot' })
  expect(db.listRuns(b)[0]).toMatchObject({ ok: 0, summary: 'model not found' })
})

test('"Run again" continues the same session', async () => {
  const { db, boardId, plan, runner, trigger } = setup()
  db.updateColumn(plan.id, { trigger: trigger('echo', 'first') })
  const id = db.createTask(boardId, plan.id, 'x')
  runner.onEnter(id)
  await until(() => db.getTask(id).status === 'succeeded')
  const [run] = db.listRuns(id)
  runner.retry(id)
  await until(() => db.getTask(id).status === 'succeeded' && db.listRuns(id)[0].events.some((e) => e.kind === 'text'))
  const runs = db.listRuns(id)
  expect(runs).toHaveLength(1)
  expect(runs[0].id).toBe(run.id)
  expect(runs[0].events).toContainEqual({ kind: 'text', text: `resumed:${run.session_id}` })
})

test('concurrency limit queues extra tasks', async () => {
  const { db, boardId, plan, runner, trigger } = setup({ maxConcurrency: 1 })
  db.updateColumn(plan.id, { trigger: trigger('slow') })
  const a = db.createTask(boardId, plan.id, 'a')
  const b = db.createTask(boardId, plan.id, 'b')
  runner.onEnter(a)
  runner.onEnter(b)
  expect(db.getTask(a).status).toBe('running')
  expect(db.getTask(b).status).toBe('queued')
  await until(() => db.getTask(b).status === 'succeeded')
  expect(db.getTask(a).status).toBe('succeeded')
})

test('stop kills the session and keeps the card in its column', async () => {
  const { db, boardId, backlog, plan, runner, trigger } = setup()
  db.updateColumn(plan.id, { trigger: trigger('hang', 'go', null, backlog.id) })
  const id = db.createTask(boardId, plan.id, 'x')
  runner.onEnter(id)
  await until(() => db.listRuns(id)[0]?.session_id != null)
  runner.stop(id)
  await until(() => db.getTask(id).status === 'failed')
  expect(db.getTask(id).column_id).toBe(plan.id)
  expect(db.listRuns(id)[0].summary).toBe('Stopped by user')
})

test('a leftover process holding stdout does not keep the session open', async () => {
  const { db, boardId, plan, runner, trigger } = setup()
  db.updateColumn(plan.id, { trigger: trigger('helper') })
  const id = db.createTask(boardId, plan.id, 'x')
  runner.onEnter(id)
  const t0 = Date.now()
  await until(() => db.getTask(id).status === 'succeeded', 7000)
  expect(Date.now() - t0).toBeLessThan(6000)
}, 10_000)

test('[QUESTION] pauses the session; the answer resumes it and artifacts are saved', async () => {
  const { db, boardId, plan, build, runner, trigger, events } = setup({ maxConcurrency: 1 })
  db.updateColumn(plan.id, { trigger: trigger('ask', '{{artifact.choice.md}}', build.id) })
  db.updateColumn(build.id, { trigger: trigger('echo', 'saw {{artifact.choice.md}}') })
  const id = db.createTask(boardId, plan.id, 'x')
  runner.onEnter(id)
  await until(() => db.getTask(id).status === 'waiting')
  expect(runner.isActive(id)).toBe(false) // paused sessions don't hold a slot
  const [paused] = db.listRuns(id)
  expect(paused).toMatchObject({ question: 'Which color?', ended_at: null })
  expect(events.some((e) => e.type === 'session' && e.event.kind === 'question')).toBe(true)

  runner.answer(id, 'blue')
  await until(() => db.getTask(id).column_id === build.id && db.getTask(id).status === 'succeeded')
  const runs = db.listRuns(id)
  expect(runs[1]).toMatchObject({ id: paused.id, ok: 1, question: null }) // same session, resumed
  expect(runs[1].events).toContainEqual({ kind: 'user', text: 'blue' })
  expect(db.listArtifacts(id).map((a) => [a.name, a.content])).toEqual([['choice.md', 'color: blue']])
  expect(db.getTask(id).artifacts).toBe(1)
  expect(runs[0].summary).toBe('saw color: blue') // next step gets the artifact as a variable
})

test('the queue lives in the database: an answer queued at quit runs after a restart', async () => {
  const { db, boardId, plan, build, runner, trigger, restart } = setup({ maxConcurrency: 1 })
  db.updateColumn(plan.id, { trigger: trigger('ask') })
  db.updateColumn(build.id, { trigger: trigger('hang') })
  const id = db.createTask(boardId, plan.id, 'x')
  runner.onEnter(id)
  await until(() => db.getTask(id).status === 'waiting')
  const busy = db.createTask(boardId, build.id, 'busy')
  runner.onEnter(busy) // takes the only slot
  runner.answer(id, 'blue')
  expect(db.getTask(id).status).toBe('queued')

  runner.killAll() // quit: the freed slot must not start queued work
  await until(() => !runner.isActive(busy))
  expect(db.getTask(id).status).toBe('queued')

  db.recover()
  restart().pump()
  await until(() => db.getTask(id).status === 'succeeded')
  const [run] = db.listRuns(id)
  expect(run.events).toContainEqual({ kind: 'user', text: 'blue' }) // same session, resumed with the answer
  expect(db.listRuns(id)).toHaveLength(1)
})

test('moving a waiting card closes the paused session; stop on a waiting card fails it', async () => {
  const { db, boardId, backlog, plan, runner, trigger } = setup()
  db.updateColumn(plan.id, { trigger: trigger('ask') })
  const a = db.createTask(boardId, plan.id, 'a')
  const b = db.createTask(boardId, plan.id, 'b')
  runner.onEnter(a)
  runner.onEnter(b)
  await until(() => db.getTask(a).status === 'waiting' && db.getTask(b).status === 'waiting')
  db.moveTask(a, backlog.id, 0)
  runner.onEnter(a)
  expect(db.getTask(a).status).toBe('idle')
  expect(db.listRuns(a)[0]).toMatchObject({ ok: 0, question: null })
  runner.stop(b)
  expect(db.getTask(b).status).toBe('failed')
  expect(() => runner.answer(b, 'late')).toThrow(/not waiting/)
})

test('a blocked task stays queued until its blocker reaches a done column', async () => {
  const { db, boardId, backlog, plan, runner, trigger } = setup()
  db.updateColumn(plan.id, { trigger: trigger('echo') })
  const done = db.getBoard(boardId).columns.find((c) => c.is_done)!
  const blocker = db.createTask(boardId, backlog.id, 'blocker')
  const id = db.createTask(boardId, plan.id, 'x')
  db.setBlockers(id, [blocker])
  runner.onEnter(id)
  await new Promise((r) => setTimeout(r, 300))
  expect(db.getTask(id).status).toBe('queued')
  expect(db.listRuns(id)).toHaveLength(0)
  db.moveTask(blocker, done.id, 0)
  runner.onEnter(blocker) // reaching Done re-checks the queue
  await until(() => db.getTask(id).status === 'succeeded')
})

test('when a blocker succeeds, a parked dependent moves to the next ⚡ column, runs, and gets the blocker branch merged', async () => {
  const { db, boardId, backlog, plan, build, runner, trigger, merges } = setup()
  db.updateColumn(plan.id, { trigger: trigger('echo', 'plan', build.id) })
  db.updateColumn(build.id, { trigger: trigger('echo', 'build') })
  const blocker = db.createTask(boardId, plan.id, 'blocker')
  const dep = db.createTask(boardId, backlog.id, 'dep')
  db.setBlockers(dep, [blocker])
  runner.onEnter(blocker)
  // Plan succeeding routes the blocker into Build: not resolved yet, so dep must stay parked.
  await until(() => db.getTask(blocker).column_id === build.id)
  expect(db.getTask(dep).column_id).toBe(backlog.id)
  await until(() => db.getTask(dep).status === 'succeeded') // released when Build succeeded
  expect(db.getTask(dep).column_id).not.toBe(backlog.id)
  expect(merges.some(([dir, branch]) => dir.endsWith(`/${dep}`) && branch === db.getTask(blocker).branch)).toBe(true)

  // Dragging it back to Backlog later doesn't re-trigger it.
  db.moveTask(dep, backlog.id, 0)
  runner.onEnter(dep)
  await new Promise((r) => setTimeout(r, 200))
  expect(db.getTask(dep).column_id).toBe(backlog.id)
})

test('a card entering a finish column calls the finish hook (not for ⚡ columns)', async () => {
  const db = createDb(':memory:')
  const boardId = db.createBoard('b', '/repo', 'main', 'fake')
  const cols = db.getBoard(boardId).columns
  const done = cols.find((c) => c.is_done)!
  expect(done.finish_on_enter).toBe(1) // new boards finish in Done
  const finished: number[] = []
  const runner = createRunner({
    db, harnesses: [fake], spawn, resolveBin: () => null, worktreeRoot: tmpdir(), push: () => {},
    git: { ensureWorktree: async () => {}, freeBranch: async (_r, n) => n, diff: async () => '', isDirty: async () => false, commitAll: async () => {}, merge: async () => ({ ok: true, changed: false, conflicts: [], error: '' }), abortMerge: async () => {} },
    onFinishColumn: (id) => finished.push(id)
  })
  const id = db.createTask(boardId, cols[0].id, 'x')
  db.moveTask(id, done.id, 0)
  runner.onEnter(id)
  expect(finished).toEqual([id])
})

test('a dependent whose blocker resolved earlier (e.g. before a restart) is advanced on the next pump', async () => {
  const { db, boardId, backlog, plan, runner, trigger } = setup()
  db.updateColumn(plan.id, { trigger: trigger('echo') })
  const done = db.getBoard(boardId).columns.find((c) => c.is_done)!
  const blocker = db.createTask(boardId, done.id, 'blocker')
  db.setTaskState(blocker, { status: 'succeeded' }) // resolved long ago — no transition to react to
  const dep = db.createTask(boardId, backlog.id, 'dep')
  db.setBlockers(dep, [blocker])
  expect(db.getTask(dep).auto_start).toBe(1)
  runner.pump()
  await until(() => db.getTask(dep).status === 'succeeded')
  expect(db.getTask(dep).column_id).toBe(plan.id)
  expect(db.getTask(dep).auto_start).toBe(0)
})

test('quitting: SIGTERM first, then a forced kill stops an agent that ignores SIGTERM', async () => {
  const { db, boardId, plan, runner, trigger } = setup()
  db.updateColumn(plan.id, { trigger: trigger('stubborn') })
  const id = db.createTask(boardId, plan.id, 'x')
  runner.onEnter(id)
  await until(() => db.listRuns(id)[0]?.session_id != null)
  runner.killAll()
  await new Promise((r) => setTimeout(r, 400))
  expect(runner.activeCount()).toBe(1) // still alive: it ignored SIGTERM
  runner.killAll({ force: true })
  await until(() => runner.activeCount() === 0)
})

test("a task's first session never reuses a leftover worktree folder", async () => {
  const { db, boardId, plan, runner, trigger, root } = setup()
  db.updateColumn(plan.id, { trigger: trigger('echo') })
  const id = db.createTask(boardId, plan.id, 'x')
  mkdirSync(join(root, String(boardId), String(id)), { recursive: true }) // e.g. from an old database
  runner.onEnter(id)
  await until(() => db.getTask(id).status === 'succeeded')
  expect(db.getTask(id).worktree_path).toBe(join(root, String(boardId), `${id}-2`))
})
