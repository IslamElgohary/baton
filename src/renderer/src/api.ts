import type { Api } from '../../main/api'
import type { PushEvent } from '../../shared/types'

declare global {
  interface Window {
    api: {
      invoke(channel: string, ...args: unknown[]): Promise<unknown>
      on(cb: (e: PushEvent) => void): () => void
    }
  }
}

/** Typed IPC call: `call('getBoard', id)` mirrors `Api.getBoard(id)` in the main process. */
export function call<K extends keyof Api>(name: K, ...args: Parameters<Api[K]>): Promise<Awaited<ReturnType<Api[K]>>> {
  return window.api.invoke(name, ...args) as Promise<Awaited<ReturnType<Api[K]>>>
}

export const onPush = (cb: (e: PushEvent) => void) => window.api.on(cb)

/** Runs an IPC call and shows a failure in the error bar (resolves undefined then). */
export type Act = <T>(p: Promise<T>) => Promise<T | undefined>
