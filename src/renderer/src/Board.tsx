import {
  closestCenter, DndContext, DragOverlay, PointerSensor, pointerWithin, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent
} from '@dnd-kit/core'
import { arrayMove, horizontalListSortingStrategy, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useEffect, useState, type ReactNode } from 'react'
import type { BoardData, Column, Epic, HarnessInfo, Task } from '../../shared/types'
import { call } from './api'
import type { Act } from './App'
import { ColumnDialog } from './ColumnDialog'
import { TaskDialog } from './TaskDialog'

// dnd ids: c<id> = column (sortable), b<id> = column body (drop target), t<id> = task
const num = (dndId: unknown) => Number(String(dndId).slice(1))
const kind = (dndId: unknown) => String(dndId)[0]

/** Tasks only collide with tasks/column bodies; columns only with columns. */
const collision: CollisionDetection = (args) => {
  const dragsColumn = kind(args.active.id) === 'c'
  const scoped = { ...args, droppableContainers: args.droppableContainers.filter((c) => (kind(c.id) === 'c') === dragsColumn) }
  if (dragsColumn) return closestCenter(scoped)
  const hits = pointerWithin(scoped)
  const taskHits = hits.filter((h) => kind(h.id) === 't')
  return taskHits.length ? taskHits : hits.length ? hits : closestCenter(scoped)
}

const tasksIn = (tasks: Task[], columnId: number) =>
  tasks.filter((t) => t.column_id === columnId).sort((a, b) => a.position - b.position)

/** Same reordering the main process does, applied locally so the drop doesn't flicker. */
function moveLocal(tasks: Task[], id: number, columnId: number, index: number): Task[] {
  const moved = tasks.find((t) => t.id === id)!
  const target = tasksIn(tasks, columnId).filter((t) => t.id !== id)
  target.splice(index, 0, { ...moved, column_id: columnId })
  const source = moved.column_id === columnId ? [] : tasksIn(tasks, moved.column_id).filter((t) => t.id !== id)
  const updated = new Map([...target.map((t, i) => ({ ...t, position: i })), ...source.map((t, i) => ({ ...t, position: i }))]
    .map((t) => [t.id, t]))
  return tasks.map((t) => updated.get(t.id) ?? t)
}

interface Props {
  data: BoardData
  setData: (d: BoardData) => void
  harnesses: HarnessInfo[]
  act: Act
  /** Show only this epic's tasks (new tasks join it). */
  epicFilter: number | null
}

/** Per-card extras: its epic, and whether a blocker is still outside a done column. */
type Meta = Map<number, { epic?: Epic; blocked: boolean }>

export function Board({ data, setData, harnesses, act, epicFilter }: Props) {
  const { board, columns, tasks } = data
  const done = new Set(columns.filter((c) => c.is_done).map((c) => c.id))
  const meta: Meta = new Map(tasks.map((t) => [t.id, {
    epic: data.epics.find((e) => e.id === t.epic_id),
    // a blocker is resolved once its latest session succeeded or it sits in a done column
    blocked: t.blocked_by.some((id) => { const b = tasks.find((x) => x.id === id); return !!b && !done.has(b.column_id) && b.status !== 'succeeded' })
  }]))
  const visible = epicFilter ? tasks.filter((t) => t.epic_id === epicFilter) : tasks
  const [dragging, setDragging] = useState<string | null>(null)
  const [editColumn, setEditColumn] = useState<Column | null>(null)
  const [openTask, setOpenTask] = useState<number | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function onDragEnd({ active, over }: DragEndEvent) {
    setDragging(null)
    if (!over) return
    if (kind(active.id) === 'c') {
      const from = columns.findIndex((c) => c.id === num(active.id))
      const to = columns.findIndex((c) => c.id === num(over.id))
      if (from < 0 || to < 0 || from === to) return
      setData({ ...data, columns: arrayMove(columns, from, to) })
      act(call('moveColumn', num(active.id), to))
      return
    }
    const id = num(active.id)
    const task = tasks.find((t) => t.id === id)
    if (!task) return
    let columnId: number, index: number
    if (kind(over.id) === 't') {
      const overTask = tasks.find((t) => t.id === num(over.id))
      if (!overTask) return
      columnId = overTask.column_id
      index = tasksIn(tasks, columnId).findIndex((t) => t.id === overTask.id)
    } else {
      columnId = num(over.id)
      index = tasksIn(tasks, columnId).filter((t) => t.id !== id).length
    }
    if (columnId === task.column_id && index === task.position) return
    setData({ ...data, tasks: moveLocal(tasks, id, columnId, index) })
    act(call('moveTask', id, columnId, index))
  }

  const draggedTask = dragging && kind(dragging) === 't' ? tasks.find((t) => t.id === num(dragging)) : null
  const draggedColumn = dragging && kind(dragging) === 'c' ? columns.find((c) => c.id === num(dragging)) : null
  const task = openTask ? tasks.find((t) => t.id === openTask) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BoardHeader data={data} act={act} />
      <DndContext sensors={sensors} collisionDetection={collision}
        onDragStart={(e) => setDragging(String(e.active.id))} onDragCancel={() => setDragging(null)} onDragEnd={onDragEnd}>
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
          <SortableContext items={columns.map((c) => `c${c.id}`)} strategy={horizontalListSortingStrategy}>
            {columns.map((c) => (
              <ColumnView key={c.id} column={c} tasks={tasksIn(visible, c.id)} act={act} meta={meta} epicFilter={epicFilter}
                onEdit={() => setEditColumn(c)} onOpenTask={setOpenTask} />
            ))}
          </SortableContext>
          <AddColumn onAdd={(name) => act(call('addColumn', board.id, name))} />
        </div>
        <DragOverlay>
          {draggedTask && <CardView task={draggedTask} meta={meta} />}
          {draggedColumn && <div className="rounded-lg bg-white p-3 text-sm font-semibold shadow-lg dark:bg-neutral-800">{draggedColumn.name}</div>}
        </DragOverlay>
      </DndContext>
      {editColumn && (
        <ColumnDialog column={editColumn} columns={columns} harnesses={harnesses} act={act} onClose={() => setEditColumn(null)} />
      )}
      {task && <TaskDialog task={task} board={board} tasks={tasks} columns={columns} epics={data.epics} act={act} onClose={() => setOpenTask(null)} />}
    </div>
  )
}

