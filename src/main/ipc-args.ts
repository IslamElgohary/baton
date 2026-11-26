import type { Api } from './api'

/**
 * Argument checks for every API method, run before the method on each IPC call. Renderer input is untrusted:
 * a malformed call fails with a clear error instead of reaching the database, git or an agent. The type below
 * makes TypeScript require an entry for every API method, so a new method can't skip validation.
 * (Deeper checks — triggers, settings, branch names — live in the methods themselves.)
 */
type Check = (v: unknown) => boolean

const MAX_TEXT = 200_000
const id: Check = (v) => Number.isSafeInteger(v) && (v as number) > 0
const index: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0
const flag: Check = (v) => v === 0 || v === 1
const str: Check = (v) => typeof v === 'string' && v.length <= MAX_TEXT
const bool: Check = (v) => typeof v === 'boolean'
const color: Check = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
const obj: Check = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const opt = (c: Check): Check => (v) => v === undefined || c(v)
const nullable = (c: Check): Check => (v) => v === null || c(v)
const oneOf = (...values: unknown[]): Check => (v) => values.includes(v)
const arrayOf = (c: Check, max = 1000): Check => (v) => Array.isArray(v) && v.length <= max && v.every(c)
/** Object with only these keys, each optional (a patch). */
const patch = (fields: Record<string, Check>): Check => (v) =>
  obj(v) && Object.entries(v as object).every(([k, x]) => Object.hasOwn(fields, k) && fields[k](x))
/** Object with exactly these keys. */
const shape = (fields: Record<string, Check>): Check => (v) =>
  obj(v) && Object.keys(v as object).every((k) => Object.hasOwn(fields, k)) &&
  Object.entries(fields).every(([k, c]) => c((v as Record<string, unknown>)[k]))

const draftTask = shape({ title: str, description: str, blockedBy: arrayOf(index) })

export const ARGS: { [K in keyof Api]: Check[] } = {
  // boards
  listBoards: [],
  getBoard: [id],
  newBoard: [],
  listBranches: [id],
  renameBoard: [id, str],
  updateBaseBranch: [id, str],
  setFinishMode: [id, oneOf('merge', 'pr')],
  deleteBoard: [id],
  // columns
  addColumn: [id, str],
  updateColumn: [id, patch({ name: str, is_done: flag, finish_on_enter: flag, trigger: nullable(obj) })],
  deleteColumn: [id],
  moveColumn: [id, index],
  // tasks
  createTask: [id, id, str, opt(str), opt(nullable(id))],
  updateTask: [id, patch({ title: str, description: str, epic_id: nullable(id) })],
  setBlockers: [id, arrayOf(id)],
  deleteTask: [id],
  moveTask: [id, id, index],
  archiveDone: [id],
  retryTask: [id],
  answerQuestion: [id, str],
  listArtifacts: [id],
  stopTask: [id],
  listRuns: [id],
  getRunEvents: [id],
  finishTask: [id],
  removeWorktree: [id],
  getChanges: [id],
  openPr: [id],
  openWorktree: [id],
  // epics
  createEpic: [id, str, opt(str), opt(color)],
  updateEpic: [id, patch({ title: str, description: str, color })],
  deleteEpic: [id],
  getBreakdown: [id],
  startBreakdown: [id, str, str],
  startBrainstorm: [id, str, str],
  answerBreakdown: [id, str],
  stopBreakdown: [id],
  discardDraft: [id],
  approveDraft: [id, arrayOf(draftTask)],
  // settings & harnesses
  getSettings: [],
  saveSettings: [obj],
  listHarnesses: [opt(bool)],
  loginHarness: [str]
}

/** Throws unless `name` is an API method and `args` pass its checks (no extra arguments). */
export function checkArgs(name: string, args: unknown[]): void {
  const checks = Object.hasOwn(ARGS, name) ? (ARGS as Record<string, Check[]>)[name] : undefined
  if (!checks) throw new Error(`Unknown method "${name}"`)
  if (args.length > checks.length || !checks.every((c, i) => c(args[i]))) throw new Error(`Invalid arguments for ${name}`)
}
