import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { showToast } from '@/components/canvas/Toast'
import { getBoard, saveBoardObjects } from '@/lib/boardsApi'
import {
  applySaveResult,
  diffObjects,
  foldServerObjects,
  isEmptyDiff,
  onServerObjects,
  syncedStateFrom,
  type SyncedState,
} from '@/lib/boardSync'
import { useCanvasStore } from '@/store/canvas'

type Status = 'loading' | 'ready' | 'error' | 'not-found'

const AUTOSAVE_DEBOUNCE_MS = 1000
const VIEWPORT_SAVE_DEBOUNCE_MS = 500

// Pan/zoom is per viewer, not shared board state — two teammates on the
// same board shouldn't fight over each other's camera.
type Viewport = { scale: number; offset: { x: number; y: number } }
const viewportKey = (boardId: string) => `moodboard:viewport:${boardId}`

function readViewport(boardId: string): Viewport | null {
  try {
    const raw = localStorage.getItem(viewportKey(boardId))
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<Viewport>
    if (typeof v.scale !== 'number' || typeof v.offset?.x !== 'number') return null
    if (typeof v.offset.y !== 'number') return null
    return { scale: v.scale, offset: v.offset }
  } catch {
    return null
  }
}

function writeViewport(boardId: string, viewport: Viewport): void {
  try {
    localStorage.setItem(viewportKey(boardId), JSON.stringify(viewport))
  } catch {
    // Storage unavailable (private mode, quota) — the camera just resets.
  }
}

export function BoardSync({
  boardId,
  children,
  onTitle,
}: {
  boardId: string
  children: React.ReactNode
  onTitle?: (name: string) => void
}) {
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Tagged with its board so a stale state can't be diffed against the
  // next board's objects during a board-to-board navigation.
  const [synced, setSynced] = useState<{ boardId: string; state: SyncedState } | null>(null)

  const hydrate = useCanvasStore((s) => s.hydrate)
  const reset = useCanvasStore((s) => s.reset)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError(null)
    setSynced(null)

    getBoard(boardId)
      .then((board) => {
        if (cancelled) return
        const viewport = readViewport(boardId)
        hydrate({
          objects: board.objects,
          scale: viewport?.scale ?? 1,
          offset: viewport?.offset ?? { x: 0, y: 0 },
        })
        onTitle?.(board.name)
        setSynced({ boardId, state: syncedStateFrom(board.objects, board.versions) })
        setStatus('ready')
      })
      .catch((e: Error) => {
        if (cancelled) return
        if (e.message.startsWith('404')) {
          setStatus('not-found')
        } else {
          setStatus('error')
          setError(e.message)
        }
      })

    return () => {
      cancelled = true
    }
  }, [boardId, hydrate, onTitle])

  // Autosave: diff the store against what the server last confirmed and
  // send only the changed objects. Saves run one at a time; edits made
  // while a save is in flight go out in the next one.
  useEffect(() => {
    if (status !== 'ready' || !synced || synced.boardId !== boardId) return
    const state = synced.state
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    let again = false
    let latest = useCanvasStore.getState().objects

    const save = async (keepalive = false) => {
      if (inFlight) {
        again = true
        return
      }
      const diff = diffObjects(state, latest)
      if (isEmptyDiff(diff)) return
      inFlight = true
      if (!keepalive) setSaving(true)
      try {
        const result = await saveBoardObjects(boardId, diff, { keepalive })
        const { adopt, remove } = applySaveResult(state, diff, result)
        if (adopt.length > 0 || remove.length > 0) {
          useCanvasStore.getState().applyRemote(adopt, remove)
          const n = adopt.length + remove.length
          showToast(`A teammate changed ${n === 1 ? 'an item' : `${n} items`} — kept their version`)
        }
      } catch (e) {
        console.error('autosave failed', e)
      } finally {
        inFlight = false
        if (!keepalive) setSaving(false)
      }
      if (again) {
        again = false
        void save()
      }
    }

    const unsub = useCanvasStore.subscribe((next, prev) => {
      if (next.objects === prev.objects) return
      latest = next.objects
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS)
    })

    // Changes the server made itself (agent tools) arrive already saved:
    // fold them into the synced state first so the canvas update below
    // doesn't read as a local edit.
    const offServer = onServerObjects((id, changes) => {
      if (id !== boardId) return
      const adopt = foldServerObjects(state, changes)
      if (adopt.length > 0) useCanvasStore.getState().applyRemote(adopt, [])
    })

    return () => {
      unsub()
      offServer()
      if (timer) {
        clearTimeout(timer)
        void save(true)
      }
    }
  }, [boardId, status, synced])

  // Declared after autosave so its cleanup runs after autosave's final
  // flush — otherwise the flush would see the emptied store and delete
  // every object.
  useEffect(() => () => reset(), [boardId, reset])

  useEffect(() => {
    if (status !== 'ready') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsub = useCanvasStore.subscribe((state, prev) => {
      if (state.scale === prev.scale && state.offset === prev.offset) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(
        () => writeViewport(boardId, { scale: state.scale, offset: state.offset }),
        VIEWPORT_SAVE_DEBOUNCE_MS,
      )
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [boardId, status])

  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center w-full h-full">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          <span>Loading board…</span>
        </div>
      </div>
    )
  }
  if (status === 'not-found') {
    return (
      <BoardErrorState
        title="Board not found"
        body="It may have been deleted, or the link might be wrong."
      />
    )
  }
  if (status === 'error') {
    return (
      <BoardErrorState
        title="Couldn't load this board"
        body={error ?? 'Something went wrong on our end.'}
      />
    )
  }
  return (
    <>
      {children}
      {saving && (
        <div className="absolute bottom-4 left-4 text-xs text-muted-foreground font-mono">
          Saving…
        </div>
      )}
    </>
  )
}

function Spinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-[var(--border)] border-t-[var(--accent)]"
      aria-hidden
    />
  )
}

function BoardErrorState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-center justify-center w-full h-full px-6">
      <div className="max-w-sm text-center">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
        <Link
          to="/"
          style={{ borderRadius: 'var(--radius)' }}
          className="mt-5 inline-block bg-primary text-primary-foreground px-3.5 py-2 text-sm font-medium hover:brightness-110 transition-[filter]"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  )
}
