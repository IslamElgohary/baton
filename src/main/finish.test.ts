import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { FinishMode } from '../shared/types'
import { createDb } from './db'
import { createFinisher } from './finish'
import { createGit } from './git'
import { exec } from './proc'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd }).toString().trim()

/** A repo on main (with a bare "origin"), a board, and a fake `gh` that records calls. */
function setup(mode: FinishMode) {
  const root = mkdtempSync(join(tmpdir(), 'baton-finish-'))
  const repo = join(root, 'repo')
  const origin = join(root, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'a.txt'), 'base\n')
  sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'init')
  sh(repo, 'remote', 'add', 'origin', origin); sh(repo, 'push', '-q', 'origin', 'main')

  const db = createDb(':memory:')
  const boardId = db.createBoard('b', repo, 'main', 'h', mode)
  const [backlog] = db.getBoard(boardId).columns
  const git = createGit(exec)
  const gh: string[][] = []
  let active = new Set<number>()
  const prs = new Map<string, object>() // `gh pr view <key>` answers
  const finisher = createFinisher({
    db, git, push: () => {}, isActive: (id) => active.has(id), activeWaitMs: 300,
    gh: async (args) => {
      gh.push(args)
      if (args[0] === 'pr' && args[1] === 'view') {
        const pr = prs.get(args[2])
        return pr ? { code: 0, stdout: JSON.stringify(pr), stderr: '' } : { code: 1, stdout: '', stderr: 'no pull requests found' }
      }
      if (args[0] === 'pr' && args[1] === 'create') return { code: 0, stdout: `https://github.com/o/r/pull/${gh.length}\n`, stderr: '' }
      return { code: 1, stdout: '', stderr: 'unexpected' }
    }
  })
  /** A task that "ran": worktree on its own branch with one committed file (plus optional blockers merged in). */
  async function task(title: string, o: { epic?: number; blockers?: number[]; uncommitted?: boolean } = {}) {
    const id = db.createTask(boardId, backlog.id, title)
    if (o.epic) db.updateTask(id, { epic_id: o.epic })
    if (o.blockers) db.setBlockers(id, o.blockers)
    const branch = `baton/${id}-${title}`, wt = join(root, `wt-${id}`)
    await git.ensureWorktree(repo, 'main', branch, wt)
    for (const b of o.blockers ?? []) await git.merge(wt, db.getTask(b).branch!)
    writeFileSync(join(wt, `${title}.txt`), `${title}\n`)
    if (!o.uncommitted) await git.commitAll(wt, title)
    db.setTaskState(id, { branch, worktree_path: wt })
    for (const s of ['queued', 'running', 'succeeded'] as const) db.setStatus(id, s)
    return id
  }
  return { db, boardId, repo, origin, finisher, gh, prs, task, git, setActive: (s: Set<number>) => { active = s } }
}

test('merge mode: commits leftover work, merges into main, removes the worktree, keeps the branch', async () => {
  const { db, repo, finisher, task } = setup('merge')
  const id = await task('feat', { uncommitted: true })
  const wt = db.getTask(id).worktree_path!
  await finisher.finish(id)
  const t = db.getTask(id)
  expect(t.merged_at).not.toBeNull()
  expect(t.worktree_path).toBeNull()
  expect(existsSync(wt)).toBe(false)
  expect(readFileSync(join(repo, 'feat.txt'), 'utf8')).toBe('feat\n') // main checkout has it
  expect(sh(repo, 'branch', '--list', t.branch!)).toContain(t.branch!)
  expect(sh(repo, 'log', '-1', '--format=%s')).toBe('Merge task: feat')
})

test('merge mode: refuses a dirty main checkout and records why; nothing changes', async () => {
  const { db, repo, finisher, task } = setup('merge')
  const id = await task('feat')
  writeFileSync(join(repo, 'a.txt'), 'wip\n')
  await expect(finisher.finish(id)).rejects.toThrow(/uncommitted changes/)
  expect(db.getTask(id)).toMatchObject({ merged_at: null, finish_error: expect.stringMatching(/uncommitted/) })
  expect(existsSync(db.getTask(id).worktree_path!)).toBe(true)
})

test('refuses while an agent session is running', async () => {
  const { finisher, task, setActive } = setup('merge')
  const id = await task('feat')
  setActive(new Set([id]))
  await expect(finisher.finish(id)).rejects.toThrow(/still running/)
})

test('PR mode, standalone task: pushes the branch and opens a PR against main', async () => {
  const { db, origin, finisher, gh, task } = setup('pr')
  const id = await task('feat')
  await finisher.finish(id)
  const t = db.getTask(id)
  const create = gh.find((a) => a[1] === 'create')!
  expect(create.slice(0, 6)).toEqual(['pr', 'create', '--base', 'main', '--head', t.branch])
  expect(t.pr_url).toMatch(/^https:\/\/github.com\/o\/r\/pull\/\d+$/)
  expect(sh(origin, 'branch', '--list', t.branch!)).toContain(t.branch!) // pushed
})

