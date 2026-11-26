import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import type { PushEvent } from '../shared/types'
import { createApi } from './api'
import { createBreakdowns } from './breakdown'
import { createFinisher, type Finisher } from './finish'
import { createDb } from './db'
import { createGit } from './git'
import { harnesses } from './harnesses'
import { adoptLoginShellPath, exec, which } from './proc'
import { checkArgs } from './ipc-args'
import { terminalLauncher } from './terminal'
import { createRunner } from './runner'
import { isAppUrl } from './security'

// Separate data dir for testing/demo runs: BATON_USER_DATA=/tmp/x npm run dev
if (process.env.BATON_USER_DATA) app.setPath('userData', process.env.BATON_USER_DATA)

// One instance per data folder: two would recover the same DB and run duplicate agents on the same worktrees.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })

const rendererFile = join(__dirname, '../renderer/index.html')
/** The app's own page: dev server or packaged index.html. Nothing else may navigate the window or call the API. */
const appUrl = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(rendererFile).href

let win: BrowserWindow | null = null
const push = (e: PushEvent) => win?.webContents.send('push', e)

/** Run a command (a harness's interactive sign-in) in a new terminal window. */
async function openTerminal(argv: string[]) {
  const l = terminalLauncher(process.platform, argv, which)
  if (!l) throw new Error(`Couldn't find a terminal app to open. Run this in a terminal yourself:\n${argv.join(' ')}`)
  if (l.wait) {
    const r = await exec(l.bin, l.args)
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'Could not open a terminal')
    return
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(l.bin, l.args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

app.whenReady().then(async () => {
  await adoptLoginShellPath()

  const db = createDb(join(app.getPath('userData'), 'baton.db'))
  const git = createGit(exec)
  const resolveBin = (id: string) => {
    const h = harnesses.find((x) => x.id === id)
    return h ? which(db.getSettings().binPaths[id] || h.bin) : null
  }
  let finisher: Finisher | undefined // needs runner.isActive; the runner needs it for finish columns
  const runner = createRunner({
    db, harnesses, git, spawn, resolveBin, push,
    onFinishColumn: (id) => { finisher?.finish(id, { auto: true }).catch((e) => console.error('finish failed', e.message)) },
    notify: (title, body) => new Notification({ title, body: body.slice(0, 200) }).show(),
    worktreeRoot: join(app.getPath('userData'), 'worktrees')
  })
  const breakdowns = createBreakdowns({ db, harnesses, resolveBin, spawn, push })
  finisher = createFinisher({
    db, git, push, isActive: runner.isActive,
    gh: async (args, cwd) => {
      const bin = which('gh')
      if (!bin) return { code: 127, stdout: '', stderr: 'GitHub CLI (gh) not found on PATH. Install it and run `gh auth login`.' }
      return exec(bin, args, { cwd, timeoutMs: 120_000 })
    }
  })
  const api = createApi({
    db, runner, breakdowns, finisher, git, harnesses, exec, resolveBin, openTerminal,
    pickDirectory: async () => {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory'], message: 'Choose a git repository' })
      return r.canceled ? null : r.filePaths[0]
    },
    openPath: async (p) => { const err = await shell.openPath(p); if (err) throw new Error(err) },
    openExternal: (url) => shell.openExternal(url)
  })

  // Every api method is an IPC channel. Errors come back as { error } so the renderer gets a clean message.
  for (const [name, fn] of Object.entries(api) as [string, (...a: unknown[]) => unknown][]) {
    ipcMain.handle(name, async (e, ...args) => {
      if (!isAppUrl(e.senderFrame?.url, appUrl)) return { error: 'Blocked: not the app page' }
      try {
        checkArgs(name, args)
        const value = await fn(...args)
        if (!/^(list|get)/.test(name)) push({ type: 'changed' })
        return { value }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    })
  }

  db.recover()
  runner.pump() // tasks still queued from the last run
  // Quit: SIGTERM all agent sessions, give them a moment, then SIGKILL what's left (they run in their own
  // process groups and would otherwise outlive the app — a full-auto agent keeps editing files).
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting || (!runner.activeCount() && !breakdowns.runningCount())) return
    quitting = true
    e.preventDefault()
    runner.killAll()
    breakdowns.killAll()
    setTimeout(() => { runner.killAll({ force: true }); breakdowns.killAll({ force: true }); app.quit() }, 1500)
  })

  // Packaged builds get build/icon.icns from the bundle; in dev, show it in the Dock/window too.
  const icon = join(__dirname, '../../build/icon.png')
  if (!app.isPackaged && existsSync(icon)) app.dock?.setIcon(icon)

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Baton',
    icon,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  win.on('closed', () => { win = null })
  // Never navigate away (e.g. an HTML file dropped on the window) and never open new windows.
  win.webContents.on('will-navigate', (e, url) => { if (!isAppUrl(url, appUrl)) e.preventDefault() })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(rendererFile)
})

app.on('window-all-closed', () => app.quit())