function BoardHeader({ data: { board }, act }: { data: BoardData; act: Act }) {
  const [branches, setBranches] = useState<string[]>([])
  const loadBranches = () => act(call('listBranches', board.id)).then((b) => b && setBranches(b))
  useEffect(() => { loadBranches() }, [board.id])
  return (
    <header className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
      <InlineEdit value={board.name} className="shrink-0 text-lg font-semibold" onSave={(v) => act(call('renameBoard', board.id, v))} />
      <span className="min-w-0 flex-1 truncate text-xs text-neutral-500" title={board.repo_path}>{board.repo_path}</span>
      <label className="flex shrink-0 items-center gap-1 text-xs text-neutral-500" title="Branch tasks start from and finish into">
        base:
        <select className="max-w-48 rounded border border-neutral-300 bg-transparent px-1 py-0.5 font-mono dark:border-neutral-700"
          value={board.base_branch} onFocus={loadBranches}
          onChange={(e) => act(call('updateBaseBranch', board.id, e.target.value))}>
          {!branches.includes(board.base_branch) && <option value={board.base_branch}>{board.base_branch}{branches.length ? ' (missing)' : ''}</option>}
          {branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </label>
      <label className="flex shrink-0 items-center gap-1 text-xs text-neutral-500" title="How finished tasks reach the base branch">
        finish:
        <select className="rounded border border-neutral-300 bg-transparent px-1 py-0.5 dark:border-neutral-700" value={board.finish_mode}
          onChange={(e) => act(call('setFinishMode', board.id, e.target.value as 'merge' | 'pr'))}>
          <option value="pr">pull request</option>
          <option value="merge">local merge</option>
        </select>
      </label>
      <button className="btn-danger shrink-0 whitespace-nowrap" onClick={() => {
        if (confirm(`Delete board "${board.name}" and all its tasks? Their worktree folders are removed (leftover work is committed to each branch first; branches stay).`)) act(call('deleteBoard', board.id))
      }}>Delete board</button>
    </header>
  )
}

function ColumnView({ column, tasks, act, meta, epicFilter, onEdit, onOpenTask }: {
  column: Column; tasks: Task[]; act: Act; meta: Meta; epicFilter: number | null; onEdit: () => void; onOpenTask: (id: number) => void
}) {
  const sortable = useSortable({ id: `c${column.id}` })
  const body = useDroppable({ id: `b${column.id}` })
  const t = column.trigger
  return (
    <section ref={sortable.setNodeRef}
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition, opacity: sortable.isDragging ? 0.4 : 1 }}
      className="flex w-72 shrink-0 flex-col rounded-lg bg-neutral-100 dark:bg-neutral-900">
      <div {...sortable.attributes} {...sortable.listeners} className="cursor-grab px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <InlineEdit value={column.name} className="text-sm font-semibold" onSave={(v) => act(call('updateColumn', column.id, { name: v }))} />
          <span className="text-xs text-neutral-500">{tasks.length}</span>
          {column.is_done ? <span className="text-xs text-green-600" title="Done column">✓</span> : null}
          {column.finish_on_enter ? <span className="text-xs text-purple-600" title="Finishes cards that enter (merge or PR)">⇡ finish</span> : null}
          <div className="flex-1" />
          <button className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100" title="Configure column" onClick={onEdit}>⚙</button>
        </div>
        {t && (
          <div className="mt-1 truncate text-xs text-indigo-600 dark:text-indigo-400" title={t.prompt}>
            ⚡ {t.harness} · {t.model || 'default'} · {t.permission === 'read' ? 'read-only' : 'full-auto'}
          </div>
        )}
      </div>
      <div ref={body.setNodeRef} className={`flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 ${body.isOver ? 'bg-indigo-50 dark:bg-indigo-950/40' : ''}`}>
        <SortableContext items={tasks.map((x) => `t${x.id}`)} strategy={verticalListSortingStrategy}>
          {tasks.map((x) => <SortableCard key={x.id} task={x} meta={meta} onOpen={() => onOpenTask(x.id)} />)}
        </SortableContext>
        <AddTask onAdd={(title) => act(call('createTask', column.board_id, column.id, title, '', epicFilter))} />
      </div>
    </section>
  )
}