test('PR mode, epic chain: the PR stacks on the blocker branch; once the blocker is merged it targets main', async () => {
  const { db, boardId, repo, origin, finisher, gh, task } = setup('pr')
  const epic = db.createEpic(boardId, 'E', 'd', '#000')
  const a = await task('a', { epic })
  const b = await task('b', { epic, blockers: [a] })
  await finisher.finish(b) // before its blocker
  const createB = gh.find((x) => x[1] === 'create' && x[5] === db.getTask(b).branch)!
  expect(createB[3]).toBe(db.getTask(a).branch) // --base = blocker branch
  expect(createB[createB.indexOf('--body') + 1]).toMatch(/Stacked on .*baton\/\d+-a/)
  expect(sh(origin, 'branch', '--list', db.getTask(a).branch!)).toContain('-a') // base pushed

  sh(repo, 'merge', '-q', '--no-ff', '-m', 'merge a', db.getTask(a).branch!) // a lands in main
  const c = await task('c', { epic, blockers: [a] })
  await finisher.finish(c)
  expect(gh.find((x) => x[1] === 'create' && x[5] === db.getTask(c).branch)![3]).toBe('main')
})

test('PR mode, epic diamond: stacks on one blocker and says the PR also contains the other', async () => {
  const { db, boardId, finisher, gh, task } = setup('pr')
  const epic = db.createEpic(boardId, 'E', 'd', '#000')
  const a = await task('a', { epic })
  const b = await task('b', { epic })
  const c = await task('c', { epic, blockers: [a, b] })
  await finisher.finish(c)
  const create = gh.find((x) => x[1] === 'create')!
  expect([db.getTask(a).branch, db.getTask(b).branch]).toContain(create[3])
  expect(create[create.indexOf('--body') + 1]).toMatch(/Also contains unmerged changes from/)
})

test('auto-finish skips a task that never ran, without an error', async () => {
  const { db, boardId, finisher } = setup('merge')
  const id = db.createTask(boardId, db.getBoard(boardId).columns[0].id, 'idle')
  await finisher.finish(id, { auto: true })
  expect(db.getTask(id).finish_error).toBeNull()
  await expect(finisher.finish(id)).rejects.toThrow(/no branch/) // a manual finish still explains
})

test('merge mode: two tasks finishing at once both merge (serialized per repo); merge_base is recorded', async () => {
  const { db, repo, finisher, task, git } = setup('merge')
  const a = await task('a'), b = await task('b')
  await Promise.all([finisher.finish(a), finisher.finish(b), finisher.finish(a)])
  expect(db.getTask(a).merged_at && db.getTask(b).merged_at).toBeTruthy()
  const t = db.getTask(a)
  expect(await git.diffRange(repo, t.merge_base!, t.branch!)).toContain('+a') // changes still viewable after merge
})

test('PR mode: a merged PR is not reused — new work gets a new PR', async () => {
  const { db, finisher, gh, prs, task } = setup('pr')
  const id = await task('feat')
  prs.set(db.getTask(id).branch!, { url: 'https://github.com/o/r/pull/1', state: 'MERGED' })
  await finisher.finish(id)
  expect(gh.some((a) => a[1] === 'create')).toBe(true)
  expect(db.getTask(id).pr_url).not.toBe('https://github.com/o/r/pull/1')
})

test('PR mode: a blocker whose PR was merged into its own parent stacks on that parent, not main', async () => {
  const { db, boardId, finisher, gh, prs, task } = setup('pr')
  const epic = db.createEpic(boardId, 'E', 'd', '#000')
  const a = await task('a', { epic })
  const b = await task('b', { epic, blockers: [a] })
  const c = await task('c', { epic, blockers: [b] })
  const aBranch = db.getTask(a).branch!
  db.setTaskState(b, { pr_url: 'https://github.com/o/r/pull/2' })
  prs.set('https://github.com/o/r/pull/2', { state: 'MERGED', baseRefName: aBranch }) // b merged into a's branch
  await finisher.finish(c)
  expect(gh.find((x) => x[1] === 'create')![3]).toBe(aBranch)
})

test('cleanup commits leftover work before removing the worktree', async () => {
  const { db, repo, finisher, task } = setup('merge')
  const id = await task('feat', { uncommitted: true })
  await finisher.cleanup(id)
  const t = db.getTask(id)
  expect(t.worktree_path).toBeNull()
  expect(sh(repo, 'show', `${t.branch}:feat.txt`)).toBe('feat')
})

test('auto-finish waits for a just-killed session to exit (card dragged into Done mid-run)', async () => {
  const { db, finisher, task, setActive } = setup('merge')
  const id = await task('feat')
  setActive(new Set([id]))
  setTimeout(() => setActive(new Set()), 100) // session exits shortly after the kill
  await finisher.finish(id, { auto: true })
  expect(db.getTask(id).merged_at).not.toBeNull()
})

test('cleanup with waitForStop waits for a just-killed session, then removes the worktree (deleting a task)', async () => {
  const { db, finisher, task, setActive } = setup('merge')
  const id = await task('feat', { uncommitted: true })
  const wt = db.getTask(id).worktree_path!
  setActive(new Set([id]))
  setTimeout(() => setActive(new Set()), 100)
  await expect(finisher.cleanup(id)).rejects.toThrow(/still running/)
  await finisher.cleanup(id, { waitForStop: true })
  expect(existsSync(wt)).toBe(false)
})
