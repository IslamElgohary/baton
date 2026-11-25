import type { Harness, ParsedEvent } from '../src/main/harnesses/types'

// Test-only: a scriptable session harness (run with `node -e`). Not imported by the app.

/**
 * Fake session CLI (node): reads `{"text"}` turns from stdin and plays the scenario
 * named by the trigger's model. Emits {"t":"session"|"text"|"end"} lines.
 */
const FAKE = `
const [scenario, resume] = process.argv.slice(1)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ t: 'session', v: resume || 'sess-' + process.pid })
if (resume) out({ t: 'text', v: 'resumed:' + resume })
let turn = 0, buf = ''
process.stdin.on('data', (c) => {
  buf += c; const ls = buf.split('\\n'); buf = ls.pop()
  for (const l of ls) {
    turn++
    const msg = JSON.parse(l).text
    const first = msg.split('\\n')[0]
    if (scenario === 'draft') out({ t: 'end', v: '<artifact name="tasks.json">\\n' + JSON.stringify([
      { title: 'Schema', description: 'db', blockedBy: [] }, { title: 'API', blockedBy: [0, 5] }, { title: '' }]) + '\\n</artifact>\\n[DONE]' })
    if (scenario === 'echo') out({ t: 'end', v: first + '\\n[DONE]' })
    if (scenario === 'ask') out({ t: 'end', v: resume
      ? 'Using ' + first + '\\n<artifact name="choice.md">\\ncolor: ' + first + '\\n</artifact>\\n[DONE]'
      : 'Need input.\\n[QUESTION] Which color?' })
    if (scenario === 'continue') out({ t: 'end', v: turn < 2 ? 'Launched a subagent, waiting.' : 'Finished.\\n[DONE]' })
    if (scenario === 'never') out({ t: 'end', v: 'still going' })
    if (scenario === 'fail') out({ t: 'end', v: 'boom\\n[FAILED] cannot' })
    if (scenario === 'error') out({ t: 'end', v: '', error: 'model not found' })
    if (scenario === 'slow') setTimeout(() => out({ t: 'end', v: 'ok [DONE]' }), 300)
    if (scenario === 'helper') {
      require('child_process').spawn('sleep', ['8'], { stdio: ['ignore', 'inherit', 'ignore'] }) // holds stdout open
      out({ t: 'end', v: 'ok\\n[DONE]' })
    }
    // 'hang': never answers; 'stubborn': never answers and ignores SIGTERM
  }
})
process.stdin.on('end', () => process.exit(0))
if (scenario === 'stubborn') process.on('SIGTERM', () => {})
`

export const fake: Harness = {
  id: 'fake', name: 'Fake', bin: 'node', loginArgs: [],
  probe: async () => ({ version: null, loggedIn: true, detail: '', models: [] }),
  sessionArgs: ({ model, resume }) => ['-e', FAKE, model, resume ?? ''],
  encodeTurn: (text) => JSON.stringify({ text }),
  parser: () => ({
    line(l): ParsedEvent[] {
      const e = JSON.parse(l)
      if (e.t === 'session') return [{ kind: 'session', id: e.v }]
      if (e.t === 'text') return [{ kind: 'text', text: e.v }]
      return [{ kind: 'turn_end', ok: !e.error, response: e.v, error: e.error }]
    }
  })
}

