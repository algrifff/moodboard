import type { CanvasSnapshot } from '@/store/canvas'
import { snapshotFromStore, useCanvasStore } from '@/store/canvas'
import { useEffect, useRef, useState } from 'react'
import { getBoard, updateBoard } from '@/lib/boardsApi'

type Status = 'loading' | 'ready' | 'error' | 'not-found'

const AUTOSAVE_DEBOUNCE_MS = 2000

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

  const hydrate = useCanvasStore((s) => s.hydrate)
  const reset = useCanvasStore((s) => s.reset)

  // Capture the latest snapshot we've fetched / sent so we don't autosave the
  // same value back to the server in a loop, and so we can ignore changes that
  // happen during the initial hydration.
  const lastSavedRef = useRef<string | null>(null)
  const ignoreNextChangesRef = useRef(true)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError(null)
    ignoreNextChangesRef.current = true

    getBoard(boardId)
      .then((board) => {
        if (cancelled) return
        const data = (board.data ?? {}) as Partial<CanvasSnapshot>
        hydrate({
          objects: data.objects ?? [],
          scale: data.scale ?? 1,
          offset: data.offset ?? { x: 0, y: 0 },
        })
        onTitle?.(board.name)
        lastSavedRef.current = JSON.stringify({
          objects: data.objects ?? [],
          scale: data.scale ?? 1,
          offset: data.offset ?? { x: 0, y: 0 },
        })
        setStatus('ready')
        // Allow autosave on the next tick so React doesn't pick up the hydrate
        // as a user change.
        queueMicrotask(() => {
          ignoreNextChangesRef.current = false
        })
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
      reset()
    }
  }, [boardId, hydrate, reset, onTitle])

  // Autosave: subscribe to relevant slices, debounce 2s, send PATCH.
  useEffect(() => {
    if (status !== 'ready') return
    let timer: ReturnType<typeof setTimeout> | undefined

    const unsub = useCanvasStore.subscribe((state, prev) => {
      if (ignoreNextChangesRef.current) return
      if (
        state.objects === prev.objects &&
        state.scale === prev.scale &&
        state.offset === prev.offset
      ) {
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        const snapshot = snapshotFromStore(useCanvasStore.getState())
        const serialized = JSON.stringify(snapshot)
        if (serialized === lastSavedRef.current) return
        try {
          setSaving(true)
          await updateBoard(boardId, { data: snapshot })
          lastSavedRef.current = serialized
        } catch (e) {
          console.error('autosave failed', e)
        } finally {
          setSaving(false)
        }
      }, AUTOSAVE_DEBOUNCE_MS)
    })

    return () => {
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [boardId, status])

  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center w-full h-full text-sm text-muted-foreground">
        Loading board…
      </div>
    )
  }
  if (status === 'not-found') {
    return (
      <div className="flex items-center justify-center w-full h-full text-sm text-muted-foreground">
        Board not found.
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="flex items-center justify-center w-full h-full text-sm text-red-600">
        Failed to load: {error}
      </div>
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
