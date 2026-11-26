import { DatabaseSync } from 'node:sqlite'
import type { Artifact, Board, BoardData, Column, DraftTask, Epic, FinishMode, Run, SessionEvent, Settings, Task, TaskStatus, Trigger } from '../shared/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, repo_path TEXT NOT NULL, base_branch TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL, position INTEGER NOT NULL, is_done INTEGER NOT NULL DEFAULT 0, trigger_json TEXT);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  column_id INTEGER NOT NULL REFERENCES columns(id), position INTEGER NOT NULL, epic_id INTEGER,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  branch TEXT, worktree_path TEXT, status TEXT NOT NULL DEFAULT 'idle');
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  column_id INTEGER NOT NULL, harness TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT,
  ok INTEGER, summary TEXT, session_id TEXT, question TEXT);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL, column_id INTEGER NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (task_id, name));
CREATE TABLE IF NOT EXISTS epics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#6366f1', draft_json TEXT);
CREATE TABLE IF NOT EXISTS task_deps (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_by_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, blocked_by_id));
`
/**
 * Schema upgrades, applied in order. `PRAGMA user_version` records how many have run; each runs once, in a
 * transaction. Append new steps — never edit or reorder old ones. Steps use addColumn (add-if-missing) because
 * databases from before versioning may already have some of these columns.
 */
type Step = (h: { exec: (sql: string) => void; addColumn: (table: string, col: string, def: string) => boolean; all: (sql: string) => Row[] }) => void
const STEPS: Step[] = [
  // 1: columns added during early development
  ({ exec, addColumn }) => {
    addColumn('runs', 'session_id', 'TEXT')
    addColumn('runs', 'question', 'TEXT')
    addColumn('tasks', 'epic_id', 'INTEGER')
    addColumn('boards', 'finish_mode', "TEXT NOT NULL DEFAULT 'merge'")
    addColumn('columns', 'finish_on_enter', 'INTEGER NOT NULL DEFAULT 0')
    for (const c of ['merged_at', 'pr_url', 'finish_error', 'merge_base']) addColumn('tasks', c, 'TEXT')
    // Tasks that already have blockers auto-start once unblocked.
    if (addColumn('tasks', 'auto_start', 'INTEGER NOT NULL DEFAULT 0')) exec('UPDATE tasks SET auto_start = 1 WHERE id IN (SELECT task_id FROM task_deps)')
  },
  // 2: session events in their own table (appending to one text blob rewrote it per streamed chunk)
  ({ exec, all }) => {
    exec(`CREATE TABLE IF NOT EXISTS run_events (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE, event TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS run_events_run ON run_events (run_id, id);`)
    const hasBlob = all('PRAGMA table_info(runs)').some((c) => c.name === 'events')
    if (hasBlob) {
      exec(`WITH RECURSIVE split(run_id, line, rest) AS (
              SELECT id, '', events || char(10) FROM runs WHERE events != ''
              UNION ALL
              SELECT run_id, substr(rest, 1, instr(rest, char(10)) - 1), substr(rest, instr(rest, char(10)) + 1) FROM split WHERE rest != '')
            INSERT INTO run_events (run_id, event) SELECT run_id, line FROM split WHERE line != '';
            UPDATE runs SET events = '';`)
    }
  },
  // 3: the run queue lives in the database (it used to be in memory, so a queued answer was lost on restart)
  ({ addColumn }) => {
    addColumn('tasks', 'queued_at', 'INTEGER')
    addColumn('tasks', 'queued_resume', 'INTEGER NOT NULL DEFAULT 0')
    addColumn('tasks', 'queued_message', 'TEXT')
  },
  // 4: archived cards: hidden from their (done) column and out of its ordering, still resolving dependents
  ({ addColumn }) => { addColumn('tasks', 'archived_at', 'TEXT') }
]

/**
 * The task lifecycle: which status may follow which. Only the runner changes statuses (and recover(), after a
 * restart: running → failed). queued = waiting for a free slot (or for its blockers); waiting = paused on a question.
 */
const NEXT_STATUS: Record<TaskStatus, TaskStatus[]> = {
  idle: ['queued'],
  queued: ['queued', 'running', 'idle'], // started; or moved to a column without a trigger, or stopped
  running: ['queued', 'idle', 'waiting', 'succeeded', 'failed'], // moved while running; or a session result
  waiting: ['queued', 'idle', 'failed'], // answered (or run again); moved away; stopped
  succeeded: ['queued'],
  failed: ['queued']
}

/** SQL: task `x` no longer holds up its dependents — its latest session succeeded, or it sits in a done column. */
const resolved = (x: string) => `(${x}.status = 'succeeded' OR (SELECT is_done FROM columns WHERE id = ${x}.column_id) = 1)`
/** SQL: a blocker of task `t` that isn't resolved yet. The one definition of "blocked", for the runner and the UI. */
const UNRESOLVED_BLOCKER = `SELECT 1 FROM task_deps d JOIN tasks b ON b.id = d.blocked_by_id WHERE d.task_id = t.id AND NOT ${resolved('b')}`

/** Tasks with their artifact count, blockers, and blocked/resolved state. */
const TASKS = `SELECT t.*, (SELECT count(*) FROM artifacts a WHERE a.task_id = t.id) AS artifacts,
  (SELECT group_concat(blocked_by_id) FROM task_deps d WHERE d.task_id = t.id) AS blocked_by,
  EXISTS (${UNRESOLVED_BLOCKER}) AS blocked, ${resolved('t')} AS resolved FROM tasks t`

const DEFAULT_SETTINGS: Settings = {
  maxConcurrency: 3, idleTimeoutMin: 10, maxTurns: 8, binPaths: {},
  notifications: { question: true, done: true, failed: true, finished: true }
}

/** Default columns for a new board. Triggers use `harness` (the first registered one). Each ⚡ column sends successes to the next column. */
function defaultColumns(harness: string): { name: string; is_done?: number; trigger?: Trigger }[] {
  const t = (permission: Trigger['permission'], prompt: string): Trigger =>
    ({ harness, model: '', permission, prompt, onSuccess: null, onFailure: null })
  return [
    { name: 'Backlog' },
    { name: 'Plan', trigger: t('read',
      'Task: {{task.title}}\n\n{{task.description}}\n\nInvestigate the repository and write a concise, step-by-step implementation plan for this task. Save the full plan as an artifact named plan.md. Ask me if a requirement is unclear.') },
    { name: 'Build', trigger: t('full',
      'Task: {{task.title}}\n\n{{task.description}}\n\nPlan (artifact plan.md, may be empty):\n{{artifact.plan.md}}\n\nNotes from the previous step:\n{{prev.summary}}\n\nImplement the task in this repository. Commit your changes with a clear message, then summarize what you changed.') },
    { name: 'Review', trigger: t('read',
      'Task: {{task.title}}\n\n{{task.description}}\n\nReview these changes (branch {{branch}} vs {{base}}). Read the surrounding code as needed. Report bugs, risks and missing pieces concisely.\n\n{{diff}}') },
    { name: 'Done', is_done: 1 }
  ]
}

type Row = Record<string, unknown>

export function createDb(file: string) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)
  {
    const all = (sql: string) => db.prepare(sql).all() as Row[]
    const addColumn = (table: string, col: string, def: string) => {
      if (all(`PRAGMA table_info(${table})`).some((c) => c.name === col)) return false
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
      return true
    }
    const exec = (sql: string) => db.exec(sql)
    for (let v = Number((db.prepare('PRAGMA user_version').get() as Row).user_version); v < STEPS.length; v++) {
      db.exec('BEGIN')
      try { STEPS[v]({ exec, addColumn, all }); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }
    }
  }

  /** Reset on-success/on-failure routes that point at deleted columns to "stay". */
  function clearDanglingRoutes() {
    const exists = new Set((db.prepare('SELECT id FROM columns').all() as { id: number }[]).map((r) => r.id))
    for (const c of db.prepare('SELECT id, trigger_json FROM columns WHERE trigger_json IS NOT NULL').all() as { id: number; trigger_json: string }[]) {
      const t = JSON.parse(c.trigger_json) as Trigger
      const fixed = { ...t, onSuccess: t.onSuccess && exists.has(t.onSuccess) ? t.onSuccess : null, onFailure: t.onFailure && exists.has(t.onFailure) ? t.onFailure : null }
      if (fixed.onSuccess !== t.onSuccess || fixed.onFailure !== t.onFailure)
        db.prepare('UPDATE columns SET trigger_json = ? WHERE id = ?').run(JSON.stringify(fixed), c.id)
    }
  }
  clearDanglingRoutes() // DBs from builds that left them behind

  const all = <T>(sql: string, ...p: (string | number | null)[]) => db.prepare(sql).all(...p) as T[]
  const get = <T>(sql: string, ...p: (string | number | null)[]) => db.prepare(sql).get(...p) as T | undefined
  const run = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).run(...p)
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN')
    try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  // Drops legacy columns (the old events blob, log, prompt).
  const toRun = ({ events: _blob, log: _log, prompt: _prompt, ...r }: Row): Run => r as unknown as Run
  const toTask = (r: Row): Task => ({
    ...r, blocked_by: r.blocked_by ? String(r.blocked_by).split(',').map(Number) : [], blocked: !!r.blocked, resolved: !!r.resolved
  }) as Task
  const toEpic = ({ draft_json, ...e }: Row): Epic => ({ ...e, draft: draft_json ? JSON.parse(draft_json as string) : null }) as Epic
  const blockersOf = (taskId: number) =>
    all<{ blocked_by_id: number }>('SELECT blocked_by_id FROM task_deps WHERE task_id = ?', taskId).map((r) => r.blocked_by_id)
  const toColumn = ({ trigger_json, ...c }: Row): Column =>
    ({ ...c, trigger: trigger_json ? JSON.parse(trigger_json as string) : null }) as Column
  const renumber = (table: 'columns' | 'tasks', ids: number[]) =>
    ids.forEach((id, i) => run(`UPDATE ${table} SET position = ? WHERE id = ?`, i, id))
  /** The column's cards in order. Archived cards aren't in the ordering (the board hides them). */
  const taskIds = (columnId: number) =>
    all<{ id: number }>('SELECT id FROM tasks WHERE column_id = ? AND archived_at IS NULL ORDER BY position', columnId).map((r) => r.id)
  const columnIds = (boardId: number) =>
    all<{ id: number }>('SELECT id FROM columns WHERE board_id = ? ORDER BY position', boardId).map((r) => r.id)
  const mustTask = (id: number) => {
    const t = get<Row>(`${TASKS} WHERE t.id = ?`, id)
    if (!t) throw new Error(`Task ${id} not found`)
    return toTask(t)
  }

  return {
    close: () => db.close(),

    // settings
    getSettings(): Settings {
      const row = get<{ value: string }>("SELECT value FROM settings WHERE key = 'app'")
      const saved: Partial<Settings> = row ? JSON.parse(row.value) : {}
      return { ...DEFAULT_SETTINGS, ...saved, notifications: { ...DEFAULT_SETTINGS.notifications, ...saved.notifications } }
    },
    /** Missing keys fall back to the defaults. */
    saveSettings(s: Partial<Settings>) {
      run("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify(s))
    },

    // boards
    listBoards: () => all<Board>('SELECT * FROM boards ORDER BY id'),
    getBoard(id: number): BoardData {
      const board = get<Board>('SELECT * FROM boards WHERE id = ?', id)
      if (!board) throw new Error(`Board ${id} not found`)
      return {
        board,
        columns: all<Row>('SELECT * FROM columns WHERE board_id = ? ORDER BY position', id).map(toColumn),
        tasks: all<Row>(`${TASKS} WHERE t.board_id = ? ORDER BY t.column_id, t.position`, id).map(toTask),
        epics: all<Row>('SELECT * FROM epics WHERE board_id = ? ORDER BY id', id).map(toEpic)
      }
    },
    createBoard(name: string, repoPath: string, baseBranch: string, defaultHarness: string, finishMode: FinishMode = 'merge'): number {
      return tx(() => {
        const id = Number(run('INSERT INTO boards (name, repo_path, base_branch, finish_mode) VALUES (?, ?, ?, ?)',
          name, repoPath, baseBranch, finishMode).lastInsertRowid)
        const cols = defaultColumns(defaultHarness)
        // The done column finishes cards that reach it.
        const ids = cols.map((c, i) => Number(run('INSERT INTO columns (board_id, name, position, is_done, finish_on_enter) VALUES (?, ?, ?, ?, ?)',
          id, c.name, i, c.is_done ?? 0, c.is_done ?? 0).lastInsertRowid))
        // Chain the pipeline: on success, each ⚡ column moves the card to the next column (… → Review → Done).
        cols.forEach((c, i) => {
          if (c.trigger) run('UPDATE columns SET trigger_json = ? WHERE id = ?', JSON.stringify({ ...c.trigger, onSuccess: ids[i + 1] ?? null }), ids[i])
        })
        return id
      })
    },
    renameBoard: (id: number, name: string) => void run('UPDATE boards SET name = ? WHERE id = ?', name, id),
    updateBoardBase: (id: number, branch: string) => void run('UPDATE boards SET base_branch = ? WHERE id = ?', branch, id),
    setFinishMode: (id: number, mode: FinishMode) => void run('UPDATE boards SET finish_mode = ? WHERE id = ?', mode, id),
    deleteBoard: (id: number) => tx(() => {
      run('DELETE FROM tasks WHERE board_id = ?', id) // tasks reference columns; delete them first
      run('DELETE FROM boards WHERE id = ?', id)
    }),

    // columns
    getColumn(id: number): Column | undefined {
      const r = get<Row>('SELECT * FROM columns WHERE id = ?', id)
      return r && toColumn(r)
    },
    addColumn(boardId: number, name: string): number {
      const pos = columnIds(boardId).length
      return Number(run('INSERT INTO columns (board_id, name, position) VALUES (?, ?, ?)', boardId, name, pos).lastInsertRowid)
    },
    updateColumn(id: number, patch: { name?: string; is_done?: number; finish_on_enter?: number; trigger?: Trigger | null }) {
      if (patch.name !== undefined) run('UPDATE columns SET name = ? WHERE id = ?', patch.name, id)
      if (patch.is_done !== undefined) run('UPDATE columns SET is_done = ? WHERE id = ?', patch.is_done ? 1 : 0, id)
      if (patch.finish_on_enter !== undefined) run('UPDATE columns SET finish_on_enter = ? WHERE id = ?', patch.finish_on_enter ? 1 : 0, id)
      if (patch.trigger !== undefined)
        run('UPDATE columns SET trigger_json = ? WHERE id = ?', patch.trigger ? JSON.stringify(patch.trigger) : null, id)
    },
    deleteColumn(id: number) {
      if (get('SELECT 1 FROM tasks WHERE column_id = ?', id)) throw new Error('Move or delete the tasks in this column first (archived ones too)')
      tx(() => {
        const col = get<{ board_id: number }>('SELECT board_id FROM columns WHERE id = ?', id)
        run('DELETE FROM columns WHERE id = ?', id)
        if (col) renumber('columns', columnIds(col.board_id))
        clearDanglingRoutes() // other columns may route to the deleted one
      })
    },
    moveColumn(id: number, toIndex: number) {
      tx(() => {
        const col = get<{ board_id: number }>('SELECT board_id FROM columns WHERE id = ?', id)
        if (!col) throw new Error(`Column ${id} not found`)
        const ids = columnIds(col.board_id).filter((x) => x !== id)
        ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, id)
        renumber('columns', ids)
      })
    },

    // tasks
    getTask: mustTask,
    createTask(boardId: number, columnId: number, title: string, description = ''): number {
      if (get<{ board_id: number }>('SELECT board_id FROM columns WHERE id = ?', columnId)?.board_id !== boardId)
        throw new Error('Column is not on this board')
      return Number(run('INSERT INTO tasks (board_id, column_id, position, title, description) VALUES (?, ?, ?, ?, ?)',
        boardId, columnId, taskIds(columnId).length, title, description).lastInsertRowid)
    },
    updateTask(id: number, patch: { title?: string; description?: string; epic_id?: number | null }) {
      if (patch.title !== undefined) run('UPDATE tasks SET title = ? WHERE id = ?', patch.title, id)
      if (patch.description !== undefined) run('UPDATE tasks SET description = ? WHERE id = ?', patch.description, id)
      if (patch.epic_id !== undefined) {
        if (patch.epic_id !== null && get<{ board_id: number }>('SELECT board_id FROM epics WHERE id = ?', patch.epic_id)?.board_id !== mustTask(id).board_id)
          throw new Error('Epic is not on this board')
        run('UPDATE tasks SET epic_id = ? WHERE id = ?', patch.epic_id, id)
      }
    },

    // dependencies
    /** Replace a task's blockers. Refuses other boards and cycles. */
    setBlockers(taskId: number, ids: number[]) {
      const t = mustTask(taskId)
      const unique = [...new Set(ids)]
      for (const b of unique) {
        if (b === taskId) throw new Error('A task cannot block itself')
        if (mustTask(b).board_id !== t.board_id) throw new Error('Blocker is on another board')
        // Cycle: taskId must not be reachable from b by following blocked_by edges.
        const seen = new Set<number>()
        const stack = [b]
        while (stack.length) {
          const x = stack.pop()!
          if (x === taskId) throw new Error(`"${mustTask(b).title}" already depends on this task`)
          if (!seen.has(x)) { seen.add(x); stack.push(...blockersOf(x)) }
        }
      }
      tx(() => {
        run('DELETE FROM task_deps WHERE task_id = ?', taskId)
        for (const b of unique) run('INSERT INTO task_deps (task_id, blocked_by_id) VALUES (?, ?)', taskId, b)
        run('UPDATE tasks SET auto_start = ? WHERE id = ?', unique.length ? 1 : 0, taskId) // a blocked task starts when unblocked
      })
    },
    /** True while any blocker is unresolved. */
    isBlocked: (taskId: number) => !!get(`SELECT 1 FROM tasks t WHERE t.id = ? AND EXISTS (${UNRESOLVED_BLOCKER})`, taskId),
    /**
     * Auto-start tasks ready to go: no unresolved blocker, parked in a column without a trigger (not a done
     * column), and not already queued/running/waiting.
     */
    readyToAdvance: () => all<{ id: number }>(
      `SELECT t.id FROM tasks t JOIN columns c ON c.id = t.column_id
       WHERE t.auto_start = 1 AND c.trigger_json IS NULL AND c.is_done = 0 AND t.status NOT IN ('queued', 'running', 'waiting')
         AND NOT EXISTS (${UNRESOLVED_BLOCKER})
       ORDER BY t.id`).map((r) => r.id),
    /** First column to the right of `position` that has a trigger. */
    nextTriggerColumn(boardId: number, position: number): Column | undefined {
      const r = get<Row>('SELECT * FROM columns WHERE board_id = ? AND position > ? AND trigger_json IS NOT NULL ORDER BY position LIMIT 1',
        boardId, position)
      return r && toColumn(r)
    },

    // epics
    getEpic(id: number): Epic | undefined {
      const r = get<Row>('SELECT * FROM epics WHERE id = ?', id)
      return r && toEpic(r)
    },
    createEpic(boardId: number, title: string, description: string, color: string): number {
      return Number(run('INSERT INTO epics (board_id, title, description, color) VALUES (?, ?, ?, ?)',
        boardId, title, description, color).lastInsertRowid)
    },
    updateEpic(id: number, patch: { title?: string; description?: string; color?: string }) {
      if (patch.title !== undefined) run('UPDATE epics SET title = ? WHERE id = ?', patch.title, id)
      if (patch.description !== undefined) run('UPDATE epics SET description = ? WHERE id = ?', patch.description, id)
      if (patch.color !== undefined) run('UPDATE epics SET color = ? WHERE id = ?', patch.color, id)
    },
    /** Tasks stay on the board, without an epic. */
    deleteEpic: (id: number) => tx(() => {
      run('UPDATE tasks SET epic_id = NULL WHERE epic_id = ?', id)
      run('DELETE FROM epics WHERE id = ?', id)
    }),
    setEpicDraft: (id: number, draft: DraftTask[] | null) =>
      void run('UPDATE epics SET draft_json = ? WHERE id = ?', draft ? JSON.stringify(draft) : null, id),
    /** Approve a breakdown: create its tasks (first column, in order) with their dependencies. Returns the new ids. */
    createTasksFromDraft(epicId: number, draft: DraftTask[]): number[] {
      /** Draft index `b` is a valid blocker of task `i`: an earlier task in the draft. */
      const earlier = (b: number, i: number) => Number.isInteger(b) && b >= 0 && b < i
      return tx(() => {
        const epic = get<{ board_id: number }>('SELECT board_id FROM epics WHERE id = ?', epicId)
        if (!epic) throw new Error(`Epic ${epicId} not found`)
        const first = columnIds(epic.board_id)[0]
        if (first === undefined) throw new Error('The board has no columns')
        const ids = draft.map((t, i) => Number(run(
          'INSERT INTO tasks (board_id, epic_id, column_id, position, title, description, auto_start) VALUES (?, ?, ?, ?, ?, ?, ?)',
          epic.board_id, epicId, first, taskIds(first).length, t.title, t.description,
          t.blockedBy.some((b) => earlier(b, i)) ? 1 : 0).lastInsertRowid))
        draft.forEach((t, i) => {
          for (const b of new Set(t.blockedBy)) {
            if (earlier(b, i)) run('INSERT INTO task_deps (task_id, blocked_by_id) VALUES (?, ?)', ids[i], ids[b])
          }
        })
        run('UPDATE epics SET draft_json = NULL WHERE id = ?', epicId)
        return ids
      })
    },
    // Internal fields, written by the runner and the finisher.
    /** Change a task's status; throws on a change the lifecycle doesn't allow (a bug). */
    setStatus(id: number, to: TaskStatus) {
      const from = mustTask(id).status
      if (!NEXT_STATUS[from].includes(to)) throw new Error(`Task ${id}: status can't change ${from} → ${to}`)
      run('UPDATE tasks SET status = ? WHERE id = ?', to, id)
    },
    setTaskState(id: number, patch: {
      branch?: string; worktree_path?: string | null
      merged_at?: string | null; merge_base?: string | null; pr_url?: string | null; finish_error?: string | null
      auto_start?: number
    }) {
      for (const [k, v] of Object.entries(patch)) run(`UPDATE tasks SET ${k} = ? WHERE id = ?`, v, id)
    },
    deleteTask(id: number) {
      tx(() => {
        const t = mustTask(id)
        run('DELETE FROM tasks WHERE id = ?', id)
        renumber('tasks', taskIds(t.column_id))
      })
    },
    /** Move a task to `columnId` at `index`; returns the column it came from. */
    moveTask(id: number, columnId: number, index: number): number {
      return tx(() => {
        const t = mustTask(id)
        const target = get<{ board_id: number }>('SELECT board_id FROM columns WHERE id = ?', columnId)
        if (!target || target.board_id !== t.board_id) throw new Error('Target column is not on this board')
        if (t.column_id !== columnId) renumber('tasks', taskIds(t.column_id).filter((x) => x !== id))
        const ids = taskIds(columnId).filter((x) => x !== id)
        ids.splice(Math.max(0, Math.min(index, ids.length)), 0, id)
        run('UPDATE tasks SET column_id = ?, archived_at = NULL WHERE id = ?', columnId, id) // moving restores an archived card
        renumber('tasks', ids)
        return t.column_id
      })
    },

    /** Archive a done column's cards (not ones with a session queued, running or waiting). Returns how many. */
    archiveDone(columnId: number): number {
      return tx(() => {
        const col = get<{ is_done: number }>('SELECT is_done FROM columns WHERE id = ?', columnId)
        if (!col?.is_done) throw new Error('Only a done column can be archived')
        const n = Number(run(`UPDATE tasks SET archived_at = datetime('now')
          WHERE column_id = ? AND archived_at IS NULL AND status NOT IN ('queued', 'running', 'waiting')`, columnId).changes)
        renumber('tasks', taskIds(columnId))
        return n
      })
    },

    // runs
    createRun(r: Pick<Run, 'task_id' | 'column_id' | 'harness' | 'model'>): number {
      // prompt '' keeps older DBs (prompt NOT NULL, no default) working
      return Number(run("INSERT INTO runs (task_id, column_id, harness, model, prompt) VALUES (?, ?, ?, ?, '')",
        r.task_id, r.column_id, r.harness, r.model).lastInsertRowid)
    },
    /** Reopen a finished session so "Run again" continues it. */
    reopenRun: (id: number) => void run('UPDATE runs SET ended_at = NULL, ok = NULL, summary = NULL WHERE id = ?', id),
    setRunSession: (id: number, sessionId: string) => void run('UPDATE runs SET session_id = ? WHERE id = ?', sessionId, id),
    appendEvent: (id: number, e: SessionEvent) => void run('INSERT INTO run_events (run_id, event) VALUES (?, ?)', id, JSON.stringify(e)),
    /** A session's transcript (kept off Run: listing runs must stay cheap however long the transcripts get). */
    runEvents: (id: number): SessionEvent[] =>
      all<{ event: string }>('SELECT event FROM run_events WHERE run_id = ? ORDER BY id', id).map((e) => JSON.parse(e.event) as SessionEvent),
    finishRun(id: number, ok: boolean, summary: string) {
      run("UPDATE runs SET ended_at = datetime('now'), ok = ?, summary = ? WHERE id = ?", ok ? 1 : 0, summary, id)
    },
    listRuns: (taskId: number): Run[] =>
      all<Row>('SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC', taskId).map(toRun),
    /** Latest session of a task in a column (for "Run again"). */
    lastRun(taskId: number, columnId: number): Run | undefined {
      const r = get<Row>('SELECT * FROM runs WHERE task_id = ? AND column_id = ? ORDER BY id DESC LIMIT 1', taskId, columnId)
      return r && toRun(r)
    },
    /** Pause/unpause a session on a question for the user. */
    setRunQuestion: (id: number, question: string | null) => void run('UPDATE runs SET question = ? WHERE id = ?', question, id),
    /** The session currently paused on a question, if any. */
    pendingRun(taskId: number): Run | undefined {
      const r = get<Row>('SELECT * FROM runs WHERE task_id = ? AND question IS NOT NULL AND ended_at IS NULL ORDER BY id DESC LIMIT 1', taskId)
      return r && toRun(r)
    },
    /** Close sessions that are open but not running (paused on a question). */
    closeOpenRuns(taskId: number, summary: string) {
      run("UPDATE runs SET ended_at = datetime('now'), ok = 0, summary = ?, question = NULL WHERE task_id = ? AND ended_at IS NULL",
        summary, taskId)
    },

    // artifacts
    saveArtifact(a: Pick<Artifact, 'task_id' | 'run_id' | 'column_id' | 'name' | 'content'>) {
      run(`INSERT INTO artifacts (task_id, run_id, column_id, name, content) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(task_id, name) DO UPDATE SET content = excluded.content, run_id = excluded.run_id,
             column_id = excluded.column_id, updated_at = datetime('now')`,
        a.task_id, a.run_id, a.column_id, a.name, a.content)
    },
    listArtifacts: (taskId: number) => all<Artifact>('SELECT * FROM artifacts WHERE task_id = ? ORDER BY name', taskId),

    lastSummary(taskId: number): string {
      return get<{ summary: string }>('SELECT summary FROM runs WHERE task_id = ? AND ok = 1 ORDER BY id DESC LIMIT 1',
        taskId)?.summary ?? ''
    },
    /** After a restart: close runs that were cut off. Queued tasks stay queued. */
    recover() {
      tx(() => {
        // Sessions paused on a question stay open: the answer resumes them.
        run("UPDATE runs SET ended_at = datetime('now'), ok = 0, summary = 'Interrupted (app closed)' WHERE ended_at IS NULL AND question IS NULL")
        run("UPDATE tasks SET status = 'failed' WHERE status = 'running'")
      })
    },

    // queue: tasks with status 'queued', first in first out
    /** `resume`: continue the column's last session; `message`: its first turn (the user's answer). */
    enqueue(taskId: number, resume: boolean, message: string | null = null) {
      mustTask(taskId) // every status may be queued (see NEXT_STATUS)
      run(`UPDATE tasks SET status = 'queued', queued_at = (SELECT COALESCE(MAX(queued_at), 0) + 1 FROM tasks),
           queued_resume = ?, queued_message = ? WHERE id = ?`, resume ? 1 : 0, message, taskId)
    },
    queued: () => all<{ id: number; queued_resume: number; queued_message: string | null }>(
      "SELECT id, queued_resume, queued_message FROM tasks WHERE status = 'queued' ORDER BY queued_at, id"
    ).map((r) => ({ taskId: r.id, resume: r.queued_resume === 1, message: r.queued_message ?? undefined }))
  }
}

export type Db = ReturnType<typeof createDb>
