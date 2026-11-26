import { existsSync } from 'node:fs'
import type { Board, PushEvent, Task } from '../shared/types'
import type { Db } from './db'
import type { Git } from './git'
import type { ExecResult } from './harnesses/types'

export interface FinisherDeps {
  db: Db
  git: Pick<Git, 'isDirty' | 'commitAll' | 'hasRemote' | 'remoteHasBranch' | 'isAncestor' | 'mergeBase' | 'push' | 'mergeIntoBase' | 'removeWorktree'>
  /** Runs the GitHub CLI (`gh`) in `cwd`. */
  gh: (args: string[], cwd: string) => Promise<ExecResult>
  /** True while an agent session is running for the task. */
  isActive: (taskId: number) => boolean
  push: (e: PushEvent) => void
  /** Shows a system notification (auto-finishes only: a finish the user started shows its result in the app). */
  notify?: (kind: 'finished', title: string, body: string) => void
  /** How long an auto-finish waits for a just-killed session to exit. */
  activeWaitMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Finishing a task: commit leftover work, then get it into the base branch per the board's finish mode —
 * a local `--no-ff` merge, or a pull request. Epic tasks in PR mode get *stacked* PRs: the PR targets the
 * branch holding its unmerged blockers' work. Afterwards the worktree is removed; the branch is kept.
 */
export function createFinisher(d: FinisherDeps) {
  const inflight = new Map<number, Promise<void>>() // taskId → running finish (a second call joins it)
  const repoLocks = new Map<string, Promise<unknown>>() // one finish at a time per repo (shared main checkout)
  const changed = () => d.push({ type: 'changed' })

  function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const next = (repoLocks.get(repo) ?? Promise.resolve()).catch(() => {}).then(fn)
    repoLocks.set(repo, next)
    return next
  }

  /**
   * Where a blocker's work lives, for stacking: null once it's in base; else its own branch — or, if its PR was
   * merged into another (stacked) branch, that branch.
   */
  async function blockerRef(b: Task, board: Board): Promise<string | null> {
    if (!b.branch || await d.git.isAncestor(board.repo_path, b.branch, board.base_branch)) return null
    if (b.pr_url) {
      const r = await d.gh(['pr', 'view', b.pr_url, '--json', 'state,baseRefName'], board.repo_path)
      const pr = r.code === 0 ? (JSON.parse(r.stdout) as { state: string; baseRefName: string }) : null
      if (pr?.state === 'MERGED') return pr.baseRefName === board.base_branch ? null : pr.baseRefName
    }
    return b.branch
  }

  /** PR base: the base branch, or (epic task with unmerged blockers) the branch to stack on. */
  async function prBase(t: Task, board: Board): Promise<{ base: string; parent?: Task; alsoIncludes: string[] }> {
    if (!t.epic_id) return { base: board.base_branch, alsoIncludes: [] }
    const refs = new Map<string, Task>() // branch → the blocker it came from
    for (const b of t.blocked_by.map((id) => d.db.getTask(id))) {
      const ref = await blockerRef(b, board)
      if (ref && ref !== board.base_branch) refs.set(ref, b)
    }
    const open = [...refs.keys()]
    if (!open.length) return { base: board.base_branch, alsoIncludes: [] }
    // Stack on the branch that already contains the others (a chain). For a diamond no single branch does:
    // take the last one and say so in the PR body.
    let parent = open[open.length - 1]
    for (const b of open) {
      let containsAll = true
      for (const o of open) if (o !== b && !(await d.git.isAncestor(board.repo_path, o, b))) containsAll = false
      if (containsAll) { parent = b; break }
    }
    const alsoIncludes: string[] = []
    for (const o of open) if (o !== parent && !(await d.git.isAncestor(board.repo_path, o, parent))) alsoIncludes.push(o)
    // A PR base must exist on the remote. Don't push over a remote copy (it may be ahead of ours).
    if (!(await d.git.remoteHasBranch(board.repo_path, parent))) await d.git.push(board.repo_path, parent)
    return { base: parent, parent: refs.get(parent), alsoIncludes }
  }

