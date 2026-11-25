/**
 * Is `url` the app's own page? `appUrl` is the dev server URL (any path on that origin is ours, for HMR)
 * or the packaged index.html file URL (exactly that file). Used to lock navigation and reject IPC from
 * anything else, e.g. an HTML file dropped onto the window.
 */
export function isAppUrl(url: string | undefined, appUrl: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url), app = new URL(appUrl)
    if (app.protocol === 'file:') return u.protocol === 'file:' && u.pathname === app.pathname
    return u.origin === app.origin
  } catch {
    return false
  }
}
