import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import { NOTIFY_KINDS, type Column, type DraftTask, type FinishMode, type HarnessInfo, type Settings, type Trigger } from '../shared/types'
import { compactDraft, type Breakdowns } from './breakdown'
import type { Finisher } from './finish'
import type { Db } from './db'
import type { Git } from './git'
import type { ExecResult, Harness } from './harnesses/types'
import type { Runner } from './runner'

export interface ApiDeps {
  db: Db
  runner: Runner
  breakdowns: Breakdowns
  finisher: Finisher
  git: Git
  harnesses: Harness[]
  exec: (bin: string, args: string[]) => Promise<ExecResult>
  resolveBin: (harnessId: string) => string | null
  pickDirectory: () => Promise<string | null>
  openPath: (path: string) => Promise<void>
  /** Open an http(s) URL in the browser. */
  openExternal: (url: string) => Promise<void>
  /** Run a command line in a visible terminal window. */
  openTerminal: (argv: string[]) => Promise<void>
}

/**
 * Everything the renderer can call. Each key becomes an IPC channel (see index.ts).
 * Methods starting with "list" or "get" are reads; every other call tells the renderer to refetch.
 */
export function createApi(d: ApiDeps) {
  let harnessCache: HarnessInfo[] | null = null
  const { resolveBin } = d

  /** Renderer input is untrusted: check the whole trigger, and only an explicit 'full' may run unrestricted. */
  const validTrigger = (t: Trigger | null) => {
    if (t === null) return t
    const route = (v: unknown) => v === null || Number.isInteger(v)
    if (typeof t !== 'object' || typeof t.prompt !== 'string' || typeof t.model !== 'string' || !route(t.onSuccess) || !route(t.onFailure)) {
      throw new Error('Invalid trigger')
    }
    if (t.permission !== 'read' && t.permission !== 'full') throw new Error(`Invalid permission "${String(t.permission)}"`)
    if (!d.harnesses.some((h) => h.id === t.harness)) throw new Error(`Unknown harness "${t.harness}"`)
    if (!t.prompt.trim()) throw new Error('Trigger prompt is empty')
    return t
  }

  return {
    // boards
    listBoards: () => d.db.listBoards(),
    getBoard: (id: number) => d.db.getBoard(id),
    async newBoard(): Promise<number | null> {
      const dir = await d.pickDirectory()
      if (!dir) return null
      const root = await d.git.root(dir)
      if (!root) throw new Error(`${dir} is not inside a git repository`)
      // PRs need a remote: default to them when there is one, local merges otherwise.
      const mode: FinishMode = (await d.git.hasRemote(root)) ? 'pr' : 'merge'
      return d.db.createBoard(basename(root), root, await d.git.defaultBranch(root), d.harnesses[0]?.id ?? '', mode)
    },
    listBranches: (id: number) => d.git.branches(d.db.getBoard(id).board.repo_path),
    renameBoard: (id: number, name: string) => d.db.renameBoard(id, name.trim() || 'Untitled'),
    async updateBaseBranch(id: number, branch: string) {
      const name = String(branch).trim()
      await d.git.assertBranch(d.db.getBoard(id).board.repo_path, name) // passed to git later: must be a real branch
      d.db.updateBoardBase(id, name)
    },
    setFinishMode(id: number, mode: FinishMode) {
      if (mode !== 'merge' && mode !== 'pr') throw new Error(`Unknown finish mode "${mode}"`)
      d.db.setFinishMode(id, mode)
    },
    /** Removes the board's worktree folders too (leftover work is committed; branches stay in the repo). */
    async deleteBoard(id: number) {
      const { tasks, epics } = d.db.getBoard(id)
      epics.forEach((e) => d.breakdowns.stop(e.id))
      tasks.forEach((t) => d.runner.forget(t.id))
      await Promise.all(tasks.map((t) => d.finisher.cleanup(t.id, { waitForStop: true }).catch(() => {})))
      d.db.deleteBoard(id)
    },

    // columns
    addColumn: (boardId: number, name: string) => d.db.addColumn(boardId, name.trim() || 'New column'),
    updateColumn(id: number, patch: Partial<Pick<Column, 'name' | 'is_done' | 'finish_on_enter' | 'trigger'>>) {
      if (patch.trigger !== undefined) validTrigger(patch.trigger)
      d.db.updateColumn(id, patch)
      d.runner.pump() // marking a column done can unblock tasks
    },
    deleteColumn: (id: number) => d.db.deleteColumn(id),
    moveColumn: (id: number, toIndex: number) => d.db.moveColumn(id, toIndex),

    // tasks
    createTask(boardId: number, columnId: number, title: string, description = '', epicId: number | null = null) {
      const epic = epicId ? d.db.getEpic(epicId) : undefined // ignore a stale/foreign epic rather than half-create the task
      const id = d.db.createTask(boardId, columnId, title.trim() || 'Untitled', description)
      if (epic?.board_id === boardId) d.db.updateTask(id, { epic_id: epic.id })
      d.runner.onEnter(id)
      return id
    },
    updateTask: (id: number, patch: { title?: string; description?: string; epic_id?: number | null }) => d.db.updateTask(id, patch),
    setBlockers(id: number, blockerIds: number[]) {
      d.db.setBlockers(id, blockerIds)
      d.runner.pump() // may have unblocked it
    },
    /** Removes the task's worktree too (leftover work is committed; the branch stays in the repo). */
    async deleteTask(id: number) {
      d.runner.forget(id)
      await d.finisher.cleanup(id, { waitForStop: true }).catch(() => {}) // a missing/broken worktree mustn't block deleting
      d.db.deleteTask(id)
      d.runner.pump() // its dependents may be unblocked now
    },
    moveTask(id: number, columnId: number, index: number) {
      const from = d.db.moveTask(id, columnId, index)
      if (from !== columnId) {
        d.db.setTaskState(id, { auto_start: 0 }) // you moved it yourself: no auto-start (a blocked card in a ⚡ column still waits there)
        d.runner.onEnter(id)
      }
    },
    retryTask: (id: number) => d.runner.retry(id),
    archiveDone: (columnId: number) => d.db.archiveDone(columnId),
    answerQuestion(id: number, text: string) {
      if (!text.trim()) throw new Error('Answer is empty')
      d.runner.answer(id, text.trim())
    },
    listArtifacts: (taskId: number) => d.db.listArtifacts(taskId),
    stopTask: (id: number) => d.runner.stop(id),
    listRuns: (taskId: number) => d.db.listRuns(taskId),
    getRunEvents: (runId: number) => d.db.runEvents(runId),
    finishTask: (id: number) => d.finisher.finish(id),
    removeWorktree: (id: number) => d.finisher.cleanup(id),
    /** The task's changes vs the base branch (from its worktree, or its branch once the worktree is gone). */
    async getChanges(id: number): Promise<string> {
      const t = d.db.getTask(id)
      const { board } = d.db.getBoard(t.board_id)
      if (t.worktree_path && existsSync(t.worktree_path)) return d.git.diff(t.worktree_path, board.base_branch)
      if (!t.branch) return '(no branch yet)'
      // After a local merge base...branch is empty: diff from where the branch left base instead.
      return t.merge_base ? d.git.diffRange(board.repo_path, t.merge_base, t.branch) : d.git.diffBranch(board.repo_path, board.base_branch, t.branch)
    },
    openPr(id: number) {
      const url = d.db.getTask(id).pr_url
      if (!url || !/^https:\/\//.test(url)) throw new Error('This task has no pull request')
      return d.openExternal(url)
    },
    openWorktree(taskId: number) {
      const p = d.db.getTask(taskId).worktree_path
      if (!p) throw new Error('This task has no worktree yet')
      return d.openPath(p)
    },

    // epics
    createEpic: (boardId: number, title: string, description = '', color = '#6366f1') =>
      d.db.createEpic(boardId, title.trim() || 'Untitled epic', description, color),
    updateEpic: (id: number, patch: { title?: string; description?: string; color?: string }) => d.db.updateEpic(id, patch),
    deleteEpic(id: number) {
      d.breakdowns.stop(id)
      d.db.deleteEpic(id)
    },
    getBreakdown: (epicId: number) => d.breakdowns.get(epicId),
    startBreakdown: (epicId: number, harness: string, model: string) => d.breakdowns.start(epicId, harness, model),
    startBrainstorm: (epicId: number, harness: string, model: string) => d.breakdowns.startBrainstorm(epicId, harness, model),
    answerBreakdown(epicId: number, text: string) {
      if (!text.trim()) throw new Error('Answer is empty')
      d.breakdowns.answer(epicId, text.trim())
    },
    stopBreakdown: (epicId: number) => d.breakdowns.stop(epicId),
    discardDraft: (epicId: number) => d.db.setEpicDraft(epicId, null),
    /** Create the (possibly edited) draft's tasks in the first column. */
    approveDraft(epicId: number, draft: DraftTask[]) {
      const clean = compactDraft(draft) // drops blank rows, keeping dependencies on the right tasks
      if (!clean.length) throw new Error('The draft has no tasks')
      const ids = d.db.createTasksFromDraft(epicId, clean)
      ids.forEach((id) => d.runner.onEnter(id))
      return ids
    },

    // settings & harnesses
    getSettings: () => d.db.getSettings(),
    saveSettings(s: Settings) {
      const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max
      if (!s || !int(s.maxConcurrency, 1, 16) || !int(s.idleTimeoutMin, 1, 1440) || !int(s.maxTurns, 1, 100)
        || typeof s.binPaths !== 'object' || s.binPaths === null || Object.values(s.binPaths).some((v) => typeof v !== 'string')
        || typeof s.notifications !== 'object' || s.notifications === null || NOTIFY_KINDS.some((k) => typeof s.notifications[k] !== 'boolean')) {
        throw new Error('Invalid settings')
      }
      const notifications = Object.fromEntries(NOTIFY_KINDS.map((k) => [k, s.notifications[k]])) as Settings['notifications']
      d.db.saveSettings({ maxConcurrency: s.maxConcurrency, idleTimeoutMin: s.idleTimeoutMin, maxTurns: s.maxTurns, binPaths: s.binPaths, notifications })
      harnessCache = null
    },
    async listHarnesses(refresh = false): Promise<HarnessInfo[]> {
      if (harnessCache && !refresh) return harnessCache
      harnessCache = await Promise.all(d.harnesses.map(async (h): Promise<HarnessInfo> => {
        const path = resolveBin(h.id)
        const base = { id: h.id, name: h.name, bin: h.bin, path }
        if (!path) return { ...base, version: null, loggedIn: false, authDetail: 'Not installed', models: [] }
        const p = await h.probe((args) => d.exec(path, args))
        return { ...base, version: p.version, loggedIn: p.loggedIn, authDetail: p.detail, models: p.models }
      }))
      return harnessCache
    },
    async loginHarness(id: string) {
      const h = d.harnesses.find((x) => x.id === id)
      const path = resolveBin(id)
      if (!h || !path) throw new Error('Harness is not installed')
      await d.openTerminal([path, ...h.loginArgs])
    }
  }
}

export type Api = ReturnType<typeof createApi>
