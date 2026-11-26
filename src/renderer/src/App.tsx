import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardData, BoardSummary, HarnessInfo } from '../../shared/types'
import { call, onPush } from './api'
import { Board } from './Board'
import { EpicDialog } from './EpicDialog'
import { Settings } from './Settings'

const LAST_BOARD = 'lastBoardId'
const store = {
  get: () => { try { return Number(localStorage.getItem(LAST_BOARD)) || null } catch { return null } },
  set: (id: number) => { try { localStorage.setItem(LAST_BOARD, String(id)) } catch { /* ignore */ } }
}

export function App() {
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [boardId, setBoardId] = useState<number | null>(store.get())
  const [data, setData] = useState<BoardData | null>(null)
  const [view, setView] = useState<'board' | 'settings'>('board')
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [epicFilter, setEpicFilter] = useState<number | null>(null)
  const [editEpic, setEditEpic] = useState<number | null>(null)
  useEffect(() => { setEpicFilter(null); setEditEpic(null) }, [boardId])
  useEffect(() => { // the filtered epic was deleted
    if (epicFilter && data && !data.epics.some((e) => e.id === epicFilter)) setEpicFilter(null)
  }, [data, epicFilter])

  /** Run an IPC call, surfacing failures in the error bar. */
  const act = useCallback(<T,>(p: Promise<T>) => p.catch((e: Error) => { setError(e.message); return undefined }), [])

  // Refreshes overlap (a burst of 'changed' pushes): only the latest may apply, or an older board state wins.
  const latest = useRef(0)
  const refresh = useCallback(async () => {
    const n = ++latest.current
    const list = await call('listBoards')
    if (n !== latest.current) return
    setBoards(list)
    const id = list.some((b) => b.id === boardId) ? boardId : list[0]?.id ?? null
    if (id !== boardId) setBoardId(id)
    const board = id ? await call('getBoard', id) : null
    if (n === latest.current) setData(board)
  }, [boardId])

  useEffect(() => { act(refresh()) }, [refresh, act])
  useEffect(() => onPush((e) => { if (e.type === 'changed') act(refresh()) }), [refresh, act])
  useEffect(() => { if (boardId) store.set(boardId) }, [boardId])

  const loadHarnesses = useCallback(async (refresh = false) => {
    const list = await act(call('listHarnesses', refresh))
    if (list) setHarnesses(list)
  }, [act])
  useEffect(() => { loadHarnesses() }, [loadHarnesses])

  async function newBoard() {
    const id = await act(call('newBoard'))
    if (id) { setBoardId(id); setView('board') }
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col gap-1 border-r border-neutral-200 p-3 dark:border-neutral-800">
        <div className="mb-2 px-2 text-sm font-semibold">Baton</div>
        {boards.map((b) => (
          <button key={b.id} title={b.repo_path}
            onClick={() => { setBoardId(b.id); setView('board') }}
            className={`flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${b.id === boardId && view === 'board' ? 'bg-neutral-200 dark:bg-neutral-800' : 'hover:bg-neutral-100 dark:hover:bg-neutral-900'}`}>
            <span className="flex-1 truncate">{b.name}</span>
            {b.attention > 0 && (
              <span title={b.questions ? `${b.questions} waiting for your answer` : 'Cards with news you haven\'t opened'}
                className={`rounded-full px-1.5 text-[10px] leading-4 font-semibold text-white ${b.questions ? 'bg-amber-500' : 'bg-indigo-500'}`}>
                {b.attention}
              </span>
            )}
          </button>
        ))}
        <button className="btn mt-1" onClick={newBoard}>+ New board</button>

        {data && view === 'board' && (
          <div className="mt-5 flex flex-col gap-1">
            <div className="flex items-center px-2 text-xs font-semibold text-neutral-500 uppercase">
              <span className="flex-1">Epics</span>
              <button title="New epic" className="text-base leading-none hover:text-neutral-900 dark:hover:text-neutral-100"
                onClick={async () => {
                  const id = await act(call('createEpic', data.board.id, 'New epic'))
                  if (id) setEditEpic(id)
                }}>+</button>
            </div>
            <button onClick={() => setEpicFilter(null)}
              className={`rounded-md px-2 py-1 text-left text-sm ${epicFilter === null ? 'bg-neutral-200 dark:bg-neutral-800' : 'hover:bg-neutral-100 dark:hover:bg-neutral-900'}`}>
              All tasks
            </button>
            {data.epics.map((e) => {
              const n = data.tasks.filter((t) => t.epic_id === e.id)
              const done = n.filter((t) => data.columns.find((c) => c.id === t.column_id)?.is_done).length
              return (
                <div key={e.id} className={`group flex items-center rounded-md ${epicFilter === e.id ? 'bg-neutral-200 dark:bg-neutral-800' : 'hover:bg-neutral-100 dark:hover:bg-neutral-900'}`}>
                  <button className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-sm" onClick={() => setEpicFilter(e.id)}>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: e.color }} />
                    <span className="truncate">{e.title}</span>
                    <span className="ml-auto text-xs text-neutral-500">{e.draft ? '✨' : `${done}/${n.length}`}</span>
                  </button>
                  <button className="px-1.5 text-neutral-500 opacity-0 group-hover:opacity-100" title="Edit epic" onClick={() => setEditEpic(e.id)}>✎</button>
                </div>
              )
            })}
          </div>
        )}
        <div className="flex-1" />
        <button onClick={() => setView('settings')}
          className={`rounded-md px-2 py-1 text-left text-sm ${view === 'settings' ? 'bg-neutral-200 dark:bg-neutral-800' : 'hover:bg-neutral-100 dark:hover:bg-neutral-900'}`}>
          ⚙ Settings
        </button>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div className="flex items-start gap-2 bg-red-100 px-4 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
            <span className="flex-1 whitespace-pre-wrap">{error}</span>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}
        {view === 'settings' ? (
          <Settings harnesses={harnesses} reload={loadHarnesses} act={act} />
        ) : data ? (
          <Board data={data} setData={setData} harnesses={harnesses} act={act} epicFilter={epicFilter} />
        ) : (
          <div className="m-auto text-center text-sm text-neutral-500">
            <p className="mb-3">No boards yet. A board points at a local git repository.</p>
            <button className="btn-primary" onClick={newBoard}>Choose a repository</button>
          </div>
        )}
      </main>
      {(() => {
        const epic = data?.epics.find((e) => e.id === editEpic)
        return epic && <EpicDialog key={epic.id} epic={epic} harnesses={harnesses} act={act} onClose={() => setEditEpic(null)} />
      })()}
    </div>
  )
}