function SortableCard({ task, meta, onOpen }: { task: Task; meta: Meta; onOpen: () => void }) {
  const s = useSortable({ id: `t${task.id}` })
  return (
    <div ref={s.setNodeRef} {...s.attributes} {...s.listeners} onClick={onOpen}
      style={{ transform: CSS.Translate.toString(s.transform), transition: s.transition, opacity: s.isDragging ? 0.4 : 1 }}>
      <CardView task={task} meta={meta} />
    </div>
  )
}

const STATUS: Record<Task['status'], [string, string] | null> = {
  idle: null,
  queued: ['queued', 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'],
  running: ['running', 'bg-blue-100 text-blue-800 animate-pulse dark:bg-blue-950 dark:text-blue-300'],
  waiting: ['❓ needs answer', 'bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100'],
  succeeded: ['✓ done', 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'],
  failed: ['failed', 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300']
}

export function StatusBadge({ status }: { status: Task['status'] }) {
  const s = STATUS[status]
  return s ? <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${s[1]}`}>{s[0]}</span> : null
}

function CardView({ task, meta }: { task: Task; meta: Meta }) {
  const m = meta.get(task.id)
  return (
    <div className="cursor-pointer rounded-md border border-neutral-200 bg-white p-2.5 shadow-sm hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-700">
      <div className="flex items-start gap-2">
        <div className="flex-1 text-sm">{task.title}</div>
        <StatusBadge status={task.status} />
        {task.merged_at && <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-800 dark:bg-purple-950 dark:text-purple-300">merged</span>}
        {task.pr_url && <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-800 dark:bg-purple-950 dark:text-purple-300">PR</span>}
        {task.finish_error && <span className="text-xs text-red-600" title={task.finish_error}>⚠ finish failed</span>}
      </div>
      {task.description && <div className="mt-1 truncate text-xs text-neutral-500">{task.description.split('\n')[0]}</div>}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-neutral-500 empty:hidden">
        {m?.epic && (
          <span className="flex items-center gap-1 rounded-full px-1.5 py-0.5" style={{ background: m.epic.color + '22', color: m.epic.color }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.epic.color }} />{m.epic.title}
          </span>
        )}
        {m?.blocked && <span title={task.auto_start ? 'Moves to the next ⚡ column and starts once every blocker has succeeded or is done' : 'Waiting for blockers'}>🔒 blocked{task.auto_start ? ' · auto-start' : ''}</span>}
        {task.artifacts > 0 && <span>📎 {task.artifacts}</span>}
      </div>
    </div>
  )
}

function AddTask({ onAdd }: { onAdd: (title: string) => void }) {
  return <AddInline label="+ Add task" placeholder="Task title" onAdd={onAdd} />
}

function AddColumn({ onAdd }: { onAdd: (name: string) => void }) {
  return <div className="w-72 shrink-0"><AddInline label="+ Add column" placeholder="Column name" onAdd={onAdd} /></div>
}

function AddInline({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  if (!editing) {
    return <button className="rounded-md px-2 py-1 text-left text-sm text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800" onClick={() => setEditing(true)}>{label}</button>
  }
  return (
    <input autoFocus className="input" placeholder={placeholder}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        const v = e.currentTarget.value.trim()
        if (e.key === 'Enter' && v) { onAdd(v); e.currentTarget.value = '' }
        if (e.key === 'Escape') setEditing(false)
      }} />
  )
}

/** Text that turns into an input on double-click; saves on Enter/blur. */
function InlineEdit({ value, onSave, className }: { value: string; onSave: (v: string) => void; className?: string }): ReactNode {
  const [editing, setEditing] = useState(false)
  if (!editing) return <span className={`cursor-text truncate ${className ?? ''}`} onDoubleClick={() => setEditing(true)} title="Double-click to edit">{value}</span>
  const save = (v: string) => { setEditing(false); if (v.trim() && v.trim() !== value) onSave(v.trim()) }
  return (
    <input autoFocus defaultValue={value} className={`input w-auto ${className ?? ''}`}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => save(e.currentTarget.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') save(e.currentTarget.value); if (e.key === 'Escape') setEditing(false) }} />
  )
}
