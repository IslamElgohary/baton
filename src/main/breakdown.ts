import type { Breakdown, DraftTask, PushEvent } from '../shared/types'
import type { Db } from './db'
import type { Harness } from './harnesses/types'
import { protocol, startSession, type Marker, type Spawn } from './session'

export interface BreakdownDeps {
  db: Db
  harnesses: Harness[]
  resolveBin: (harnessId: string) => string | null
  spawn: Spawn
  push: (e: PushEvent) => void
}

export const DRAFT_ARTIFACT = 'tasks.json'
export const EPIC_ARTIFACT = 'epic.md'

export function breakdownPrompt(title: string, description: string): string {
  return `Break this epic down into tasks for a kanban board.

Epic: ${title}

${description}

Investigate the repository as needed, then save an artifact named ${DRAFT_ARTIFACT} containing a JSON array of tasks:
[{"title": "…", "description": "…", "blockedBy": [<0-based indexes of EARLIER tasks in this array that must be finished first>]}]

Each task must be small enough for one agent to plan, build and review on its own branch. Give each a clear, testable
description. List tasks in the order they should be done; blockedBy may only point to earlier tasks.`
}

export function brainstormPrompt(title: string, description: string): string {
  return `Help the user define an epic for a kanban board through a focused conversation.

Epic: ${title}

${description.trim() || '(No description yet — work out the details with the user.)'}

Investigate the repository as needed so your questions are grounded in the real codebase. Ask the user clarifying
questions one round at a time using [QUESTION] to define the epic's goals, scope, and acceptance criteria. Ask only
what you need and wait for the answer before asking the next question.

When enough detail has been gathered, save the final epic specification as an artifact named ${EPIC_ARTIFACT}:
<artifact name="${EPIC_ARTIFACT}">
…the epic's goals, scope, what is out of scope, and acceptance criteria…
</artifact>

Then end with [DONE].`
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

/** Why a proposed task list can't be used, in words the agent can act on. */
export function draftProblem(text: string): string {
  try { JSON.parse(text) } catch (e) {
    return `it is not valid JSON (${(e as Error).message}). Escape double quotes inside strings as \\"`
  }
  return 'it must be a non-empty JSON array of tasks, each with a "title"'
}

type Mode = 'breakdown' | 'brainstorm'
type Qa = { question: string; answer: string }

interface EpicSession extends Breakdown {
  mode: Mode
  kill?: (reason: string) => void
  forceKill?: () => void
  sessionId: string | null
  harnessId: string
  model: string
  /** The prompt sent on the first turn (before the harness note and protocol), reused when no session id exists. */
  promptBase: string
  /** Questions and answers so far, for continuing without a resumable harness session. */
  qaHistory: Qa[]
  /** Latest usable tasks.json content. */
  draft: DraftTask[] | null
  /** Why the latest tasks.json artifact was rejected. */
  draftProblem: string
  /** Latest epic.md content saved by a brainstorm session. */
  epicArtifact: string | null
  /** Set when we kill the session: its result is then ignored, even if the agent had already finished. */
  stopped: string | null
}

/** "Break down" and brainstorm sessions: one read-only agent session per epic, in the board's repo. State in memory. */
export function createBreakdowns(d: BreakdownDeps) {
  const state = new Map<number, EpicSession>()
  const changed = () => d.push({ type: 'changed' })

  function fail(s: EpicSession, e: unknown) {
    s.running = false
    s.question = null
    s.error = e instanceof Error ? e.message : String(e)
    changed()
  }

  /** Continue a session with the user's answer, falling back to the whole Q&A history when it can't be resumed. */
  function answerTurn(s: EpicSession, answer: string): string {
    if (s.sessionId) return answer
    const history = s.qaHistory.length
      ? `\n\nHere is the conversation so far:\n${s.qaHistory.map((x, i) =>
        `Q${i + 1}: ${x.question}\nA${i + 1}: ${x.answer}`).join('\n\n')}`
      : ''
    const harness = d.harnesses.find((h) => h.id === s.harnessId)
    return s.promptBase + history + (harness?.promptNote?.('read') ?? '') + protocol({ questions: true })
  }

  /** Start one read-only turn and route its result back into the epic's session state. */
  function launch(epicId: number, s: EpicSession, firstTurn: string, resume?: string) {
    const harness = d.harnesses.find((h) => h.id === s.harnessId)
    if (!harness) return fail(s, new Error(`Unknown harness "${s.harnessId}"`))
    const bin = d.resolveBin(harness.id)
    if (!bin) return fail(s, new Error(`${harness.name} CLI (${harness.bin}) not found. Check Settings.`))
    const epic = d.db.getEpic(epicId)
    if (!epic) return fail(s, new Error(`Epic ${epicId} not found`))
    const { board } = d.db.getBoard(epic.board_id)
    const settings = d.db.getSettings()
    const record = (event: Breakdown['events'][number]) => {
      s.events.push(event)
      d.push({ type: 'breakdown', epicId, event })
    }

    let session: ReturnType<typeof startSession>
    try {
      session = startSession({
        harness, bin, cwd: board.repo_path, model: s.model, permission: 'read', // read-only: safe in the main checkout
        resume,
        firstTurn,
        maxTurns: settings.maxTurns,
        idleTimeoutMin: settings.idleTimeoutMin,
        spawn: d.spawn,
        onEvent: record,
        onSessionId: (id) => { s.sessionId = id },
        onArtifact: (a) => {
          if (s.mode === 'brainstorm') {
            if (a.name === EPIC_ARTIFACT) s.epicArtifact = a.content
            return
          }
          if (a.name !== DRAFT_ARTIFACT) return
          s.draft = parseDraft(a.content)
          if (!s.draft) s.draftProblem = draftProblem(a.content)
        },
        // Models sometimes write broken JSON or forget the artifact: tell the agent, in the same session.
        onDone: (summary) => {
          if (s.mode === 'brainstorm') {
            // Only epic.md counts: a closing remark ("All set!") must not replace the description.
            return s.epicArtifact?.trim()
              ? null
              : `The epic specification is still missing. Save the goals, scope, and acceptance criteria as ` +
                `<artifact name="${EPIC_ARTIFACT}">…</artifact>, then end with [DONE].`
          }
          s.draft ??= parseDraft(summary)
          return s.draft
            ? null
            : `The ${DRAFT_ARTIFACT} artifact can't be used: ${s.draftProblem}. Save the complete corrected list again as ` +
              `<artifact name="${DRAFT_ARTIFACT}">…</artifact>, then end with [DONE].`
        }
      })
    } catch (e) { return fail(s, e) }
    s.stopped = null
    s.kill = (reason) => { s.stopped ??= reason; session.kill(reason) }
    s.forceKill = session.forceKill
    changed()

    session.result.then((m: Marker) => {
      if (s.stopped) m = { type: 'failed', text: s.stopped }
      if (m.type === 'question') {
        // Keep the session (and its id) in memory: the user's answer resumes it.
        s.question = m.text
        s.error = null
        s.running = false
      } else if (m.type === 'done') {
        s.question = null
        s.running = false
        if (s.mode === 'breakdown') {
          s.draft ??= parseDraft(m.text)
          if (!s.draft) s.error = `The agent finished without a usable ${DRAFT_ARTIFACT}: ${s.draftProblem}.`
          else d.db.setEpicDraft(epicId, s.draft)
        } else {
          const description = s.epicArtifact?.trim()
          if (!description) s.error = `The agent finished without saving a usable ${EPIC_ARTIFACT} specification.`
          else d.db.updateEpic(epicId, { description })
        }
      } else {
        s.error = m.text
        s.question = null
        s.running = false
      }
      changed()
    }).catch((e) => fail(s, e))
  }

  function start(epicId: number, harnessId: string, model: string, mode: Mode) {
    if (state.get(epicId)?.running) throw new Error('A session is already running for this epic')
    if (state.get(epicId)?.question) throw new Error('The agent is waiting for an answer: answer or discard its question first')
    const epic = d.db.getEpic(epicId)
    if (!epic) throw new Error(`Epic ${epicId} not found`)
    if (mode === 'breakdown' && !epic.description.trim()) throw new Error('Write a description for the epic first')
    const harness = d.harnesses.find((h) => h.id === harnessId)
    if (!harness) throw new Error(`Unknown harness "${harnessId}"`)
    if (!d.resolveBin(harness.id)) throw new Error(`${harness.name} CLI (${harness.bin}) not found. Check Settings.`)
    const { board } = d.db.getBoard(epic.board_id)

    const s: EpicSession = {
      running: true, events: [], error: null, question: null, mode,
      sessionId: null, harnessId: harness.id, model,
      promptBase: mode === 'brainstorm' ? brainstormPrompt(epic.title, epic.description) : breakdownPrompt(epic.title, epic.description),
      qaHistory: [], draft: null, draftProblem: 'it was not saved', epicArtifact: null, stopped: null
    }
    state.set(epicId, s)
    recordStarted(epicId, s, harness, board.repo_path)
    launch(epicId, s, s.promptBase + (harness.promptNote?.('read') ?? '') + protocol({ questions: true }))
  }

  function recordStarted(epicId: number, s: EpicSession, harness: Harness, repo: string) {
    const event: Breakdown['events'][number] = {
      kind: 'info',
      text: `Started ${harness.name} ${s.mode === 'brainstorm' ? 'brainstorm' : 'breakdown'} session · ${s.model || 'default model'} · read-only · ${repo}`
    }
    s.events.push(event)
    d.push({ type: 'breakdown', epicId, event })
  }

  return {
    get(epicId: number): Breakdown {
      const s = state.get(epicId)
      return s
        ? { running: s.running, events: s.events, error: s.error, question: s.question, mode: s.mode }
        : { running: false, events: [], error: null, question: null }
    },

    start(epicId: number, harnessId: string, model: string) {
      start(epicId, harnessId, model, 'breakdown')
    },

    /** An interactive session that interviews the user, then saves the epic spec as epic.md. */
    startBrainstorm(epicId: number, harnessId: string, model: string) {
      start(epicId, harnessId, model, 'brainstorm')
    },

    /** Send the user's answer to a session paused on [QUESTION], resuming the same harness session when possible. */
    answer(epicId: number, text: string) {
      const s = state.get(epicId)
      if (!s) throw new Error('This epic has no session waiting for an answer')
      if (s.running) throw new Error('A session is already running for this epic')
      if (s.question === null) throw new Error('This epic is not waiting for an answer')
      const answer = text.trim()
      if (!answer) throw new Error('Write an answer first')
      // Check before clearing the question, so a failure leaves it there to answer again.
      const harness = d.harnesses.find((h) => h.id === s.harnessId)
      if (!harness) throw new Error(`Unknown harness "${s.harnessId}"`)
      if (!d.resolveBin(harness.id)) throw new Error(`${harness.name} CLI (${harness.bin}) not found. Check Settings.`)

      s.qaHistory.push({ question: s.question, answer })
      s.question = null
      s.error = null
      s.running = true
      changed()
      launch(epicId, s, answerTurn(s, answer), s.sessionId ?? undefined)
    },

    stop(epicId: number) {
      const s = state.get(epicId)
      if (!s) return
      if (s.running) s.kill?.('Stopped by user')
      else if (s.question !== null) {
        s.question = null
        changed()
      }
    },

    killAll({ force = false } = {}) {
      for (const s of state.values()) if (s.running) force ? s.forceKill?.() : s.kill?.('Interrupted (app closed)')
    },
    runningCount: () => [...state.values()].filter((s) => s.running).length
  }
}

export type Breakdowns = ReturnType<typeof createBreakdowns>
