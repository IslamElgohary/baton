# Architecture

Baton is an Electron app: a React renderer for the board, and a Node main process that owns the database, git and the agent processes. The renderer calls the main process over IPC.

```
src/shared/types.ts                 types shared by both sides
src/main/index.ts                   composition root: builds every module from real dependencies, IPC, window
src/main/api.ts                     createApi(deps): everything the renderer may call (each method = an IPC channel)
src/main/ipc-args.ts                argument checks for every API method, run before it on each IPC call
src/main/db.ts                      createDb(path): schema, versioned upgrades, queries (node:sqlite)
src/main/session.ts                 startSession(): drives one agent CLI session (turns, protocol, artifacts, kill)
src/main/runner.ts                  createRunner(deps): queue, per-task sessions, routing, dependencies, auto-start
src/main/breakdown.ts               createBreakdowns(deps): epic → draft task list via a read-only session
src/main/finish.ts                  createFinisher(deps): merge or PR, stacked PRs, worktree cleanup
src/main/git.ts                     createGit(exec): worktrees, merges, diffs, pushes
src/main/proc.ts                    exec without a shell, login-shell PATH, which
src/main/security.ts                isAppUrl(): what counts as the app's own page
src/main/harnesses/                 Harness interface, registry, and adapters (pi, Antigravity)
src/preload/index.ts                window.api.invoke(channel, …args) / on(event)
src/renderer/src/                   App, Board (dnd-kit), dialogs, Transcript, Settings
test/                               fake harness and captured CLI output used by the tests
e2e/                                tests against the real Antigravity CLI
```

**Dependency injection.** Every main-process module is a factory that receives its dependencies (`createRunner({ db, harnesses, git, spawn, … })`). Only `index.ts` wires the real ones. Tests pass fakes: an in-memory database, a scriptable fake harness (`test/fake-harness.ts`, a small Node program driven over stdin) and real git in temporary repositories.

## Data model

SQLite in the app's data folder. `db.ts` creates the base schema and then applies numbered upgrade steps, tracked with `PRAGMA user_version`. Append new steps; never edit old ones.

| Table | Holds |
|---|---|
| `boards` | repository path, base branch, finish mode (`merge` / `pr`) |
| `columns` | position, done flag, finish-on-enter flag, trigger (JSON: harness, model, permission, prompt, on-success / on-failure column) |
| `tasks` | column, position, epic, branch, worktree, status, finish state, auto-start flag |
| `task_deps` | blocked-by edges (no cycles; checked on write) |
| `epics` | title, description, color, pending breakdown draft |
| `runs` | one agent session: column, harness, model, harness session id, result, pending question |
| `run_events` | the session transcript, one normalized event per row |
| `artifacts` | documents agents saved, one per task and name |
| `settings` | parallel runs, idle timeout, max turns, binary path overrides |

## Sessions

A harness is driven as a **long-lived session**. Baton spawns the CLI once, writes user turns to its stdin and reads a JSON event stream from stdout. `session.ts` normalizes that stream into `SessionEvent`s (user turn, agent text, tool call with input and output, info, turn end, question, artifact).

The first turn is the column's rendered prompt, plus the harness's permission note, plus a short **protocol**:

- `[DONE]` or `[FAILED] <reason>` at the end of a reply ends the session.
- `[QUESTION] <text>` pauses it. The process exits and the session stays open. The user's answer resumes the same harness session (`--conversation <id>` for Antigravity).
- `<artifact name="…">…</artifact>` blocks are saved to the task.
- If a turn ends without a marker (an early reply, background work, a blocked tool), Baton sends a "continue" turn, up to the max-turns setting.

Each session runs in its own process group. Stop, card moves and idle timeouts send SIGTERM. Quitting the app sends SIGTERM, then SIGKILL to anything still running.

## Runner

`runner.ts` holds the active sessions (one per task). The queue is the database: tasks with status `queued`, first in first out, each with what to send when it starts (a fresh run, "Run again", or the user's answer).

1. **A card enters a ⚡ column.** It is queued. The queue starts tasks up to the parallel-runs limit, skipping blocked ones.
2. **A session starts.**
   - The task's worktree is created on first use. The branch and folder names are picked so they never collide with leftovers.
   - The blockers' branches are merged into the worktree.
   - The prompt is rendered.
3. **The session ends.**
   - The card moves to the column's on-success or on-failure column, if one is set. That move goes through step 1 again, which is how a pipeline chains.
   - A question pauses the card instead (status `waiting`).
4. **Dependencies resolve.** A blocker is resolved once its latest session succeeded or it sits in a done column.
   - Queued dependents start.
   - Dependents flagged *auto-start* (they were given blockers) move from a column without a trigger to the next ⚡ column.
5. **After a restart,** interrupted sessions are marked failed. Queued tasks (including answers not yet sent) start again, and sessions paused on a question stay paused.

## Finishing

`finish.ts` runs when a card enters a column with *finish on enter*, or from the card dialog. It goes in four steps:

1. **Commit** leftover changes in the worktree.
2. **Get the work into the base branch**, depending on the board's finish mode:
   - `merge`: a `--no-ff` merge in the user's main checkout, refused unless it is clean and on the base branch.
   - `pr`: push the branch, then reuse the open PR or run `gh pr create`. Epic tasks with unmerged blockers get **stacked PRs**: the PR targets the branch that holds the blockers' work, until that work reaches base.
3. **Remove** the worktree, keeping the branch.

Finishes are serialized per repository.

## Harnesses

`Harness` (`src/main/harnesses/types.ts`) is the extension point:

- `probe`: version, sign-in state and model list.
- `sessionArgs`: model, permission (`read` / `full`) and resume id.
- `startup`: optional stdin lines sent once at start (pi asks `get_state` for its session id).
- `encodeTurn`: how a user turn is written to stdin.
- `promptNote`: harness-specific guidance.
- `parser`: stdout line → events. It can also emit a `reply` line for the CLI's stdin, e.g. pi extension dialogs, which block until answered and are cancelled because nobody can answer in a headless session.

The read-only permission must be **enforced by the harness**, not just requested in the prompt, and must fail closed.

| Harness | Session | Turn ends on | Read-only |
|---|---|---|---|
| pi | `pi --mode rpc`; `{"type":"prompt"}` per turn; resume with `--session <id>` | `agent_settled` | `--tools read,grep,find,ls --no-mcp --no-approve` |
| Antigravity | `agy --print= --input-format stream-json`; resume with `--conversation <id>` | `result` | session settings denying `command(*)`, `write_file(*)`, `mcp(*)` |

## Security model

- The renderer only shows agent output as text. HTML artifacts render in a sandboxed `iframe` with no scripts, under the page's CSP.
- The window uses `contextIsolation` and `sandbox`, refuses to navigate away from the app's page or open new windows, and IPC calls from any other page are rejected.
- Every IPC call's arguments are checked against `ipc-args.ts` before the method runs: ids, types, allowed fields and enums. The table is typed against the API, so a new method can't be added without an entry. Inputs that reach git or the agents (triggers, settings, base branch) get deeper checks in `api.ts`.
- All processes are started with `execFile` / `spawn` and argument arrays, never a shell string.
- Only one app instance can use a given data folder.
