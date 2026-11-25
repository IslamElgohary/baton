import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { Permission, SessionEvent } from '../shared/types'
import type { Harness } from './harnesses/types'

export type Spawn = (bin: string, args: string[], opts: SpawnOptions) => ChildProcess

/** Instructions appended to a session's first turn: how the agent reports back. Harness-agnostic. */
export function protocol({ questions }: { questions: boolean }): string {
  return `

---
How this session works (you are running inside a kanban app, not a chat):
- Keep working until this step is completely finished. Then end your final reply with a line containing only [DONE].
  If it cannot be done, end your reply with a line starting with [FAILED] followed by the reason.
${questions
    ? `- If you need a decision or information from the user, end your reply with a line containing only [QUESTION],
  followed by your question. Your session pauses until the user answers; the answer arrives as the next message.`
    : '- Nobody can answer questions in this step: make reasonable assumptions and state them.'}
- To save a document for the user and for later steps (plan, report, notes, diagram…), put it in your reply as:
<artifact name="plan.md">
…full content…
</artifact>
  Saving again with the same name replaces it. Artifacts are stored by the app, not in the repository.`
}

/** Sent when a turn ends without a marker (early reply, background work, blocked tool…). */
export const CONTINUE_PROMPT =
  'Continue working on this step. If background tasks or subagents are still running, wait for them and use their results. ' +
  'When everything is finished, end your reply with a line containing only [DONE] ([FAILED] <reason> if it cannot be done, ' +
  'or [QUESTION] followed by your question if you need the user and questions are allowed).'

export type Marker = { type: 'done' | 'failed' | 'question'; text: string }

/** The [DONE] / [FAILED] / [QUESTION] marker at the end of a reply; null if there is none yet. */
export function markerOf(response: string): Marker | null {
  const trimEnd = (s: string) => s.replace(/[`*_\s]+$/, '')
  const t = trimEnd(response.trim())
  if (t.endsWith('[DONE]')) return { type: 'done', text: trimEnd(t.slice(0, -6)).trim() }
  const f = t.lastIndexOf('[FAILED]')
  if (f >= 0 && !t.slice(f).includes('\n')) {
    return { type: 'failed', text: [t.slice(0, f).trim(), t.slice(f + 8).trim()].filter(Boolean).join('\n') || 'Agent reported failure' }
  }
  const q = t.lastIndexOf('[QUESTION]')
  if (q >= 0 && t.slice(q + 10).trim()) return { type: 'question', text: t.slice(q + 10).replace(/^[\s:*`_]+/, '').trim() }
  return null
}

const ARTIFACT = /<artifact\s+name\s*=\s*"([^"]+)"\s*>\n?([\s\S]*?)\n?<\/artifact>/g
const safeName = (n: string) => n.trim().replace(/[^\w.-]+/g, '-').slice(0, 100) || 'artifact'

/** Pull `<artifact name="…">…</artifact>` blocks out of a reply; the rest keeps a `[artifact: name]` stub. */
export function extractArtifacts(text: string): { artifacts: { name: string; content: string }[]; rest: string } {
  const artifacts = [...text.matchAll(ARTIFACT)].map((m) => ({ name: safeName(m[1]), content: m[2] }))
  return { artifacts, rest: text.replace(ARTIFACT, (_, n: string) => `[artifact: ${safeName(n)}]`) }
}

const killGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (pid) try { process.kill(-pid, signal) } catch { /* already gone */ }
}

export interface SessionSpec {
  harness: Harness
  bin: string
  cwd: string
  model: string
  permission: Permission
  /** Harness session id to continue. */
  resume?: string
  firstTurn: string
  maxTurns: number
  idleMs: number
  spawn: Spawn
  onEvent: (e: SessionEvent) => void
  onSessionId: (id: string) => void
  onArtifact: (a: { name: string; content: string }) => void
}

/**
 * Drive one harness session: send the first turn, keep it going with CONTINUE_PROMPT until the
 * agent replies with a marker (or maxTurns), then close stdin so the process exits.
 * `result` resolves once the process is gone. A question ends the session too (it's resumable).
 */
