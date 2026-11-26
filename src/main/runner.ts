import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PushEvent, SessionEvent } from '../shared/types'
import type { Db } from './db'
import type { Git } from './git'
import type { Harness } from './harnesses/types'
import { protocol, startSession, type Marker, type Spawn } from './session'

export interface RunnerDeps {
  db: Db
  harnesses: Harness[]
  git: Pick<Git, 'ensureWorktree' | 'freeBranch' | 'diff' | 'merge' | 'abortMerge' | 'isDirty' | 'commitAll'>
  spawn: Spawn
  /** Absolute path of a harness binary, or null if not installed. */
  resolveBin: (harnessId: string) => string | null
  worktreeRoot: string
  push: (e: PushEvent) => void
  /** Desktop notification (e.g. the agent asked a question). */
  notify?: (title: string, body: string) => void
  /** A card entered a column with a finish action (merge / PR). */
  onFinishColumn?: (taskId: number) => void
}

/** Fills `{{a.b}}` placeholders; unknown ones become ''. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k: string) => vars[k] ?? '')
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'

interface Active {
  /** Kills the session process; null until it has started. */
  stop: ((reason: string) => void) | null
  forceStop: (() => void) | null
  runId: number
  columnId: number
  /** Set when we kill the session; becomes the failure summary unless the agent already finished. */
  killReason: string | null
  /** False when the user moved/deleted the card mid-session: don't touch it afterwards. */
  route: boolean
  /** False after Stop: set the status but keep the card in its column. */
  move: boolean
}

