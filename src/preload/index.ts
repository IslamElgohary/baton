import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  async invoke(channel: string, ...args: unknown[]) {
    const r = await ipcRenderer.invoke(channel, ...args)
    if (r && 'error' in r) throw new Error(r.error)
    return r?.value
  },
  on(cb: (e: unknown) => void) {
    const listener = (_: unknown, e: unknown) => cb(e)
    ipcRenderer.on('push', listener)
    return () => { ipcRenderer.removeListener('push', listener) }
  }
})