export function startSession(s: SessionSpec): { kill: (reason: string) => void; forceKill: () => void; result: Promise<Marker> } {
  const child = s.spawn(s.bin, s.harness.sessionArgs({ model: s.model, permission: s.permission, resume: s.resume }), {
    cwd: s.cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true // own process group, so kill(-pid) takes its children too
  })
  child.stdin!.on('error', () => { /* process died; 'close' reports it */ })

  let killReason: string | null = null
  let exited = false
  child.on('exit', () => { exited = true })
  const kill = (reason: string) => {
    killReason ??= reason
    if (exited) return // pid may already belong to another process
    killGroup(child.pid, 'SIGTERM')
    setTimeout(() => { if (!exited) killGroup(child.pid, 'SIGKILL') }, 5000).unref()
  }

  let idle: NodeJS.Timeout | undefined
  const touch = () => {
    clearTimeout(idle)
    idle = setTimeout(() => kill(`No output for ${Math.round(s.idleMs / 60_000)} min — killed`), s.idleMs)
  }

  let turns = 0
  let turnText = '' // everything the agent wrote this turn (artifacts may be in any message)
  let outcome: Marker | null = null
  const send = (text: string) => {
    turns++
    turnText = ''
    s.onEvent({ kind: 'user', text })
    child.stdin!.write(s.harness.encodeTurn(text) + '\n')
    touch()
  }
  const end = (o: Marker) => {
    if (outcome) return
    outcome = o
    if (o.type === 'question') s.onEvent({ kind: 'question', text: o.text })
    child.stdin!.end()
    setTimeout(() => { if (!exited) killGroup(child.pid, 'SIGTERM') }, 30_000).unref()
  }
  const onTurnEnd = (e: Extract<SessionEvent, { kind: 'turn_end' }>) => {
    if (outcome || killReason) return
    // Artifacts may be in streamed messages or only in the final reply: take both, last version per name.
    const saved = new Map(extractArtifacts(turnText + '\n' + e.response).artifacts.map((x) => [x.name, x]))
    for (const x of saved.values()) {
      s.onArtifact(x)
      s.onEvent({ kind: 'artifact', name: x.name })
    }
    if (!e.ok && e.error) return end({ type: 'failed', text: e.error })
    const m = markerOf(extractArtifacts(e.response).rest || extractArtifacts(turnText).rest)
    if (m) return end(m)
    if (turns >= s.maxTurns) {
      return end({ type: 'failed', text: `Not finished after ${turns} turns. Last reply:\n${e.response.trim() || '(empty)'}` })
    }
    send(CONTINUE_PROMPT)
  }

  const parser = s.harness.parser()
  let buf = ''
  const onLine = (l: string) => {
    if (!l.trim()) return
    for (const e of parser.line(l)) {
      if (e.kind === 'session') { s.onSessionId(e.id); continue }
      if (e.kind === 'reply') { if (!outcome) child.stdin!.write(e.line + '\n'); continue }
      if (e.kind === 'text') turnText += e.text
      s.onEvent(e)
      if (e.kind === 'turn_end') onTurnEnd(e)
    }
  }
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    touch()
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop()!
    lines.forEach(onLine)
  })
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    touch()
    if (stderr.length < 64_000) stderr += chunk
    s.onEvent({ kind: 'info', text: chunk.trimEnd() })
  })

  for (const line of s.harness.startup ?? []) child.stdin!.write(line + '\n')
  send(s.firstTurn)
  const result = new Promise<number | null>((resolve) => {
    child.on('error', (e) => { stderr += e.message; resolve(null) })
    child.on('close', (c) => resolve(c))
    // 'close' waits for every holder of the pipes; a helper the CLI left running can hold them forever.
    child.on('exit', () => setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy() }, 3000).unref())
  }).then((code): Marker => {
    clearTimeout(idle)
    onLine(buf)
    return outcome ?? {
      type: 'failed',
      text: killReason ?? (stderr.trim() || `Session ended (exit code ${code}) before the step was finished`)
    }
  })
  /** SIGKILL right now (app quitting: the delayed SIGKILL in kill() would never fire). */
  const forceKill = () => { if (!exited) killGroup(child.pid, 'SIGKILL') }
  return { kill, forceKill, result }
}