export function createRunner(d: RunnerDeps) {
  type Queued = ReturnType<Db['queued']>[number] // the queue is the tasks table (status 'queued')
  const active = new Map<number, Active>() // taskId → session

  const changed = () => d.push({ type: 'changed' })

  function kill(taskId: number, reason: string, route: boolean) {
    const a = active.get(taskId)
    if (!a) return
    a.killReason ??= reason
    a.route = route
    a.stop?.(reason)
  }

  let closing = false // app quitting: start nothing new; queued tasks stay queued for the next launch

  function enter(taskId: number, resume: boolean) {
    kill(taskId, 'Card moved while running', false)
    const task = d.db.getTask(taskId)
    if (!resume) d.db.closeOpenRuns(taskId, 'Card moved before the question was answered')
    const col = d.db.getColumn(task.column_id)
    if (col?.trigger) d.db.enqueue(taskId, resume)
    else if (['queued', 'running', 'waiting'].includes(task.status)) d.db.setStatus(taskId, 'idle')
    changed()
    if (col?.finish_on_enter && !col.trigger) d.onFinishColumn?.(taskId)
    pump() // also advances/starts dependents this card may have just unblocked
  }

  let advancing = false
  /**
   * Move auto-start tasks whose blockers have all resolved (session succeeded, or in a done column) from their
   * parked column to the next ⚡ column, which starts them. Checked on every queue pump, so it also catches
   * blockers that resolved earlier (e.g. before a restart).
   */
  function advanceReady() {
    if (advancing) return
    advancing = true
    try {
      for (const id of d.db.readyToAdvance()) {
        const t = d.db.getTask(id)
        const next = d.db.nextTriggerColumn(t.board_id, d.db.getColumn(t.column_id)!.position)
        d.db.setTaskState(id, { auto_start: 0 }) // once; dragging it back later leaves it alone
        if (!next) continue
        d.db.moveTask(id, next.id, Number.MAX_SAFE_INTEGER)
        enter(id, false)
      }
    } finally {
      advancing = false
    }
  }

  function pump() {
    if (closing) return
    advanceReady()
    const max = Math.max(1, d.db.getSettings().maxConcurrency)
    while (active.size < max) {
      // Skip tasks whose previous session is still shutting down, and tasks whose blockers aren't done.
      const q = d.db.queued().find((q) => !active.has(q.taskId) && !d.db.isBlocked(q.taskId))
      if (!q) break
      d.db.setStatus(q.taskId, 'running') // off the queue now, even if start() throws early
      start(q).catch((e) => console.error('session start failed', e))
    }
  }

  async function start({ taskId, resume, message }: Queued) {
    const task = d.db.getTask(taskId)
    const col = d.db.getColumn(task.column_id)
    const trigger = col?.trigger
    if (!col || !trigger) { // trigger removed while queued
      d.db.setStatus(taskId, 'idle')
      return changed()
    }
    const { board } = d.db.getBoard(task.board_id)
    const settings = d.db.getSettings()

    // A new column = a new session. Answers and "Run again" continue the column's last session.
    const last = resume ? d.db.lastRun(taskId, col.id) : undefined
    const reuse = last?.session_id && last.harness === trigger.harness ? last : undefined
    if (last && !reuse && last.ended_at === null) d.db.finishRun(last.id, false, 'Continued in a new session')
    const runId = reuse ? reuse.id : d.db.createRun({ task_id: taskId, column_id: col.id, harness: trigger.harness, model: trigger.model })
    if (reuse) { d.db.reopenRun(runId); d.db.setRunQuestion(runId, null) }
    const a: Active = { stop: null, forceStop: null, runId, columnId: col.id, killReason: null, route: true, move: true }
    active.set(taskId, a)
    // New work isn't merged yet; auto-start has done its job once a session runs.
    d.db.setTaskState(taskId, { merged_at: null, merge_base: null, auto_start: 0 })
    changed()

    const record = (event: SessionEvent) => {
      d.db.appendEvent(runId, event)
      d.push({ type: 'session', runId, taskId, event })
    }

    try {
      const harness = d.harnesses.find((h) => h.id === trigger.harness)
      if (!harness) throw new Error(`Unknown harness "${trigger.harness}"`)
      const bin = d.resolveBin(harness.id)
      if (!bin) throw new Error(`${harness.name} CLI (${harness.bin}) not found. Check Settings.`)

      // First session: pick a branch and folder nobody else uses (task ids restart with a fresh database, and a
      // leftover baton/1-… branch or folder must not hand its old work to a new task). Later sessions reuse them.
      const branch = task.branch ?? await d.git.freeBranch(board.repo_path, `baton/${task.id}-${slug(task.title)}`)
      let worktree = task.worktree_path ?? join(d.worktreeRoot, String(board.id), String(task.id))
      for (let n = 2; !task.worktree_path && !task.branch && existsSync(worktree); n++) worktree = join(d.worktreeRoot, String(board.id), `${task.id}-${n}`)
      await d.git.ensureWorktree(board.repo_path, board.base_branch, branch, worktree)
      d.db.setTaskState(taskId, { branch, worktree_path: worktree })
      const notes = await mergeBlockers(task.blocked_by, worktree, trigger.permission === 'full', record)
      if (a.killReason) throw new Error(a.killReason)

      const epic = task.epic_id ? d.db.getEpic(task.epic_id) : undefined
      const artifacts = d.db.listArtifacts(taskId)
      const prompt = render(trigger.prompt, {
        'task.title': task.title,
        'task.description': task.description,
        'epic.title': epic?.title ?? '',
        'epic.description': epic?.description ?? '',
        'prev.summary': d.db.lastSummary(taskId),
        'column.name': col.name,
        'board.name': board.name,
        branch,
        base: board.base_branch,
        worktree,
        diff: trigger.prompt.includes('{{diff}}') ? await d.git.diff(worktree, board.base_branch) : '',
        artifacts: artifacts.map((x) => `### ${x.name}\n\n${x.content}`).join('\n\n'),
        ...Object.fromEntries(artifacts.map((x) => [`artifact.${x.name}`, x.content]))
      })
      const rules = (notes.length ? `\n\n${notes.join('\n')}` : '') + (harness.promptNote?.(trigger.permission) ?? '') + protocol({ questions: true })
      // A resumed session already knows the rules; a fresh one (nothing to resume) needs them with the answer.
      const firstTurn = message !== undefined
        ? (reuse ? message : `${prompt}\n\nYou asked the user: ${last?.question ?? ''}\nTheir answer: ${message}${rules}`)
        : (reuse ? `Run this step again on the current state of the worktree.\n\n${prompt}` : prompt + rules)

      record({ kind: 'info', text: `${reuse ? 'Resumed' : 'Started'} ${harness.name} session · ${trigger.model || 'default model'} · ${trigger.permission === 'read' ? 'read-only' : 'full-auto'} · ${worktree}` })
      const session = startSession({
        harness, bin, cwd: worktree, model: trigger.model, permission: trigger.permission,
        resume: reuse?.session_id ?? undefined,
        firstTurn,
        maxTurns: settings.maxTurns,
        idleMs: Math.min(Math.max(1, settings.idleTimeoutMin) * 60_000, 2 ** 31 - 1),
        spawn: d.spawn,
        onEvent: record,
        onSessionId: (id) => d.db.setRunSession(runId, id),
        onArtifact: (x) => {
          d.db.saveArtifact({ task_id: taskId, run_id: runId, column_id: col.id, ...x })
          changed()
        }
      })
      a.stop = session.kill
      a.forceStop = session.forceKill
      if (a.killReason) session.kill(a.killReason) // killed while starting
      finish(taskId, a, await session.result)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      record({ kind: 'info', text: msg })
      finish(taskId, a, { type: 'failed', text: msg })
    }
  }

  /**
   * Bring blockers' work into this task's worktree: merge each blocker branch (committing a blocker's leftover
   * uncommitted work first). Runs at every session start; already-merged branches are a no-op. Returns notes for
   * the agent about anything that didn't merge cleanly.
   */
  async function mergeBlockers(blockerIds: number[], worktree: string, canResolve: boolean, record: (e: SessionEvent) => void) {
    const notes: string[] = []
    for (const b of blockerIds.map((id) => d.db.getTask(id))) {
      if (!b.branch) continue // never ran: nothing to merge
      if (b.worktree_path && !active.has(b.id) && await d.git.isDirty(b.worktree_path).catch(() => false)) {
        await d.git.commitAll(b.worktree_path, `Baton: uncommitted work from "${b.title}"`)
          .catch((e) => record({ kind: 'info', text: `Could not commit ${b.branch}'s leftover changes: ${e.message}` }))
      }
      const r = await d.git.merge(worktree, b.branch)
      if (r.ok) {
        if (r.changed) record({ kind: 'info', text: `Merged blocker branch ${b.branch} ("${b.title}")` })
      } else if (r.conflicts.length && canResolve) {
        record({ kind: 'info', text: `Merging ${b.branch} conflicted in: ${r.conflicts.join(', ')}` })
        notes.push(`Merging the branch ${b.branch} (from the finished task "${b.title}") into this worktree produced conflicts in: ${r.conflicts.join(', ')}. Resolve them and commit the merge before anything else.`)
      } else {
        if (r.conflicts.length) await d.git.abortMerge(worktree) // a read-only step can't resolve it
        record({ kind: 'info', text: `Could not merge ${b.branch}: ${r.conflicts.length ? `conflicts in ${r.conflicts.join(', ')}` : r.error}` })
        notes.push(`Note: the changes from the finished task "${b.title}" (branch ${b.branch}) could not be merged into this worktree${r.conflicts.length ? ' because they conflict' : ''}, so they are missing here.`)
      }
    }
    return notes
  }

  function finish(taskId: number, a: Active, o: Marker) {
    if (active.get(taskId) === a) active.delete(taskId)
    try {
      if (o.type === 'question' && a.route && !a.killReason) {
        // Session stays open (ended_at NULL) until the user answers; it doesn't hold a concurrency slot.
        d.db.setRunQuestion(a.runId, o.text)
        d.db.setStatus(taskId, 'waiting')
        d.notify?.(`Question: ${d.db.getTask(taskId).title}`, o.text)
      } else {
        const ok = o.type === 'done'
        d.db.finishRun(a.runId, ok, o.type === 'question' ? (a.killReason ?? 'Stopped') : o.text)
        if (a.route) {
          const task = d.db.getTask(taskId)
          d.db.setStatus(taskId, ok ? 'succeeded' : 'failed')
          const trigger = d.db.getColumn(a.columnId)?.trigger
          const next = ok ? trigger?.onSuccess : trigger?.onFailure
          if (next && a.move && task.column_id === a.columnId && d.db.getColumn(next)?.board_id === task.board_id) {
            d.db.moveTask(taskId, next, Number.MAX_SAFE_INTEGER)
            enter(taskId, false)
          }
        }
      }
    } catch (e) {
      console.error('session finish failed', e) // e.g. task deleted mid-run
    }
    changed()
    pump()
  }

  return {
    /** A task landed in a column (moved or created): start a new session if it has a trigger. */
    onEnter: (taskId: number) => enter(taskId, false),
    /** "Run again": continue the task's last session in its current column. */
    retry: (taskId: number) => enter(taskId, true),
    /** Send the user's answer to the session paused on a question. */
    answer(taskId: number, text: string) {
      if (!d.db.pendingRun(taskId)) throw new Error('This task is not waiting for an answer')
      d.db.enqueue(taskId, true, text)
      changed()
      pump()
    },
    /** Re-check blocked tasks (e.g. after dependencies changed). */
    pump,
    /** Stop a running, queued or waiting task; it stays in its column, marked failed. */
    stop(taskId: number) {
      const { status } = d.db.getTask(taskId)
      const a = active.get(taskId)
      if (status === 'running' && a) {
        a.move = false
        return kill(taskId, 'Stopped by user', true) // the session's end marks it failed
      }
      // Queued (maybe behind its previous session, which was already told to exit and won't route it) or waiting.
      d.db.closeOpenRuns(taskId, 'Stopped by user')
      if (status === 'queued') d.db.setStatus(taskId, 'idle')
      else if (status === 'waiting' || status === 'running') d.db.setStatus(taskId, 'failed') // running: start() died early
      changed()
    },
    /** Before deleting a task: kill its session without routing (deleting the row takes it off the queue). */
    forget(taskId: number) {
      kill(taskId, 'Task deleted', false)
    },
    /** App quitting: SIGTERM every session; `force` = SIGKILL whatever is still alive. */
    killAll({ force = false } = {}) {
      closing = true
      for (const [id, a] of active) force ? a.forceStop?.() : kill(id, 'Interrupted (app closed)', false)
    },
    activeCount: () => active.size,
    isActive: (taskId: number) => active.has(taskId)
  }
}

export type Runner = ReturnType<typeof createRunner>
