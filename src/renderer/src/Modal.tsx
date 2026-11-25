import { useEffect, type ReactNode } from 'react'

export function Modal({ title, onClose, footer, children, wide }: {
  title: ReactNode; onClose: () => void; footer?: ReactNode; children: ReactNode; wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}
        className={`flex max-h-full w-full flex-col rounded-lg bg-white shadow-xl dark:bg-neutral-900 ${wide ? 'max-w-4xl' : 'max-w-2xl'}`}>
        <div className="flex items-center border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <h2 className="flex-1 truncate font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex items-center gap-2 border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">{footer}</div>}
      </div>
    </div>
  )
}
