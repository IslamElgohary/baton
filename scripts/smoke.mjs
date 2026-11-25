// Launches the built app (run `npm run build` first) with a throwaway data folder and checks, through the
// Chrome DevTools protocol, that the window loads and the main process answers IPC. Exits non-zero on failure.
// On Linux CI, run it under `xvfb-run` and set SMOKE_NO_SANDBOX=1 (see README: Linux sandbox).
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electron = createRequire(import.meta.url)('electron') // path to the binary; downloads it on first use
const port = 9400 + Math.floor(Math.random() * 500)
const data = mkdtempSync(join(tmpdir(), 'baton-smoke-'))
const args = ['.', `--remote-debugging-port=${port}`, ...(process.env.SMOKE_NO_SANDBOX ? ['--no-sandbox'] : [])]
const app = spawn(electron, args, { env: { ...process.env, BATON_USER_DATA: data }, stdio: ['ignore', 'inherit', 'inherit'] })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Never hang CI: give up after 2 minutes no matter what.
const deadline = setTimeout(() => { console.error('smoke: FAILED - timed out'); app.kill('SIGKILL'); process.exit(1) }, 120_000)
async function main() {
  let page
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500)
    if (app.exitCode !== null) throw new Error(`app exited early with code ${app.exitCode}`)
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((p) => p.type === 'page' && p.url.includes('index.html')) } catch { /* not up yet */ }
  }
  if (!page) throw new Error('no app window after 30s')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let n = 0
  const pending = new Map()
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id) }
  /** One DevTools call, failing after 15s instead of waiting forever. */
  const cdp = (method, params) => new Promise((resolve, reject) => {
    const id = ++n
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 15_000)
    pending.set(id, (d) => { clearTimeout(timer); resolve(d.result) })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
    return r?.result?.value
  }
  for (let i = 0; i < 20 && !(await evaluate('document.body.innerText.includes("Baton")')); i++) await sleep(250)
  const result = await evaluate(`(async () => ({
    title: document.title,
    sidebar: document.body.innerText.includes('Baton'),
    boards: (await window.api.invoke('listBoards')).length,
    harnesses: (await window.api.invoke('listHarnesses')).map((h) => h.id),
    settings: await window.api.invoke('getSettings'),
    badArgsRejected: await window.api.invoke('getBoard', 'x').then(() => false, () => true)
  }))()`)
  if (process.env.SMOKE_SCREENSHOT) { // optional, best effort: save what the window looks like (a CI artifact)
    await cdp('Page.captureScreenshot', { format: 'png' })
      .then((shot) => writeFileSync(process.env.SMOKE_SCREENSHOT, Buffer.from(shot.data, 'base64')))
      .catch((e) => console.warn('smoke: screenshot skipped -', e.message))
  }
  ws.close()
  console.log('smoke:', JSON.stringify(result))
  const ok = result.title === 'Baton' && result.sidebar && result.boards === 0 && result.harnesses.length > 0 &&
    result.settings.maxConcurrency > 0 && result.badArgsRejected
  if (!ok) throw new Error('unexpected app state')
}

main()
  .then(() => { console.log('smoke: ok') }, (e) => { console.error('smoke: FAILED -', e.message); process.exitCode = 1 })
  .finally(() => { clearTimeout(deadline); app.kill(); setTimeout(() => rmSync(data, { recursive: true, force: true }), 500) })
