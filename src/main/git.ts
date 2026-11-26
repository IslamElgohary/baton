import { existsSync } from 'node:fs'
import type { ExecResult } from './harnesses/types'

type Exec = (bin: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<ExecResult>

/** Untranslated git messages: some results are read from its output ("Already up to date", "CONFLICT"…). */
const GIT_ENV = { ...process.env, LC_ALL: 'C' }

export function createGit(exec: Exec) {
  const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, ...args], { env: GIT_ENV })
  /** For commands that create commits: fall back to an app identity only when the user has none configured. */
  const withIdentity = async (cwd: string, ...args: string[]) => {
    const r = await git(cwd, ...args)
    if (r.code === 0 || !/tell me who you are|empty ident/i.test(r.stderr)) return r
    return git(cwd, '-c', 'user.name=Baton', '-c', 'user.email=baton@localhost', ...args)
  }

  return {
    /** Top-level dir of the repo containing `dir`, or null if it isn't a git repo. */
    async root(dir: string): Promise<string | null> {
      const r = await git(dir, 'rev-parse', '--show-toplevel')
      return r.code === 0 ? r.stdout.trim() : null
    },
    /** The remote's default branch (origin/HEAD) when it exists locally, else the checked-out one. */
    async defaultBranch(dir: string): Promise<string> {
      const r = await git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
      const name = r.code === 0 ? r.stdout.trim().replace(/^origin\//, '') : ''
      if (name && (await git(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`)).code === 0) return name
      const head = await git(dir, 'symbolic-ref', '--short', 'HEAD')
      return head.code === 0 ? head.stdout.trim() : 'main'
    },
    /** Local branch names, most recently committed first. */
    branches: async (repo: string) =>
      (await git(repo, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads')).stdout.split('\n').filter(Boolean),
    /** Changes in `dir` since it branched off `base`: committed + uncommitted, plus untracked file names. */
    async diff(dir: string, base: string): Promise<string> {
      const mb = (await git(dir, 'merge-base', base, 'HEAD')).stdout.trim() || base
      const d = (await git(dir, 'diff', mb)).stdout
      const untracked = (await git(dir, 'ls-files', '--others', '--exclude-standard')).stdout.trim()
      const out = d + (untracked ? `\nNew untracked files:\n${untracked}\n` : '')
      return out.length > 100_000 ? out.slice(0, 100_000) + '\n… (diff truncated)' : out || '(no changes)'
    },
    /** Changes on `branch` since it left `base` (for tasks whose worktree was removed). */
    diffBranch: async (repo: string, base: string, branch: string) =>
      (await git(repo, 'diff', `${base}...${branch}`)).stdout.slice(0, 100_000) || '(no changes)',
    isDirty: async (dir: string) => (await git(dir, 'status', '--porcelain')).stdout.trim() !== '',
    /** Commit everything in `dir` (used for a finished blocker's leftover uncommitted work). */
    async commitAll(dir: string, message: string): Promise<void> {
      await git(dir, 'add', '-A')
      const r = await withIdentity(dir, 'commit', '-m', message)
      if (r.code !== 0) throw new Error(`git commit failed: ${(r.stderr || r.stdout).trim()}`)
    },
    /**
     * Merge `branch` into the worktree at `dir`. On conflict the merge is left in progress (`conflicts` lists the
     * files); on any other failure it is aborted. `changed` is false when there was nothing to merge.
     */
    async merge(dir: string, branch: string): Promise<{ ok: boolean; changed: boolean; conflicts: string[]; error: string }> {
      const r = await withIdentity(dir, 'merge', '--no-ff', '--no-edit', branch)
      if (r.code === 0) return { ok: true, changed: !/Already up to date/i.test(r.stdout), conflicts: [], error: '' }
      const conflicts = (await git(dir, 'diff', '--name-only', '--diff-filter=U')).stdout.split('\n').filter(Boolean)
      if (!conflicts.length) await git(dir, 'merge', '--abort')
      return { ok: false, changed: false, conflicts, error: (r.stderr || r.stdout).trim().slice(0, 500) }
    },
    abortMerge: async (dir: string) => void (await git(dir, 'merge', '--abort')),
    /** `name`, or `name-2`, `name-3`… — the first that isn't an existing branch (never reuse someone else's work). */
    async freeBranch(repo: string, name: string): Promise<string> {
      let candidate = name
      for (let n = 2; (await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`)).code === 0; n++) candidate = `${name}-${n}`
      return candidate
    },
    /** Throws unless `name` is a valid, existing local branch (never an option-like value such as `--output=x`). */
    async assertBranch(repo: string, name: string): Promise<void> {
      if (!name || name.startsWith('-') || (await git(repo, 'check-ref-format', '--branch', name)).code !== 0) {
        throw new Error(`"${name}" is not a valid branch name`)
      }
      if ((await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`)).code !== 0) {
        throw new Error(`Branch "${name}" doesn't exist in ${repo}`)
      }
    },
    hasRemote: async (repo: string, remote = 'origin') => (await git(repo, 'remote', 'get-url', remote)).code === 0,
    /** False only when origin answered and lacks the branch (exit 2); a network/auth failure is left to the push. */
    remoteHasBranch: async (repo: string, branch: string) =>
      // Full ref: a bare name is tail-matched, so `main` would also match refs/heads/team/main.
      (await git(repo, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`)).code !== 2,
    mergeBase: async (repo: string, a: string, b: string) => (await git(repo, 'merge-base', a, b)).stdout.trim(),
    /** `git diff from to` (e.g. a merged task: from its recorded merge-base to its branch). */
    diffRange: async (repo: string, from: string, to: string) =>
      (await git(repo, 'diff', from, to)).stdout.slice(0, 100_000) || '(no changes)',
    /** Is `a` already contained in `b`? */
    isAncestor: async (repo: string, a: string, b: string) => (await git(repo, 'merge-base', '--is-ancestor', a, b)).code === 0,
    async push(repo: string, branch: string): Promise<void> {
      const r = await git(repo, 'push', '-u', 'origin', `${branch}:${branch}`)
      if (r.code !== 0) throw new Error(`git push failed: ${(r.stderr || r.stdout).trim()}`)
    },
    /**
     * Merge `branch` into `base` in the user's main checkout. Refuses unless that checkout is on `base` and clean,
     * so we never touch work in progress; a conflicting merge is aborted.
     */
    async mergeIntoBase(repo: string, base: string, branch: string, message: string): Promise<void> {
      const head = (await git(repo, 'symbolic-ref', '--short', 'HEAD')).stdout.trim()
      if (head !== base) throw new Error(`Your main checkout (${repo}) is on "${head || 'a detached HEAD'}", not "${base}". Switch it to ${base} and try again.`)
      const dirty = (await git(repo, 'status', '--porcelain', '--untracked-files=no')).stdout.trim()
      if (dirty) throw new Error(`Your main checkout (${repo}) has uncommitted changes. Commit or stash them and try again.`)
      const r = await withIdentity(repo, 'merge', '--no-ff', '-m', message, branch)
      if (r.code === 0) return
      await git(repo, 'merge', '--abort')
      throw new Error(`Merging ${branch} into ${base} failed${/CONFLICT/.test(r.stdout) ? ' with conflicts' : ''}; nothing was changed.\n${(r.stdout + r.stderr).trim().slice(0, 600)}`)
    },
    /** Delete a worktree folder (the branch is kept). */
    async removeWorktree(repo: string, dir: string): Promise<void> {
      const r = await git(repo, 'worktree', 'remove', '--force', dir)
      if (r.code !== 0 && existsSync(dir)) throw new Error(`git worktree remove failed: ${r.stderr.trim()}`)
      await git(repo, 'worktree', 'prune')
    },
    /** Create the worktree at `dir` on `branch` (from `base`) unless it already exists. */
    async ensureWorktree(repo: string, base: string, branch: string, dir: string): Promise<void> {
      if (existsSync(dir)) return
      const branchExists = (await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).code === 0
      const r = branchExists
        ? await git(repo, 'worktree', 'add', dir, branch)
        : await git(repo, 'worktree', 'add', '-b', branch, dir, base)
      if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`)
    }
  }
}

export type Git = ReturnType<typeof createGit>
