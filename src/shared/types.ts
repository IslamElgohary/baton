export type Permission = 'read' | 'full'
export type TaskStatus = 'idle' | 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed'

export interface Trigger {
  harness: string
  model: string
  prompt: string
  permission: Permission
  onSuccess: number | null
  onFailure: number | null
}

/** How a finished task gets into the base branch: a local merge, a pull request, a pushed branch (publish), or
 * nothing at all (notify only). */
export type FinishMode = 'merge' | 'pr' | 'publish' | 'notify'

export interface Board {
  id: number
  name: string
  repo_path: string
  base_branch: string
  finish_mode: FinishMode
}

export interface Column {
  id: number
  board_id: number
  name: string
  position: number
  is_done: number
  /** 1 = finish cards that enter this column (merged, PR'd, published or just notified, per the board's finish mode). */
  finish_on_enter: number
  trigger: Trigger | null
}

export interface Task {
  id: number
  board_id: number
  epic_id: number | null
  column_id: number
  position: number
  title: string
  description: string
  branch: string | null
  worktree_path: string | null
  status: TaskStatus
  /** Number of artifacts saved for this task. */
  artifacts: number
  /** Ids of tasks that must be resolved before this task's trigger runs. */
  blocked_by: number[]
  /** A blocker is still unresolved (computed). */
  blocked: boolean
  /** No longer holds up dependents: its latest session succeeded, or it sits in a done column (computed). */
  resolved: boolean
  /** 1 = once unblocked, move to the next ⚡ column and start (cleared when that happens or you move the card). */
  auto_start: number
  /** Set once finished by a local merge. */
  merged_at: string | null
  /** Where the branch left base when it was merged (to still show its changes afterwards). */
  merge_base: string | null
  /** Set once finished by opening a pull request. */
  pr_url: string | null
  /** Set once finished by pushing the branch (publish mode). */
  published_at: string | null
  /** Set once a finish ran in notify mode: the card is done, nothing was merged, pushed or opened. */
  finished_at: string | null
  /** Why the last finish attempt failed (cleared on success). */
  finish_error: string | null
  /** Set when archived from a done column: hidden there, still resolves dependents. Moving the card clears it. */
  archived_at: string | null
  /** Something happened the user hasn't looked at yet (cleared when they open the card or it runs again). */
  attention: Attention | null
}

export type Attention = 'question' | 'done' | 'failed'

/** A board in the sidebar list, with how many of its cards want the user's attention. */
export interface BoardSummary extends Board {
  attention: number
  /** How many of those are questions (the agent is waiting for an answer). */
  questions: number
}

/** A task proposed by "Break down", before the user approves it. `blockedBy` = indexes into the draft. */
export interface DraftTask {
  title: string
  description: string
  blockedBy: number[]
}

export interface Epic {
  id: number
  board_id: number
  title: string
  description: string
  color: string
  /** Latest breakdown proposal awaiting approval. */
  draft: DraftTask[] | null
}

/** Live state of an epic's "Break down" or brainstorm session (kept in memory). */
export interface Breakdown {
  running: boolean
  events: SessionEvent[]
  error: string | null
  /** Set while the session is paused on a [QUESTION], waiting for `answer()`. */
  question: string | null
  mode?: 'brainstorm' | 'breakdown'
}

/** A document an agent saved for the user and later steps (plan, report…). Same name = replaced. */
export interface Artifact {
  id: number
  task_id: number
  run_id: number
  column_id: number
  name: string
  content: string
  updated_at: string
}

/** One entry of a session transcript, normalized across harnesses. */
export type SessionEvent =
  | { kind: 'user'; text: string } // a turn the app sent
  | { kind: 'text'; text: string } // assistant text (streamed in chunks)
  | { kind: 'thinking'; text: string } // assistant reasoning, when the harness streams it
  | { kind: 'tool'; id: string; name: string; input?: unknown; output?: string; done: boolean }
  | { kind: 'info'; text: string } // app notes, harness stderr
  | { kind: 'turn_end'; ok: boolean; response: string; error?: string }
  | { kind: 'question'; text: string } // agent is waiting for the user's answer
  | { kind: 'artifact'; name: string } // agent saved an artifact

/** A harness session for one task in one column. "Run again" continues the same session. Its transcript: getRunEvents. */
export interface Run {
  id: number
  task_id: number
  column_id: number
  harness: string
  model: string
  session_id: string | null
  started_at: string
  ended_at: string | null
  ok: number | null
  summary: string | null
  /** Set while the session is paused waiting for the user's answer. */
  question: string | null
}

export interface BoardData {
  board: Board
  columns: Column[]
  tasks: Task[]
  epics: Epic[]
}

export interface HarnessInfo {
  id: string
  name: string
  bin: string
  path: string | null
  version: string | null
  loggedIn: boolean
  authDetail: string
  models: string[]
}

/** Kinds of system notification, each switchable in Settings. */
export const NOTIFY_KINDS = ['question', 'done', 'failed', 'finished'] as const
export type NotifyKind = (typeof NOTIFY_KINDS)[number]

export interface Settings {
  maxConcurrency: number
  idleTimeoutMin: number
  /** Turns per session before giving up when the agent never reports [DONE]/[FAILED]. */
  maxTurns: number
  binPaths: Record<string, string>
  notifications: Record<NotifyKind, boolean>
}

/** Events pushed main → renderer. */
export type PushEvent =
  | { type: 'changed' }
  | { type: 'session'; runId: number; taskId: number; event: SessionEvent }
  | { type: 'breakdown'; epicId: number; event: SessionEvent }
