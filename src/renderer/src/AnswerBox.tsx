import { useState } from 'react'

const IS_MAC = navigator.userAgent.includes('Mac')

interface Props {
  question: string
  /** Resolves truthy once the answer was sent; the typed text is kept otherwise. */
  onSend: (text: string) => Promise<unknown>
  /** Optional secondary action, e.g. discarding a brainstorm question. */
  onDiscard?: () => void
}

/** Shows an agent's question and sends the user's answer, with a Cmd/Ctrl+Enter shortcut. */
export function AnswerBox({ question, onSend, onDiscard }: Props) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const send = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    try { if (await onSend(text)) setText('') } finally { setSending(false) }
  }
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <div className="mb-1 text-xs font-medium text-amber-700 dark:text-amber-300">❓ The agent is waiting for your answer</div>
      <div className="mb-2 text-sm whitespace-pre-wrap">{question}</div>
      <textarea autoFocus className="input h-20" placeholder={`Your answer… (${IS_MAC ? '⌘↵' : 'Ctrl+Enter'} to send)`} value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (IS_MAC ? e.metaKey : e.ctrlKey)) send() }} />
      <div className="mt-2 flex justify-end gap-2">
        {onDiscard && <button className="btn" onClick={onDiscard}>Discard question</button>}
        <button className="btn-primary" disabled={!text.trim() || sending} onClick={send}>Send answer</button>
      </div>
    </div>
  )
}
