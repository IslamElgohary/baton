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

// Uses your Claude Code sign-in and CLAUDE_E2E_MODEL (default haiku). Costs a little model usage.
const model = process.env.CLAUDE_E2E_MODEL ?? 'haiku'

function setup() {
  const repo = mkdtempSync(join(tmpdir(), 'baton-e2e-claude-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# e2e\n')
  execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  const db = createDb(':memory:')
  const boardId = db.createBoard('e2e', repo, 'main', 'claude')
  const runner = createRunner({ db, harnesses, git: createGit(exec), spawn, resolveBin: () => which('claude'), worktreeRoot: mkdtempSync(join(tmpdir(), 'baton-e2e-claude-wt-')),
    push: (e) => { if (e.type === 'session' && e.event.kind === 'tool' && !e.event.done) process.stdout.write(`▶ ${e.event.name}\n`) } })
  const wait = async (cond: () => boolean) => { const end = Date.now() + 280_000; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 500)) }
  return { db, boardId, runner, wait }
}

test('claude: read-only Plan cannot write; full-auto Build writes; prev.summary flows between sessions', async () => {
  const { db, boardId, runner, wait } = setup()
  const [backlog, plan, build, review] = db.getBoard(boardId).columns
  db.updateColumn(plan.id, { trigger: { harness: 'claude', model, permission: 'read', onSuccess: build.id, onFailure: null,
    prompt: 'First try to create a file named plan-was-here.txt. It is expected to be impossible; that is fine and does not fail this step. Then reply with exactly one line: the first line of README.md.' } })
  db.updateColumn(build.id, { trigger: { harness: 'claude', model, permission: 'full', onSuccess: review.id, onFailure: null,
    prompt: 'Create a file named {{task.title}}.txt containing exactly this text: {{prev.summary}}' } })
  db.updateColumn(review.id, { trigger: null })
  const id = db.createTask(boardId, backlog.id, 'hello')
  db.moveTask(id, plan.id, 0); runner.onEnter(id)
  await wait(() => db.getTask(id).column_id === review.id || db.getTask(id).status === 'failed')
  const t = db.getTask(id)
  const runs = db.listRuns(id)
  process.stdout.write(`SESSIONS ${JSON.stringify(runs.map((r) => ({ ok: r.ok, session: r.session_id, summary: r.summary?.slice(0, 80) })))}\n`)
  expect(t.column_id).toBe(review.id)
  expect(runs.every((r) => r.session_id && r.ok === 1)).toBe(true)
  expect(existsSync(join(t.worktree_path!, 'plan-was-here.txt'))).toBe(false) // read-only held
  const planSummary = runs.find((r) => r.column_id === plan.id)!.summary!.trim()
  expect(readFileSync(join(t.worktree_path!, 'hello.txt'), 'utf8')).toContain(planSummary.split('\n')[0])
}, 300_000)

test('claude: asks a question, resumes the same session with the answer, saves an artifact', async () => {
  const { db, boardId, runner, wait } = setup()
  const [, plan] = db.getBoard(boardId).columns
  db.updateColumn(plan.id, { trigger: { harness: 'claude', model, permission: 'read', onSuccess: null, onFailure: null,
    prompt: 'Do not read any files. First ask the user which language the greeting should be in (English or French) — use the [QUESTION] marker and stop. After the answer, save an artifact named greeting.md containing a one-line greeting in that language, then finish.' } })
  const id = db.createTask(boardId, plan.id, 'greet')
  runner.onEnter(id)
  await wait(() => ['waiting', 'failed', 'succeeded'].includes(db.getTask(id).status))
  expect(db.getTask(id).status).toBe('waiting')
  const session = db.listRuns(id)[0].session_id
  process.stdout.write(`QUESTION: ${db.listRuns(id)[0].question}\n`)
  runner.answer(id, 'French')
  await wait(() => ['failed', 'succeeded'].includes(db.getTask(id).status))
  const [run] = db.listRuns(id)
  process.stdout.write(`RESULT: ok=${run.ok} summary=${run.summary}\nARTIFACTS: ${JSON.stringify(db.listArtifacts(id).map((a) => [a.name, a.content]))}\n`)
  expect(run.session_id).toBe(session)
  expect(run.ok).toBe(1)
  expect(db.listArtifacts(id).map((a) => a.name)).toContain('greeting.md')
}, 300_000)
