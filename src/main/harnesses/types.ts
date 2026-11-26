import type { Permission, SessionEvent } from '../../shared/types'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs the harness binary with `args` (no shell). */
export type RunBin = (args: string[]) => Promise<ExecResult>

export interface Probe {
  version: string | null
  loggedIn: boolean
  /** Human-readable auth status or error. */
  detail: string
  models: string[]
}

/**
 * What a harness parser emits: transcript events, plus the harness's own session id
 * (used to resume the session later).
 */
export type ParsedEvent =
  | SessionEvent
  | { kind: 'session'; id: string }
  /** A line to write back to the CLI's stdin, e.g. answering a dialog the CLI is blocked on. */
  | { kind: 'reply'; line: string }

/**
 * A local coding-agent CLI driven as a long-lived session: the app starts one process,
 * writes user turns to its stdin, and reads a JSON event stream from stdout.
 *
 * To add one: implement this in `harnesses/<id>.ts` and append it to `harnesses/index.ts`.
 */
export interface Harness {
  id: string
  name: string
  /** Default executable name, looked up on PATH unless overridden in Settings. */
  bin: string
  /** Extra environment variables for session processes. */
  env?: Record<string, string>
  /** Args for the interactive sign-in, opened in a new terminal window. */
  loginArgs: string[]
  probe(run: RunBin): Promise<Probe>
  /** Args that start a session process. `model` may be '' (harness default); `resume` continues an earlier session. */
  sessionArgs(o: { model: string; permission: Permission; resume?: string }): string[]
  /** Stdin lines sent once when the session process starts, before the first turn (e.g. asking for its session id). */
  startup?: string[]
  /** The stdin line that sends one user turn. */
  encodeTurn(text: string): string
  /** Harness-specific guidance appended to the first turn, e.g. how its read-only mode behaves. */
  promptNote?(permission: Permission): string
  /** One parser per session process: stdout line → events. Must emit `turn_end` when a turn finishes. */
  parser(): { line(line: string): ParsedEvent[] }
}
