<p align="center"><img src="build/icon.png" width="128" alt="Baton icon"></p>

<h1 align="center">Baton</h1>

<p align="center">A kanban board that hands each card from coding agent to coding agent, column by column.</p>

---

Baton is a desktop app for running local coding agents through a workflow you design. Each board points at a git repository. Each column can carry a **trigger**: when a card enters it, Baton starts an agent session (with the harness, model, permissions and prompt you configured for that column) in the card's own **git worktree**. When the agent finishes, the card moves on to the next column, so a typical card goes Plan → Build → Review → Done without you touching it.

> **Status: early.** macOS only, and the only agent harness wired up so far is the [Antigravity CLI](https://antigravity.google) (`agy`). Adapters for Claude Code, Codex, pi and OpenCode are planned; see [Adding a harness](#adding-a-harness).

## Features

- **Configurable columns.** Add, rename, reorder and delete columns. Any column can run an agent when a card enters it, read-only or full-auto, and send the card onward on success or failure.
- **Live agent sessions.** One session per card per column, with the full transcript streamed live: prompts, agent text, and every tool call with its input and output. If the agent stops early, Baton tells it to continue in the same session.
- **Questions and artifacts.** Agents can pause and ask you something; the card shows *needs answer* and a desktop notification appears, and your reply continues the same session. Agents can also save documents (plans, reports) that later columns use as prompt variables.
- **Epics.** Describe a larger piece of work, let an agent break it down into tasks with dependencies, then edit the draft before creating the cards.
- **Dependencies.** A blocked card waits, then moves to the next ⚡ column and starts once all its blockers have succeeded. Its worktree merges in the blockers' branches first.
- **Finishing.** Per board, a finished card either merges into the base branch locally or opens a pull request. Tasks inside an epic get stacked PRs.
- **Isolation.** Every card works on its own branch in its own worktree, so several agents can run in parallel (the limit is configurable).

## Requirements

- macOS
- Node.js 22.5 or newer, and git
- The [Antigravity CLI](https://antigravity.google) (`agy`), signed in
- For pull requests: the [GitHub CLI](https://cli.github.com) (`gh`), signed in

## Getting started

```bash
git clone https://github.com/IslamElgohary/baton.git
cd baton
npm install
npm run dev
```

1. Click **Choose a repository** and pick a local git repository. New boards start with Backlog → Plan → Build → Review → Done.
2. Open **⚙ Settings** to check that Baton found `agy` and that it is signed in.
3. Add a card to **Backlog** and drag it into **Plan**. Click the card to watch the session.
4. Click **⚙** on a column to change its harness, model, permissions, prompt, or where cards go on success or failure.

To run the production build instead of dev mode: `npm run build && npm start`. There is no packaged `.app`/`.dmg` yet.

### Column prompts

Prompts are templates. Available variables:

| Variable | Value |
|---|---|
| `{{task.title}}`, `{{task.description}}` | The card |
| `{{epic.title}}`, `{{epic.description}}` | Its epic, if any |
| `{{prev.summary}}` | Result of the card's last successful session |
| `{{artifact.<name>}}`, `{{artifacts}}` | One saved artifact, or all of them |
| `{{diff}}` | The card's changes vs the base branch |
| `{{branch}}`, `{{base}}`, `{{worktree}}` | Git details |
| `{{column.name}}`, `{{board.name}}` | Where it runs |

Baton appends a short protocol to every session's first message. The agent ends its reply with `[DONE]`, `[FAILED] <reason>` or `[QUESTION] <question>`, and saves documents as `<artifact name="…">…</artifact>` blocks.

## Safety

- **Full-auto columns run agents without permission prompts.** They can edit files and run any command. The worktree isolates git state, not your machine. Use full-auto only for repositories and prompts you trust.
- **Read-only columns are enforced by the harness.** For Antigravity, every shell command, file write and MCP tool is denied, overriding your global allow-list. Anything other than an explicit full-auto setting falls back to read-only.
- **Local merges** only run when your main checkout is clean and on the base branch, and are aborted on conflict.
- **Quitting** stops all agent sessions. Anything still running after a short grace period is killed.

## Data

Boards live in a SQLite database in the app's data folder (`~/Library/Application Support/Baton`). Worktrees are created under the same folder. `BATON_USER_DATA=/some/dir npm run dev` uses a separate folder, which is handy for experiments.

## Development

```bash
npm test           # unit + integration tests (real git, fake agent harness)
npm run typecheck
npm run e2e        # real Antigravity sessions in a temp repo: needs `agy`, costs model usage
npm run icon       # regenerate build/icon.png and build/icon.icns from build/icon.svg
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together.

### Adding a harness

A harness is one file implementing the `Harness` interface in [`src/main/harnesses/types.ts`](src/main/harnesses/types.ts): how to start a long-lived session process, encode a user turn on stdin, parse its JSON event stream, list models, and check sign-in. Add it to the list in [`src/main/harnesses/index.ts`](src/main/harnesses/index.ts), capture a sample session into `test/fixtures/`, and add a parser test like [`antigravity.test.ts`](src/main/harnesses/antigravity.test.ts). Settings, the column dialog and the runner all pick it up from the registry.

## License

[MIT](LICENSE)
