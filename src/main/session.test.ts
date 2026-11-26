import { spawn } from 'node:child_process'
import { expect, test } from 'vitest'
import type { Harness } from './harnesses/types'
import { startSession } from './session'

test("a harness's env reaches the session process", async () => {
  const h: Harness = {
    id: 'env', name: 'Env', bin: 'node', loginArgs: [], env: { BATON_TEST_ENV: 'yes' },
    probe: async () => ({ version: null, loggedIn: true, detail: '', models: [] }),
    sessionArgs: () => ['-e', `process.stdin.once('data', () => console.log(process.env.BATON_TEST_ENV + ' [DONE]'))`],
    encodeTurn: (t) => t,
    parser: () => ({ line: (l) => [{ kind: 'turn_end', ok: true, response: l }] })
  }
  const s = startSession({ harness: h, bin: process.execPath, cwd: process.cwd(), model: '', permission: 'read', firstTurn: 'go', maxTurns: 1,
    idleTimeoutMin: 1, spawn, onEvent: () => {}, onSessionId: () => {}, onArtifact: () => {} })
  expect(await s.result).toEqual({ type: 'done', text: 'yes' })
})
