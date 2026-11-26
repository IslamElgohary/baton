import type { Task } from '../../shared/types'

const STATUS: Record<Task['status'], [string, string] | null> = {
  idle: null,
  queued: ['queued', 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'],
  running: ['running', 'bg-blue-100 text-blue-800 animate-pulse dark:bg-blue-950 dark:text-blue-300'],
  waiting: ['❓ needs answer', 'bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100'],
  succeeded: ['✓ done', 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'],
  failed: ['failed', 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300']
}

export function StatusBadge({ status }: { status: Task['status'] }) {
  const s = STATUS[status]
  return s ? <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${s[1]}`}>{s[0]}</span> : null
}

