import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { call } from './api'

/** Only absolute http(s) URLs may become links; everything else renders as plain text. */
export function safeHref(url?: string): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

const components: Components = {
  h1: ({ node: _node, ...props }) => <h1 className="mt-3 mb-1.5 text-lg font-semibold text-neutral-900 dark:text-neutral-100" {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className="mt-3 mb-1.5 text-base font-semibold text-neutral-900 dark:text-neutral-100" {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="mt-2 mb-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100" {...props} />,
  h5: ({ node: _node, ...props }) => <h5 className="mt-2 mb-1 text-xs font-semibold text-neutral-900 dark:text-neutral-100" {...props} />,
  h6: ({ node: _node, ...props }) => <h6 className="mt-2 mb-1 text-xs font-semibold text-neutral-500 dark:text-neutral-400" {...props} />,
  p: ({ node: _node, ...props }) => <p className="my-1 leading-relaxed" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-1 list-disc space-y-0.5 pl-5" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-1 list-decimal space-y-0.5 pl-5" {...props} />,
  li: ({ node: _node, ...props }) => <li className="pl-0.5" {...props} />,
  input: ({ node: _node, ...props }) => <input {...props} disabled className="mr-1.5 align-middle accent-indigo-600" />,
  table: ({ node: _node, children, ...props }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs" {...props}>{children}</table>
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="bg-neutral-100 dark:bg-neutral-800/70" {...props} />,
  th: ({ node: _node, ...props }) => <th className="border border-neutral-300 px-2 py-1 font-semibold dark:border-neutral-700" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border border-neutral-300 px-2 py-1 align-top dark:border-neutral-700" {...props} />,
  del: ({ node: _node, ...props }) => <del className="text-neutral-500 line-through dark:text-neutral-400" {...props} />,
  hr: ({ node: _node, ...props }) => <hr className="my-2 border-neutral-200 dark:border-neutral-800" {...props} />,
  blockquote: ({ node: _node, ...props }) => <blockquote className="my-1.5 border-l-2 border-neutral-300 pl-3 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400" {...props} />,
  pre: ({ node: _node, ...props }) => (
    <pre
      className="my-1.5 overflow-x-auto rounded-md border border-neutral-200 bg-neutral-100 p-2 font-mono text-xs dark:border-neutral-800 dark:bg-neutral-900 [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit"
      {...props}
    />
  ),
  code: ({ node: _node, ...props }) => <code className="rounded bg-neutral-200/70 px-1 py-0.5 font-mono text-[0.85em] dark:bg-neutral-800" {...props} />,
  a: ({ node: _node, href, children, ...props }) => {
    const safe = safeHref(href)
    if (!safe) return <span {...props}>{children}</span>
    return (
      <a
        href={safe}
        onClick={(e) => {
          e.preventDefault()
          void call('openExternal', safe)
        }}
        className="text-indigo-600 underline hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
        {...props}
      >
        {children}
      </a>
    )
  },
  img: ({ node: _node, alt }) => (alt ? <span>{alt}</span> : null)
}

/** Shared safe Markdown renderer: CommonMark + GFM with compact Tailwind styling. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`min-w-0 break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
