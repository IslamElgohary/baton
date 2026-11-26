import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { Markdown, safeHref } from './Markdown'

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }))

describe('Markdown', () => {
  test('renders GFM tables', () => {
    expect(render('| a | b |\n| - | - |\n| 1 | 2 |')).toContain('<table')
  })

  test('renders task list checkboxes as disabled inputs', () => {
    const html = render('- [x] done')
    expect(html).toContain('<input')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('disabled')
  })

  test('renders GFM strikethrough', () => {
    expect(render('~~x~~')).toContain('<del')
  })

  test('renders fenced code blocks as pre > code', () => {
    const html = render('```js\nconst x = 1\n```')
    expect(html).toContain('<pre')
    expect(html).toContain('<code')
  })

  test('does not render raw HTML as elements', () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
  })

  test('does not emit href for unsafe schemes', () => {
    expect(render('[x](javascript:alert(1))')).not.toContain('href')
  })

  test('renders images as alt text only', () => {
    const html = render('![diagram](https://example.com/x.png)')
    expect(html).toContain('diagram')
    expect(html).not.toContain('<img')
  })
})

describe('safeHref', () => {
  test('accepts http and https URLs', () => {
    expect(safeHref('http://example.com/a')).toBe('http://example.com/a')
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
  })

  test('rejects unsafe schemes and relative paths', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('file:///etc/passwd')).toBeNull()
    expect(safeHref('data:text/html,hi')).toBeNull()
    expect(safeHref('/relative')).toBeNull()
    expect(safeHref('relative/path')).toBeNull()
    expect(safeHref('')).toBeNull()
    expect(safeHref(undefined)).toBeNull()
  })
})
