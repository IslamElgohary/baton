import { useEffect, useState } from 'react'
import type { HarnessInfo, Settings as SettingsT } from '../../shared/types'
import { call, type Act } from './api'

interface Props {
  harnesses: HarnessInfo[]
  reload: (refresh?: boolean) => Promise<void>
  act: Act
}

export function Settings({ harnesses, reload, act }: Props) {
  const [s, setS] = useState<SettingsT | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => { act(call('getSettings')).then((v) => v && setS(v)) }, [act])
  if (!s) return null

  async function save(next: SettingsT) {
    setS(next)
    await act(call('saveSettings', next))
  }
  async function recheck() {
    setChecking(true)
    await reload(true)
    setChecking(false)
  }

  return (
    <div className="max-w-3xl overflow-y-auto p-6">
      <h1 className="mb-4 text-lg font-semibold">Settings</h1>

      <section className="mb-8 flex gap-6">
        <label>
          <span className="label">Max parallel runs</span>
          <input type="number" min={1} max={16} className="input w-24" value={s.maxConcurrency}
            onChange={(e) => save({ ...s, maxConcurrency: Math.max(1, Number(e.target.value) || 1) })} />
        </label>
        <label>
          <span className="label">Max turns per session</span>
          <input type="number" min={1} max={50} className="input w-24" value={s.maxTurns}
            onChange={(e) => save({ ...s, maxTurns: Math.max(1, Number(e.target.value) || 1) })} />
        </label>
        <label>
          <span className="label">Kill a session after N minutes with no output</span>
          <input type="number" min={1} className="input w-24" value={s.idleTimeoutMin}
            onChange={(e) => save({ ...s, idleTimeoutMin: Math.max(1, Number(e.target.value) || 1) })} />
        </label>
      </section>

      <div className="mb-2 flex items-center">
        <h2 className="flex-1 font-semibold">Harnesses</h2>
        <button className="btn" disabled={checking} onClick={recheck}>{checking ? 'Checking…' : '↻ Recheck'}</button>
      </div>
      <div className="flex flex-col gap-3">
        {harnesses.map((h) => (
          <div key={h.id} className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="flex items-center gap-2">
              <b>{h.name}</b>
              <span className="text-xs text-neutral-500">{h.version ?? ''}</span>
              <div className="flex-1" />
              <span className={`text-xs ${h.loggedIn ? 'text-green-600' : 'text-red-600'}`}>
                {h.loggedIn ? '● Signed in' : '● Not ready'}
              </span>
              {h.path && !h.loggedIn && (
                <button className="btn" onClick={() => act(call('loginHarness', h.id))}>Sign in…</button>
              )}
            </div>
            <div className="mt-1 text-xs text-neutral-500">
              {h.path ?? `"${h.bin}" not found on PATH`} · {h.authDetail}
            </div>
            <label className="mt-2 block">
              <span className="label">Binary path override</span>
              <input className="input font-mono" placeholder={h.bin} defaultValue={s.binPaths[h.id] ?? ''}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v !== (s.binPaths[h.id] ?? '')) save({ ...s, binPaths: { ...s.binPaths, [h.id]: v } }).then(recheck)
                }} />
            </label>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-neutral-500">“Sign in…” opens the CLI in a terminal window. Finish signing in there, then press Recheck.</p>
    </div>
  )
}
