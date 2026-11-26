import { useEffect, useRef, useState } from 'react'
import type { Artifact, Board, Column, Epic, Run, SessionEvent, Task } from '../../shared/types'
import { call, onPush, type Act } from './api'
import { StatusBadge } from './StatusBadge'
import { Modal } from './Modal'
import { Transcript } from './Transcript'
import { AnswerBox } from './AnswerBox'

interface Props {
  task: Task
  board: Board
  /** All tasks on the board (for picking blockers). */
  tasks: Task[]
  columns: Column[]
  epics: Epic[]
  act: Act
  onClose: () => void
}

export function TaskDialog({ task, board, tasks, columns, epics, act, onClose }: Props) {
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [runs, setRuns] = useState<Run[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const column = columns.find((c) => c.id === task.column_id)
  const busy = task.status === 'queued' || task.status === 'running' || task.status === 'waiting'
  const question = task.status === 'waiting' ? runs.find((r) => r.question)?.question : null
  const dirty = title !== task.title || description !== task.description
  const runsRef = useRef(runs)
  runsRef.current = runs

  useEffect(() => {
    const load = () => {
      act(call('listRuns', task.id)).then((r) => r && setRuns(r))
      act(call('listArtifacts', task.id)).then((a) => a && setArtifacts(a))
    }
    load()
    // Runs are listed without transcripts, so reloading them is cheap; each SessionView loads and streams its own.
    return onPush((e) => {
      if (e.type === 'changed') load()
      if (e.type === 'session' && e.taskId === task.id && !runsRef.current.some((r) => r.id === e.runId)) load() // a new session
    })
  }, [task.id, act])

  async function remove() {
    if (!confirm(`Delete task "${task.title}"?`)) return
    if (await act(call('deleteTask', task.id).then(() => true))) onClose()
  }

  return (
    <Modal wide onClose={onClose} title={<span className="flex items-center gap-2">{task.title} <StatusBadge status={task.status} /></span>}
      footer={<>
        <button className="btn-danger" onClick={remove}>Delete</button>
        <div className="flex-1" />
        {busy && <button className="btn" onClick={() => act(call('stopTask', task.id))}>■ Stop</button>}
        {!busy && column?.trigger && <button className="btn" onClick={() => act(call('retryTask', task.id))}>↻ Continue “{column.name}” session</button>}
        <button className="btn-primary" disabled={!dirty} onClick={() => act(call('updateTask', task.id, { title, description }))}>Save</button>
      </>}>
      <div className="flex flex-col gap-4">
        {question && <AnswerBox question={question} onSend={(text) => act(call('answerQuestion', task.id, text))} />}
        <label>
          <span className="label">Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          <span className="label">Description</span>
          <textarea className="input h-32" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
          <span>Column: <b>{column?.name}</b></span>
          {task.branch && <span>Branch: <code>{task.branch}</code></span>}
          {task.worktree_path && (
            <button className="underline" onClick={() => act(call('openWorktree', task.id))}>Open worktree</button>
          )}
        </div>

        <div className="flex gap-3">
          <label className="w-56">
            <span className="label">Epic</span>
            <select className="input" value={task.epic_id ?? ''}
              onChange={(e) => act(call('updateTask', task.id, { epic_id: e.target.value ? Number(e.target.value) : null }))}>
              <option value="">No epic</option>
              {epics.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
            </select>
          </label>
          <Blockers task={task} tasks={tasks} act={act} />
        </div>

        <FinishPanel task={task} board={board} busy={busy} act={act} />

        {artifacts.length > 0 && (
          <div>
            <span className="label">Artifacts</span>
            {artifacts.map((x) => <ArtifactView key={x.id} artifact={x} column={columns.find((c) => c.id === x.column_id)} />)}
          </div>
        )}

        <div>
          <span className="label">Sessions</span>
          {runs.length === 0 && <p className="text-sm text-neutral-500">No sessions yet. Move the card into a ⚡ column to start one.</p>}
          {runs.map((r, i) => <SessionView key={r.id} run={r} column={columns.find((c) => c.id === r.column_id)} open={i === 0} act={act} />)}
        </div>
      </div>
    </Modal>
  )
}

/** One session. Its transcript is fetched the first time it's expanded, then streamed events are appended. */
function SessionView({ run, column, open, act }: { run: Run; column?: Column; open: boolean; act: Act }) {
  const live = run.ended_at === null
  const state = live ? '● live' : run.ok ? '✓ done' : '✕ failed'
  const [shown, setShown] = useState(open)
  const [events, setEvents] = useState<SessionEvent[] | null>(null)
  // Pushes before the fetch returns are dropped: replies and pushes arrive in the order the main process sent
  // them, so the fetched transcript already holds those events.
  useEffect(() => onPush((e) => {
    if (e.type === 'session' && e.runId === run.id) setEvents((ev) => ev && [...ev, e.event])
  }), [run.id])
  useEffect(() => { // fetch once, when first expanded
    if (shown && !events) act(call('getRunEvents', run.id)).then((ev) => ev && setEvents(ev))
  }, [shown, run.id])
  return (
    <details open={shown} onToggle={(e) => setShown(e.currentTarget.open)}
      className="mb-2 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
      <summary className="cursor-pointer px-3 py-2 text-sm">
        <b>{column?.name ?? 'Deleted column'}</b> · {run.harness} · {run.model || 'default'} ·{' '}
        <span className={live ? 'text-blue-600' : run.ok ? 'text-green-600' : 'text-red-600'}>{state}</span>
        <span className="ml-2 text-xs text-neutral-500">{run.started_at} UTC</span>
      </summary>
      {run.summary && !live && (
        <div className="border-t border-neutral-200 px-3 py-2 text-sm whitespace-pre-wrap dark:border-neutral-800">
          <span className="label">Result</span>{run.summary}
        </div>
      )}
      <div className="border-t border-neutral-200 dark:border-neutral-800">{events ? <Transcript events={events} live={live} /> : <p className="p-3 text-xs text-neutral-500">Loading…</p>}</div>
    </details>
  )
}

function ArtifactView({ artifact, column }: { artifact: Artifact; column?: Column }) {
  const html = /\.html?$/i.test(artifact.name)
  return (
    <details className="mb-2 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
      <summary className="cursor-pointer px-3 py-2 text-sm">
        📎 <b>{artifact.name}</b>
        <span className="ml-2 text-xs text-neutral-500">{column?.name ?? ''} · {artifact.updated_at} UTC</span>
        <button className="ml-3 text-xs underline" onClick={(e) => { e.preventDefault(); navigator.clipboard.writeText(artifact.content) }}>Copy</button>
      </summary>
      {html
        ? <iframe sandbox="" srcDoc={artifact.content} className="h-96 w-full border-t border-neutral-200 bg-white dark:border-neutral-800" />
        : <pre className="max-h-96 overflow-auto border-t border-neutral-200 bg-neutral-50 p-3 text-xs whitespace-pre-wrap dark:border-neutral-800 dark:bg-neutral-950">{artifact.content}</pre>}
    </details>
  )
}

/** Blocked-by chips plus a picker; the task's trigger waits until every blocker succeeded or is in a done column. */
function Blockers({ task, tasks, act }: { task: Task; tasks: Task[]; act: Act }) {
  const set = (ids: number[]) => act(call('setBlockers', task.id, ids))
  const candidates = tasks.filter((t) => t.id !== task.id && !task.blocked_by.includes(t.id))
  return (
    <div className="flex-1">
      <span className="label">Blocked by</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {task.blocked_by.map((id) => {
          const b = tasks.find((t) => t.id === id)
          if (!b) return null
          return (
            <span key={id} className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${b.resolved ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300' : 'bg-neutral-200 dark:bg-neutral-800'}`}>
              {b.resolved ? '✓' : '🔒'} {b.title}
              <button className="ml-0.5 opacity-60 hover:opacity-100" onClick={() => set(task.blocked_by.filter((x) => x !== id))}>✕</button>
            </span>
          )
        })}
        {candidates.length > 0 && (
          <select className="input w-auto text-xs" value="" onChange={(e) => e.target.value && set([...task.blocked_by, Number(e.target.value)])}>
            <option value="">+ Add blocker…</option>
            {candidates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        )}
      </div>
    </div>
  )
}

/** Changes vs base, plus finishing (merge / PR per the board) and worktree cleanup. */
function FinishPanel({ task, board, busy, act }: { task: Task; board: Board; busy: boolean; act: Act }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const finish = async () => { setWorking(true); await act(call('finishTask', task.id)); setWorking(false) }
  if (!task.branch) return null // never ran: nothing to finish
  return (
    <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">Finish</span>
        {task.merged_at && <span className="text-xs text-purple-700 dark:text-purple-300">✓ merged into {board.base_branch}</span>}
        {task.pr_url && (
          <button className="text-xs text-purple-700 underline dark:text-purple-300" onClick={() => act(call('openPr', task.id))}>{task.pr_url}</button>
        )}
        <div className="flex-1" />
        <button className="btn" onClick={async () => setDiff(diff === null ? (await act(call('getChanges', task.id))) ?? '' : null)}>
          {diff === null ? 'Show changes' : 'Hide changes'}
        </button>
        {task.worktree_path && (
          <button className="btn" disabled={busy} onClick={() => {
            if (confirm('Remove this task\'s worktree folder? Uncommitted work is committed to its branch first; the branch is kept.')) act(call('removeWorktree', task.id))
          }}>Remove worktree</button>
        )}
        <button className="btn-primary" disabled={busy || working} onClick={finish}>
          {working ? 'Finishing…' : board.finish_mode === 'pr' ? (task.pr_url ? '⇡ Update PR' : '⇡ Open PR') : `⇡ Merge into ${board.base_branch}`}
        </button>
      </div>
      {task.finish_error && <div className="mt-2 rounded bg-red-50 p-2 text-xs whitespace-pre-wrap text-red-700 dark:bg-red-950 dark:text-red-300">{task.finish_error}</div>}
      {diff !== null && <DiffView diff={diff} />}
    </div>
  )
}

function DiffView({ diff }: { diff: string }) {
  const color = (l: string) =>
    l.startsWith('+++') || l.startsWith('---') ? 'text-neutral-500'
      : l.startsWith('+') ? 'text-green-700 dark:text-green-400'
        : l.startsWith('-') ? 'text-red-700 dark:text-red-400'
          : l.startsWith('@@') ? 'text-blue-600'
            : l.startsWith('diff ') ? 'mt-2 font-semibold' : ''
  return (
    <pre className="mt-2 max-h-96 overflow-auto rounded bg-neutral-50 p-2 text-xs dark:bg-neutral-950">
      {diff.split('\n').map((l, i) => <div key={i} className={color(l)}>{l || ' '}</div>)}
    </pre>
  )
}
