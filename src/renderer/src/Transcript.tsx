import { useEffect, useRef } from 'react'
import type { SessionEvent } from '../../shared/types'

type Block =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; input?: unknown; output?: string; done: boolean }
  | { type: 'info'; text: string }
  | { type: 'turn'; ok: boolean; error?: string }
  | { type: 'question'; text: string }
  | { type: 'artifact'; name: string }

/** Merge streamed text chunks and tool start/finish updates into display blocks. */
export function fold(events: SessionEvent[]): Block[] {
  const blocks: Block[] = []
  const tools = new Map<string, Extract<Block, { type: 'tool' }>>()
  for (const e of events) {
    const last = blocks[blocks.length - 1]
    if (e.kind === 'text') {
      if (last?.type === 'assistant') last.text += e.text
      else blocks.push({ type: 'assistant', text: e.text })
    } else if (e.kind === 'thinking') {
      if (last?.type === 'thinking') last.text += e.text
      else blocks.push({ type: 'thinking', text: e.text })
    } else if (e.kind === 'tool') {
      const t = tools.get(e.id)
      if (t) Object.assign(t, { input: e.input ?? t.input, output: e.output ?? t.output, done: e.done })
      else { const b = { type: 'tool' as const, ...e }; tools.set(e.id, b); blocks.push(b) }
    } else if (e.kind === 'user') blocks.push({ type: 'user', text: e.text })
    else if (e.kind === 'info') blocks.push({ type: 'info', text: e.text })
    else if (e.kind === 'question') blocks.push({ type: 'question', text: e.text })
    else if (e.kind === 'artifact') blocks.push({ type: 'artifact', name: e.name })
    else blocks.push({ type: 'turn', ok: e.ok, error: e.error })
  }
  return blocks
}

/** One-line preview of a tool call's input (command, path, query…). */
function preview(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const v = Object.values(input).find((x) => typeof x === 'string') as string | undefined
  return v ? v.replace(/\s+/g, ' ').slice(0, 140) : ''
}

export function Transcript({ events, live }: { events: SessionEvent[]; live: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true) // follow new output unless the user scrolled up
  useEffect(() => {
    if (live && stick.current && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [events.length, live])

  const blocks = fold(events)
  return (
    <div ref={box} className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto bg-neutral-50 p-3 text-sm dark:bg-neutral-950"
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
      {blocks.length === 0 && <span className="text-xs text-neutral-500">Waiting for output…</span>}
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'user':
            return (
              <details key={i} open={b.text.length < 400} className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 dark:border-indigo-900 dark:bg-indigo-950/40">
                <summary className="cursor-pointer text-xs font-medium text-indigo-700 dark:text-indigo-300">
                  App → agent {b.text.length >= 400 && <span className="font-normal text-neutral-500">· {b.text.slice(0, 80).replace(/\s+/g, ' ')}…</span>}
                </summary>
                <div className="mt-1 whitespace-pre-wrap">{b.text}</div>
              </details>
            )
          case 'assistant':
            return <div key={i} className="whitespace-pre-wrap">{b.text}</div>
          case 'thinking':
            return (
              <details key={i} open={live && i === blocks.length - 1} className="text-xs text-neutral-500">
                <summary className="cursor-pointer italic">thinking…</summary>
                <div className="mt-1 border-l-2 border-neutral-300 pl-2 whitespace-pre-wrap italic dark:border-neutral-700">{b.text}</div>
              </details>
            )
          case 'tool':
            return (
              <details key={i} className="rounded-md border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                <summary className="cursor-pointer truncate px-2 py-1 font-mono text-xs">
                  <span className={b.done ? 'text-green-600' : 'animate-pulse text-blue-600'}>{b.done ? '✓' : '●'}</span>{' '}
                  <b>{b.name}</b> <span className="text-neutral-500">{preview(b.input)}</span>
                </summary>
                <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
                  <pre className="overflow-x-auto text-xs whitespace-pre-wrap text-neutral-500">{JSON.stringify(b.input, null, 2)}</pre>
                  {b.output !== undefined && <pre className="mt-2 max-h-64 overflow-auto text-xs whitespace-pre-wrap">{b.output}</pre>}
                </div>
              </details>
            )
          case 'info':
            return <div key={i} className="font-mono text-xs whitespace-pre-wrap text-neutral-500">{b.text}</div>
          case 'question':
            return (
              <div key={i} className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/40">
                <div className="text-xs font-medium text-amber-700 dark:text-amber-300">❓ Agent asked</div>
                <div className="whitespace-pre-wrap">{b.text}</div>
              </div>
            )
          case 'artifact':
            return <div key={i} className="text-xs text-neutral-500">📎 saved artifact <b>{b.name}</b></div>
          case 'turn':
            return (
              <div key={i} className={`border-t border-dashed pt-1 text-center text-[10px] uppercase tracking-wide ${b.ok ? 'border-neutral-300 text-neutral-400 dark:border-neutral-700' : 'border-red-300 text-red-500'}`}>
                turn ended{b.error ? ` · ${b.error}` : ''}
              </div>
            )
        }
      })}
    </div>
  )
}
