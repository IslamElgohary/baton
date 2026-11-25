import type { Breakdown, DraftTask, PushEvent } from '../shared/types'
import type { Db } from './db'
import type { Harness } from './harnesses/types'
import { protocol, startSession, type Spawn } from './session'

export interface BreakdownDeps {
  db: Db
  harnesses: Harness[]
  resolveBin: (harnessId: string) => string | null
  spawn: Spawn
  push: (e: PushEvent) => void
}

export const DRAFT_ARTIFACT = 'tasks.json'

export function breakdownPrompt(title: string, description: string): string {
  return `Break this epic down into tasks for a kanban board.

Epic: ${title}

${description}

Investigate the repository as needed, then save an artifact named ${DRAFT_ARTIFACT} containing a JSON array of tasks:
[{"title": "…", "description": "…", "blockedBy": [<0-based indexes of EARLIER tasks in this array that must be finished first>]}]

Each task must be small enough for one agent to plan, build and review on its own branch. Give each a clear, testable
description. List tasks in the order they should be done; blockedBy may only point to earlier tasks.`
}

/** Drop rows without a title and remap blockedBy to the new positions (earlier tasks only, no duplicates). */
export function compactDraft(rows: DraftTask[]): DraftTask[] {
  const newIndex = new Map<number, number>()
  rows.forEach((t, i) => { if (t.title.trim()) newIndex.set(i, newIndex.size) })
  return rows.flatMap((t, i) => {
    const me = newIndex.get(i)
    if (me === undefined) return []
    const blockedBy = [...new Set(t.blockedBy.map((b) => newIndex.get(b)).filter((b): b is number => b !== undefined && b < me))]
    return [{ title: t.title.trim(), description: t.description.trim(), blockedBy }]
  })
}

/** Parse and sanitize a proposed task list. Returns null if it isn't a non-empty task array. */
export function parseDraft(text: string): DraftTask[] | null {
  let data: unknown
  try { data = JSON.parse(text) } catch {
    const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].at(-1)?.[1]
    if (!fenced) return null
    try { data = JSON.parse(fenced) } catch { return null }
  }
  if (!Array.isArray(data)) return null
  const tasks = compactDraft(data.map((t) => {
    const r = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
    return {
      title: typeof r.title === 'string' ? r.title : '',
      description: typeof r.description === 'string' ? r.description : '',
      blockedBy: Array.isArray(r.blockedBy) ? r.blockedBy.filter((b): b is number => Number.isInteger(b)) : []
    }
  }))
  return tasks.length ? tasks : null
}

/** "Break down" sessions: one read-only agent session per epic, in the board's repo. Live state kept in memory. */
export function createBreakdowns(d: BreakdownDeps) {
  const state = new Map<number, Breakdown & { kill?: (reason: string) => void; forceKill?: () => void }>()

  return {
    get(epicId: number): Breakdown {
      const s = state.get(epicId)
      return s ? { running: s.running, events: s.events, error: s.error } : { running: false, events: [], error: null }
    },

    start(epicId: number, harnessId: string, model: string) {
      if (state.get(epicId)?.running) throw new Error('A breakdown is already running for this epic')
      const epic = d.db.getEpic(epicId)
      if (!epic) throw new Error(`Epic ${epicId} not found`)
      if (!epic.description.trim()) throw new Error('Write a description for the epic first')
      const harness = d.harnesses.find((h) => h.id === harnessId)
      if (!harness) throw new Error(`Unknown harness "${harnessId}"`)
      const bin = d.resolveBin(harness.id)
      if (!bin) throw new Error(`${harness.name} CLI (${harness.bin}) not found. Check Settings.`)
      const { board } = d.db.getBoard(epic.board_id)
      const settings = d.db.getSettings()

      const s: Breakdown & { kill?: (reason: string) => void; forceKill?: () => void } = { running: true, events: [], error: null }
      state.set(epicId, s)
      const record = (event: Breakdown['events'][number]) => {
        s.events.push(event)
        d.push({ type: 'breakdown', epicId, event })
      }
      let draft: DraftTask[] | null = null
      record({ kind: 'info', text: `Started ${harness.name} session · ${model || 'default model'} · read-only · ${board.repo_path}` })
      const fail = (e: unknown) => {
        s.running = false
        s.error = e instanceof Error ? e.message : String(e)
        d.push({ type: 'changed' })
      }
      let session: ReturnType<typeof startSession>
      try { session = startSession({
        harness, bin, cwd: board.repo_path, model, permission: 'read', // read-only: safe in the main checkout
        firstTurn: breakdownPrompt(epic.title, epic.description) + (harness.promptNote?.('read') ?? '') + protocol({ questions: false }),
        maxTurns: settings.maxTurns,
        idleMs: Math.min(Math.max(1, settings.idleTimeoutMin) * 60_000, 2 ** 31 - 1),
        spawn: d.spawn,
        onEvent: record,
        onSessionId: () => {},
        onArtifact: (a) => { if (a.name === DRAFT_ARTIFACT) draft = parseDraft(a.content) ?? draft }
      }) } catch (e) { return fail(e) }
      s.kill = session.kill
      s.forceKill = session.forceKill
      d.push({ type: 'changed' })

      session.result.then((m) => {
        s.running = false
        if (m.type !== 'done') s.error = m.type === 'question' ? `The agent asked: ${m.text}\nAdd the answer to the epic description and try again.` : m.text
        else if (!(draft ??= parseDraft(m.text))) s.error = `The agent finished without a valid ${DRAFT_ARTIFACT} artifact.`
        else d.db.setEpicDraft(epicId, draft)
        d.push({ type: 'changed' })
      }).catch(fail)
    },

    stop(epicId: number) {
      const s = state.get(epicId)
      if (s?.running) s.kill?.('Stopped by user')
    },

    killAll({ force = false } = {}) {
      for (const s of state.values()) if (s.running) force ? s.forceKill?.() : s.kill?.('Interrupted (app closed)')
    },
    runningCount: () => [...state.values()].filter((s) => s.running).length
  }
}

export type Breakdowns = ReturnType<typeof createBreakdowns>
