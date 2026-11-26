import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { Artifact } from '../../shared/types'
import { ArtifactView } from './TaskDialog'

const artifact = (name: string, content: string): Artifact => ({
  id: 1,
  task_id: 1,
  run_id: 1,
  column_id: 1,
  name,
  content,
  updated_at: '2026-01-01 00:00'
})

const render = (name: string, content: string) =>
  renderToStaticMarkup(createElement(ArtifactView, { artifact: artifact(name, content) }))

describe('ArtifactView', () => {
  test('renders Markdown artifacts by default with a Raw toggle', () => {
    const html = render('notes.md', '# Heading\n\nSome **bold** text.')
    expect(html).toContain('<h1')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('>Raw</button>')
    expect(html).not.toContain('<pre')
  })

  test('recognizes .markdown case-insensitively', () => {
    const html = render('NOTES.MARKDOWN', '# Heading')
    expect(html).toContain('<h1')
    expect(html).toContain('>Raw</button>')
  })

  test('keeps HTML artifacts sandboxed without a toggle', () => {
    const html = render('page.html', '<p>hi</p>')
    expect(html).toContain('<iframe sandbox=""')
    expect(html).toContain('srcDoc=')
    expect(html).not.toContain('>Raw</button>')
  })

  test('renders other artifacts as pre without a toggle', () => {
    for (const [name, content] of [['notes.txt', 'plain text'], ['data.json', '{"a":1}']]) {
      const html = render(name, content)
      expect(html).toContain('<pre')
      expect(html).not.toContain('>Raw</button>')
    }
  })
})
