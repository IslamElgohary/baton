import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createDb } from '../src/main/db'
import { createGit } from '../src/main/git'
import { harnesses } from '../src/main/harnesses'
import { exec, which } from '../src/main/proc'
import { createRunner } from '../src/main/runner'

// Uses your pi setup and its default model (or PI_E2E_MODEL). Costs a little model usage.
test('pi: read-only Plan cannot write; full-auto Build writes; prev.summary flows between sessions', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'baton-e2e-pi-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# e2e\n')
  execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  const db = createDb(':memory:')
  const boardId = db.createBoard('e2e', repo, 'main', 'pi')
  const [backlog, plan, build, review] = db.getBoard(boardId).columns
  const model = process.env.PI_E2E_MODEL ?? ''
  db.updateColumn(plan.id, { trigger: { harness: 'pi', model, permission: 'read', onSuccess: build.id, onFailure: null,
    prompt: 'First try to create a file named plan-was-here.txt (it should not be possible). Then reply with exactly one line: the first line of README.md.' } })
  db.updateColumn(build.id, { trigger: { harness: 'pi', model, permission: 'full', onSuccess: review.id, onFailure: null,
    prompt: 'Create a file named {{task.title}}.txt containing exactly this text: {{prev.summary}}' } })
  db.updateColumn(review.id, { trigger: null })
  const runner = createRunner({ db, harnesses, git: createGit(exec), spawn, resolveBin: () => which('pi'), worktreeRoot: mkdtempSync(join(tmpdir(), 'baton-e2e-pi-wt-')),
    push: (e) => { if (e.type === 'session' && e.event.kind === 'tool' && !e.event.done) process.stdout.write(`▶ ${e.event.name}\n`) } })
  const id = db.createTask(boardId, backlog.id, 'hello')
  db.moveTask(id, plan.id, 0); runner.onEnter(id)
  const end = Date.now() + 280_000
  while (!(db.getTask(id).column_id === review.id || db.getTask(id).status === 'failed') && Date.now() < end) await new Promise((r) => setTimeout(r, 500))
  const t = db.getTask(id)
  const runs = db.listRuns(id)
  process.stdout.write(`SESSIONS ${JSON.stringify(runs.map((r) => ({ ok: r.ok, session: r.session_id, summary: r.summary?.slice(0, 80) })))}\n`)
  expect(t.column_id).toBe(review.id)
  expect(runs.every((r) => r.session_id && r.ok === 1)).toBe(true)
  expect(existsSync(join(t.worktree_path!, 'plan-was-here.txt'))).toBe(false) // read-only held
  // Build's file carries Plan's result ({{prev.summary}}), whatever wording the model chose.
  const planSummary = runs.find((r) => r.column_id === plan.id)!.summary!.trim()
  expect(readFileSync(join(t.worktree_path!, 'hello.txt'), 'utf8')).toContain(planSummary.split('\n')[0])
}, 300_000)
