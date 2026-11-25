import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createGit } from './git'
import { exec } from './proc'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd }).toString()

/** Repo on main with a.txt, plus worktrees for a blocker and a dependent task. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'baton-git-'))
  sh(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'base\n')
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'init')
  return dir
}

test('merge: clean merge brings the blocker branch in; second merge is a no-op', async () => {
  const git = createGit(exec)
  const dir = repo()
  const blocker = join(dir, '..', `${dir.split('/').pop()}-b`), dep = join(dir, '..', `${dir.split('/').pop()}-d`)
  await git.ensureWorktree(dir, 'main', 'baton/1-b', blocker)
  await git.ensureWorktree(dir, 'main', 'baton/2-d', dep)
  writeFileSync(join(blocker, 'b.txt'), 'from blocker\n')
  expect(await git.isDirty(blocker)).toBe(true)
  await git.commitAll(blocker, 'leftover')
  expect(await git.isDirty(blocker)).toBe(false)
  expect(await git.merge(dep, 'baton/1-b')).toMatchObject({ ok: true, changed: true })
  expect(readFileSync(join(dep, 'b.txt'), 'utf8')).toBe('from blocker\n')
  expect(await git.merge(dep, 'baton/1-b')).toMatchObject({ ok: true, changed: false })
})

test('merge: a conflict is left in progress with the files listed; abortMerge cleans it up', async () => {
  const git = createGit(exec)
  const dir = repo()
  const blocker = join(dir, '..', `${dir.split('/').pop()}-b`), dep = join(dir, '..', `${dir.split('/').pop()}-d`)
  await git.ensureWorktree(dir, 'main', 'baton/1-b', blocker)
  await git.ensureWorktree(dir, 'main', 'baton/2-d', dep)
  writeFileSync(join(blocker, 'a.txt'), 'blocker\n'); await git.commitAll(blocker, 'b')
  writeFileSync(join(dep, 'a.txt'), 'dep\n'); await git.commitAll(dep, 'd')
  const r = await git.merge(dep, 'baton/1-b')
  expect(r).toMatchObject({ ok: false, conflicts: ['a.txt'] })
  await git.abortMerge(dep)
  expect(await git.isDirty(dep)).toBe(false)
  expect(readFileSync(join(dep, 'a.txt'), 'utf8')).toBe('dep\n')
})

test('assertBranch: existing branches pass; option-like, invalid and missing names are refused', async () => {
  const git = createGit(exec)
  const dir = repo()
  await expect(git.assertBranch(dir, 'main')).resolves.toBeUndefined()
  await expect(git.assertBranch(dir, '--output=/tmp/x')).rejects.toThrow(/not a valid branch/)
  await expect(git.assertBranch(dir, 'a..b')).rejects.toThrow(/not a valid branch/)
  await expect(git.assertBranch(dir, '')).rejects.toThrow(/not a valid branch/)
  await expect(git.assertBranch(dir, 'nope')).rejects.toThrow(/doesn't exist/)
})

test('freeBranch skips names that already exist', async () => {
  const git = createGit(exec)
  const dir = repo()
  expect(await git.freeBranch(dir, 'baton/1-x')).toBe('baton/1-x')
  sh(dir, 'branch', 'baton/1-x'); sh(dir, 'branch', 'baton/1-x-2')
  expect(await git.freeBranch(dir, 'baton/1-x')).toBe('baton/1-x-3')
})
