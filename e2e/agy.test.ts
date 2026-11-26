import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createDb } from '../src/main/db'
import { createGit } from '../src/main/git'
import { harnesses } from '../src/main/harnesses'
import { exec, which } from '../src/main/proc'
import { createRunner } from '../src/main/runner'

test('agy: Plan (read-only) → Build (full-auto) in a real worktree', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'baton-e2e-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# e2e\n')
  execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  const db = createDb(':memory:')
  const boardId = db.createBoard('e2e', repo, 'main', 'antigravity')
  const [backlog, plan, build, review] = db.getBoard(boardId).columns
  const model = 'gemini-3.8-flash-medium'
  db.updateColumn(plan.id, { trigger: { harness: 'antigravity', model, permission: 'read', onSuccess: build.id, onFailure: null,
    prompt: 'Explore the project and output a short repo summary. Your final reply must start with the exact first line of README.md.' } })
  db.updateColumn(build.id, { trigger: { harness: 'antigravity', model, permission: 'full', onSuccess: review.id, onFailure: null,
    prompt: 'Create a file named {{task.title}}.txt containing exactly this text: {{prev.summary}}\nThen reply DONE.' } })
  db.updateColumn(review.id, { trigger: null })
  const root = mkdtempSync(join(tmpdir(), 'baton-e2e-wt-'))
  const runner = createRunner({ db, harnesses, git: createGit(exec), spawn, resolveBin: () => which('agy'), worktreeRoot: root,
    push: (e) => { if (e.type === 'session' && e.event.kind === 'tool' && !e.event.done) process.stdout.write(`▶ ${e.event.name}\n`) } })
  const id = db.createTask(boardId, backlog.id, 'hello')
  db.moveTask(id, plan.id, 0); runner.onEnter(id)
  const end = Date.now() + 280_000
  while (!(db.getTask(id).column_id === review.id || db.getTask(id).status === 'failed') && Date.now() < end) await new Promise((r) => setTimeout(r, 500))
  const t = db.getTask(id)
  const runs = db.listRuns(id)
  console.log('\nSESSIONS', JSON.stringify(runs.map((r) => ({ ok: r.ok, session: r.session_id, turns: db.runEvents(r.id).filter((e) => e.kind === 'user').length, tools: db.runEvents(r.id).filter((e) => e.kind === 'tool' && e.done).map((e) => (e as { name: string }).name), summary: r.summary?.slice(0, 200) })), null, 1))
  expect(runs.every((r) => r.session_id && r.ok === 1)).toBe(true)
  expect(t.column_id).toBe(review.id)
  const file = join(t.worktree_path!, 'hello.txt')
  expect(existsSync(file)).toBe(true)
  console.log('FILE', JSON.stringify(readFileSync(file, 'utf8')), 'BRANCH', execFileSync('git', ['-C', t.worktree_path!, 'branch', '--show-current']).toString().trim())
}, 300_000)

test('agy: asks a question, resumes the same session with the answer, saves an artifact', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'baton-e2e-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# e2e\n')
  execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  const db = createDb(':memory:')
  const boardId = db.createBoard('e2e', repo, 'main', 'antigravity')
  const [, plan] = db.getBoard(boardId).columns
  db.updateColumn(plan.id, { trigger: { harness: 'antigravity', model: 'gemini-3.8-flash-medium', permission: 'read', onSuccess: null, onFailure: null,
    prompt: 'Do not read any files. First ask the user which language the greeting should be in (English or French) — use the [QUESTION] marker and stop. After the answer, save an artifact named greeting.md containing a one-line greeting in that language, then finish.' } })
  const runner = createRunner({ db, harnesses, git: createGit(exec), spawn, resolveBin: () => which('agy'), worktreeRoot: mkdtempSync(join(tmpdir(), 'baton-e2e-wt-')), push: () => {} })
  const id = db.createTask(boardId, plan.id, 'greet')
  runner.onEnter(id)
  const wait = async (cond: () => boolean) => { const end = Date.now() + 200_000; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 500)) }
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
}, 420_000)
