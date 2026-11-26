import { useEffect, useState } from 'react'
import type { Breakdown, DraftTask, Epic, HarnessInfo } from '../../shared/types'
import { call, onPush, type Act } from './api'
import { Modal } from './Modal'
import { Transcript } from './Transcript'

interface Props {
  epic: Epic
  harnesses: HarnessInfo[]
  act: Act
  onClose: () => void
}

export function EpicDialog({ epic, harnesses, act, onClose }: Props) {
  const [title, setTitle] = useState(epic.title)
  const [description, setDescription] = useState(epic.description)
  const [color, setColor] = useState(epic.color)
  const [harness, setHarness] = useState(harnesses[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [bd, setBd] = useState<Breakdown>({ running: false, events: [], error: null })
  const [draft, setDraft] = useState<DraftTask[] | null>(epic.draft)
  const dirty = title !== epic.title || description !== epic.description || color !== epic.color

  useEffect(() => {
    const load = () => act(call('getBreakdown', epic.id)).then((b) => b && setBd(b))
    load()
    return onPush((e) => {
      if (e.type === 'changed') load()
      if (e.type === 'breakdown' && e.epicId === epic.id) setBd((b) => ({ ...b, events: [...b.events, e.event] }))
    })
  }, [epic.id, act])
  const savedDraft = JSON.stringify(epic.draft)
  useEffect(() => setDraft(JSON.parse(savedDraft)), [savedDraft]) // a finished breakdown delivers a new draft; refetches don't reset edits

  const save = () => act(call('updateEpic', epic.id, { title, description, color }).then(() => true))
  async function saveAndClose() {
    if (await save()) onClose()
  }
  async function breakDown() {
    if (dirty) await save() // the agent reads the saved description
    await act(call('startBreakdown', epic.id, harness, model))
  }
  async function approve() {
    const ids = await act(call('approveDraft', epic.id, draft!))
    if (ids) setDraft(null)
  }
  async function remove() {
    if (!confirm(`Delete epic "${epic.title}"? Its tasks stay on the board.`)) return
    if (await act(call('deleteEpic', epic.id).then(() => true))) onClose()
  }
  const setRow = (i: number, patch: Partial<DraftTask>) => setDraft(draft!.map((t, j) => (j === i ? { ...t, ...patch } : t)))
  const removeRow = (i: number) => setDraft(draft!.filter((_, j) => j !== i).map((t) => ({
    ...t, blockedBy: t.blockedBy.filter((b) => b !== i).map((b) => (b > i ? b - 1 : b)) // keep indexes pointing at the same tasks
  })))
  useEffect(() => { if (!harness && harnesses[0]) setHarness(harnesses[0].id) }, [harness, harnesses]) // harnesses load async
  const h = harnesses.find((x) => x.id === harness)

  return (
    <Modal wide onClose={onClose} title={<span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: color }} />Epic: {epic.title}</span>}
      footer={<>
        <button className="btn-danger" onClick={remove}>Delete epic</button>
        <div className="flex-1" />
        <button className="btn-primary" disabled={!dirty} onClick={saveAndClose}>Save</button>
      </>}>
      <div className="flex flex-col gap-4">
        <div className="flex gap-3">
          <label className="flex-1">
            <span className="label">Title</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            <span className="label">Color</span>
            <input type="color" className="h-8 w-12 cursor-pointer rounded" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
        </div>
        <label>
          <span className="label">Description</span>
          <textarea className="input h-40" placeholder="What should this epic achieve? Goals, constraints, acceptance criteria…"
            value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>

        <section className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
          <div className="mb-2 text-sm font-semibold">Break down into tasks</div>
          <div className="flex items-end gap-3">
            <label className="flex-1">
              <span className="label">Harness</span>
              <select className="input" value={harness} onChange={(e) => { setHarness(e.target.value); setModel('') }}>
                {harnesses.map((x) => <option key={x.id} value={x.id}>{x.name}{x.path ? '' : ' (not installed)'}</option>)}
              </select>
            </label>
            <label className="flex-1">
              <span className="label">Model</span>
              <input className="input" list="epic-models" placeholder="Harness default" value={model} onChange={(e) => setModel(e.target.value)} />
              <datalist id="epic-models">{h?.models.map((m) => <option key={m} value={m} />)}</datalist>
            </label>
            {bd.running
              ? <button className="btn" onClick={() => act(call('stopBreakdown', epic.id))}>■ Stop</button>
              : <button className="btn-primary" disabled={!description.trim()} onClick={breakDown}>✨ Break down</button>}
          </div>
          <p className="mt-1 text-xs text-neutral-500">Runs a read-only agent session in the repository. You review the proposed tasks before anything is created.</p>
          {bd.error && <div className="mt-2 rounded bg-red-50 p-2 text-sm whitespace-pre-wrap text-red-700 dark:bg-red-950 dark:text-red-300">{bd.error}</div>}
          {(bd.running || bd.events.length > 0) && (
            <details open={bd.running} className="mt-2 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
              <summary className="cursor-pointer px-3 py-1.5 text-xs">Session {bd.running ? '● live' : ''}</summary>
              <Transcript events={bd.events} live={bd.running} />
            </details>
          )}
        </section>

        {draft && (
          <section className="rounded-md border border-indigo-300 p-3 dark:border-indigo-800">
            <div className="mb-2 flex items-center">
              <span className="flex-1 text-sm font-semibold">Proposed tasks ({draft.length})</span>
              <button className="btn mr-2" onClick={() => setDraft([...draft, { title: '', description: '', blockedBy: [] }])}>+ Add</button>
              <button className="btn mr-2" onClick={() => act(call('discardDraft', epic.id)).then(() => setDraft(null))}>Discard</button>
              <button className="btn-primary" onClick={approve}>Create {draft.filter((t) => t.title.trim()).length} tasks</button>
            </div>
            <ol className="flex flex-col gap-2">
              {draft.map((t, i) => (
                <li key={i} className="rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
                  <div className="flex items-center gap-2">
                    <span className="w-6 text-right text-xs text-neutral-500">{i + 1}.</span>
                    <input className="input" value={t.title} placeholder="Task title" onChange={(e) => setRow(i, { title: e.target.value })} />
                    <button className="text-neutral-500 hover:text-red-600" title="Remove" onClick={() => removeRow(i)}>✕</button>
                  </div>
                  <textarea className="input mt-1 h-16 text-xs" value={t.description} placeholder="Description"
                    onChange={(e) => setRow(i, { description: e.target.value })} />
                  {i > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                      Blocked by:
                      {draft.slice(0, i).map((b, j) => (
                        <label key={j} className="flex items-center gap-1">
                          <input type="checkbox" checked={t.blockedBy.includes(j)}
                            onChange={(e) => setRow(i, { blockedBy: e.target.checked ? [...t.blockedBy, j] : t.blockedBy.filter((x) => x !== j) })} />
                          {j + 1}. {b.title.slice(0, 30) || '…'}
                        </label>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </Modal>
  )
}