  function prBody(t: Task, base: string, stack: { parent?: Task; alsoIncludes: string[] }): string {
    const epic = t.epic_id ? d.db.getEpic(t.epic_id) : undefined
    const summary = d.db.lastSummary(t.id).trim()
    const artifacts = d.db.listArtifacts(t.id).map((a) => a.name)
    return [
      t.description.trim(),
      summary && `### Agent summary\n\n${summary}`,
      artifacts.length ? `Artifacts: ${artifacts.join(', ')}` : '',
      epic && `Part of epic **${epic.title}**.`,
      stack.parent && `Stacked on \`${base}\`${stack.parent.pr_url ? ` (${stack.parent.pr_url})` : ''} from "${stack.parent.title}" — merge that first.`,
      stack.alsoIncludes.length ? `Also contains unmerged changes from: ${stack.alsoIncludes.map((b) => `\`${b}\``).join(', ')}.` : '',
      '_Created by Baton._'
    ].filter(Boolean).join('\n\n')
  }

  /** Returns what happened, for the notification; null if there was nothing to finish. */
  async function run(taskId: number, auto: boolean): Promise<string | null> {
    // Auto-finish (card entered a finish column): a session killed by that move may still be exiting.
    for (let waited = 0; auto && d.isActive(taskId) && waited < (d.activeWaitMs ?? 15_000); waited += 200) await sleep(200)
    // Re-finishing is fine: new commits get merged again / pushed to the open PR.
    const t = d.db.getTask(taskId)
    if (!t.branch) {
      if (auto) return null // never ran: nothing to finish, not an error
      throw new Error('This task has no branch yet: it never ran an agent session, so there is nothing to finish.')
    }
    if (d.isActive(taskId)) throw new Error('An agent session is still running for this task. Stop it or let it finish first.')
    const { board } = d.db.getBoard(t.board_id)
    const worktree = t.worktree_path && existsSync(t.worktree_path) ? t.worktree_path : null
    if (worktree && await d.git.isDirty(worktree)) await d.git.commitAll(worktree, t.title)

    if (board.finish_mode === 'merge') {
      // Nothing new since the last merge: don't require a clean main checkout for a no-op.
      if (!(await d.git.isAncestor(board.repo_path, t.branch, board.base_branch))) {
        const mergeBase = await d.git.mergeBase(board.repo_path, board.base_branch, t.branch)
        await d.git.mergeIntoBase(board.repo_path, board.base_branch, t.branch, `Merge task: ${t.title}`)
        d.db.setTaskState(taskId, { merge_base: mergeBase || null })
      }
      d.db.setTaskState(taskId, { merged_at: new Date().toISOString() })
    } else {
      if (!(await d.git.hasRemote(board.repo_path))) {
        throw new Error('This repository has no "origin" remote, so a pull request cannot be opened. Switch the board to local merge, or add a remote.')
      }
      const stack = await prBase(t, board)
      if (stack.base === board.base_branch && !(await d.git.remoteHasBranch(board.repo_path, stack.base))) {
        throw new Error(`The board's base branch "${stack.base}" isn't on origin (merged and deleted?), so a pull request can't target it. Pick another base branch in the board header.`)
      }
      await d.git.push(board.repo_path, t.branch)
      // Only an OPEN PR is reused (the push above updated it); after a merged/closed one, new work gets a new PR.
      const existing = await d.gh(['pr', 'view', t.branch, '--json', 'url,state'], board.repo_path)
      const pr = existing.code === 0 ? (JSON.parse(existing.stdout) as { url: string; state: string }) : null
      let url = pr?.state === 'OPEN' ? pr.url : ''
      if (!url) {
        const r = await d.gh(['pr', 'create', '--base', stack.base, '--head', t.branch, '--title', t.title, '--body', prBody(t, stack.base, stack)], board.repo_path)
        if (r.code !== 0) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim()}`)
        url = r.stdout.trim().split('\n').pop() ?? ''
      }
      d.db.setTaskState(taskId, { pr_url: url })
    }

    // The branch stays (PRs and dependents need it). Keep the worktree if a new session grabbed it meanwhile.
    const now = d.db.getTask(taskId)
    if (worktree && !d.isActive(taskId) && now.status !== 'queued' && now.status !== 'running') {
      await d.git.removeWorktree(board.repo_path, worktree)
      d.db.setTaskState(taskId, { worktree_path: null })
    }
    return board.finish_mode === 'merge' ? `Merged into ${board.base_branch}` : `Pull request: ${d.db.getTask(taskId).pr_url}`
  }

  return {
    /**
     * Finish a task; throws with a readable reason (also stored on the task). `auto` = triggered by a finish
     * column: waits for a just-killed session and quietly skips tasks that never ran.
     */
    finish(taskId: number, { auto = false } = {}): Promise<void> {
      const running = inflight.get(taskId)
      if (running) return running
      const task = d.db.getTask(taskId)
      const repo = d.db.getBoard(task.board_id).board.repo_path
      const p = withRepoLock(repo, () => run(taskId, auto))
        .then((done) => {
          d.db.setTaskState(taskId, { finish_error: null })
          if (auto && done) {
            d.db.setTaskState(taskId, { attention: 'done' })
            d.notify?.('finished', `Finished: ${task.title}`, done)
          }
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e)
          d.db.setTaskState(taskId, { finish_error: msg })
          if (auto) {
            d.db.setTaskState(taskId, { attention: 'failed' })
            d.notify?.('finished', `Couldn't finish: ${task.title}`, msg)
          }
          throw new Error(msg)
        })
        .finally(() => { inflight.delete(taskId); changed() })
      inflight.set(taskId, p)
      return p
    },

    /**
     * Delete the task's worktree folder, committing leftover work to its branch first. Refused while a session
     * runs, unless `waitForStop` (deleting the task: its session was just killed and is exiting).
     */
    async cleanup(taskId: number, { waitForStop = false } = {}) {
      for (let waited = 0; waitForStop && d.isActive(taskId) && waited < (d.activeWaitMs ?? 15_000); waited += 200) await sleep(200)
      const t = d.db.getTask(taskId)
      if (d.isActive(taskId)) throw new Error('An agent session is still running for this task.')
      if (!t.worktree_path) return
      if (existsSync(t.worktree_path) && await d.git.isDirty(t.worktree_path)) {
        await d.git.commitAll(t.worktree_path, `${t.title} (uncommitted work saved before removing the worktree)`)
      }
      await d.git.removeWorktree(d.db.getBoard(t.board_id).board.repo_path, t.worktree_path)
      d.db.setTaskState(taskId, { worktree_path: null })
      changed()
    }
  }
}

export type Finisher = ReturnType<typeof createFinisher>
