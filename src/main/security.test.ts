import { expect, test } from 'vitest'
import { isAppUrl } from './security'

test('isAppUrl: dev server origin, or exactly the packaged index.html', () => {
  expect(isAppUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(true)
  expect(isAppUrl('http://localhost:5173/src/main.tsx?t=1', 'http://localhost:5173')).toBe(true)
  expect(isAppUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false)
  const app = 'file:///Applications/Baton.app/Contents/Resources/app/out/renderer/index.html'
  expect(isAppUrl(app + '#/x', app)).toBe(true)
  expect(isAppUrl('file:///Users/me/Downloads/evil.html', app)).toBe(false)
  expect(isAppUrl('https://example.com/', app)).toBe(false)
  expect(isAppUrl(undefined, app)).toBe(false)
  expect(isAppUrl('not a url', app)).toBe(false)
})
