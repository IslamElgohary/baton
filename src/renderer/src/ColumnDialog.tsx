import { useState } from 'react'
import type { Column, HarnessInfo, Trigger } from '../../shared/types'
import { call, type Act } from './api'
import { Modal } from './Modal'

const VARS = ['task.title', 'task.description', 'epic.title', 'epic.description', 'prev.summary', 'artifacts', 'artifact.<name>', 'diff', 'branch', 'base', 'worktree', 'column.name', 'board.name']

interface Props {
  column: Column
  columns: Column[]
  harnesses: HarnessInfo[]
  act: Act
  onClose: () => void
}

export function ColumnDialog({ column, columns, harnesses, act, onClose }: Props) {
  const [name, setName] = useState(column.name)
  const [isDone, setIsDone] = useState(!!column.is_done)
  const [finish, setFinish] = useState(!!column.finish_on_enter)
  const [enabled, setEnabled] = useState(!!column.trigger)
  const [t, setT] = useState<Trigger>(column.trigger ?? {
    harness: harnesses[0]?.id ?? '', model: '', prompt: 'Task: {{task.title}}\n\n{{task.description}}\n\n',
    permission: 'read', onSuccess: null, onFailure: null
  })
  const set = (patch: Partial<Trigger>) => setT({ ...t, ...patch })
  const harness = harnesses.find((h) => h.id === t.harness)
  const others = columns.filter((c) => c.id !== column.id)

  async function save() {
    const ok = await act(call('updateColumn', column.id, { name, is_done: isDone ? 1 : 0, finish_on_enter: finish && !enabled ? 1 : 0, trigger: enabled ? t : null }).then(() => true))
    if (ok) onClose()
  }

  async function remove() {
    if (!confirm(`Delete column "${column.name}"?`)) return
    if (await act(call('deleteColumn', column.id).then(() => true))) onClose()
  }

  const target = (label: string, value: number | null, onChange: (v: number | null) => void) => (
    <label className="flex-1">
      <span className="label">{label}</span>
      <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">Stay in this column</option>
        {others.map((c) => <option key={c.id} value={c.id}>Move to {c.name}</option>)}
      </select>
    </label>
  )

  return (
    <Modal title={`Column: ${column.name}`} onClose={onClose} footer={<>
      <button className="btn-danger" onClick={remove}>Delete column</button>
      <div className="flex-1" />
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn-primary" onClick={save}>Save</button>
    </>}>
      <div className="flex flex-col gap-4">
        <label>
          <span className="label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isDone} onChange={(e) => setIsDone(e.target.checked)} />
          Done column <span className="text-xs text-neutral-500">(tasks here count as finished)</span>
        </label>
        <label className={`flex items-center gap-2 text-sm ${enabled ? 'opacity-50' : ''}`}>
          <input type="checkbox" disabled={enabled} checked={finish && !enabled} onChange={(e) => setFinish(e.target.checked)} />
          ⇡ Finish cards that enter this column
          <span className="text-xs text-neutral-500">(merge or open a PR, as set on the board{enabled ? '; not available on ⚡ columns' : ''})</span>
        </label>

        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          ⚡ Run an agent when a card enters this column
        </label>

        {enabled && (
          <div className="flex flex-col gap-4 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="flex gap-3">
              <label className="flex-1">
                <span className="label">Harness</span>
                <select className="input" value={t.harness} onChange={(e) => set({ harness: e.target.value, model: '' })}>
                  {harnesses.map((h) => (
                    <option key={h.id} value={h.id}>{h.name}{h.path ? '' : ' (not installed)'}</option>
                  ))}
                </select>
              </label>
              <label className="flex-1">
                <span className="label">Model {harness && !harness.loggedIn && <span className="text-red-600">· {harness.authDetail}</span>}</span>
                <input className="input" list="harness-models" placeholder="Harness default" value={t.model}
                  onChange={(e) => set({ model: e.target.value })} />
                <datalist id="harness-models">
                  {harness?.models.map((m) => <option key={m} value={m} />)}
                </datalist>
              </label>
            </div>

            <div>
              <span className="label">Permissions</span>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={t.permission === 'read'} onChange={() => set({ permission: 'read' })} /> Read-only
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={t.permission === 'full'} onChange={() => set({ permission: 'full' })} />
                  Full-auto <span className="text-xs text-amber-600">⚠ edits files and runs commands without asking</span>
                </label>
              </div>
            </div>

            <label>
              <span className="label">Prompt</span>
              <textarea className="input h-40 font-mono" value={t.prompt} onChange={(e) => set({ prompt: e.target.value })} />
              <span className="mt-1 block text-xs text-neutral-500">
                Variables: {VARS.map((v) => <code key={v} className="mr-1.5">{`{{${v}}}`}</code>)}
              </span>
            </label>

            <div className="flex gap-3">
              {target('On success', t.onSuccess, (v) => set({ onSuccess: v }))}
              {target('On failure', t.onFailure, (v) => set({ onFailure: v }))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
