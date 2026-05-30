import { ArrowLeft, CornersOut, Minus, Plus } from '@phosphor-icons/react'
import { cubicBezier } from 'framer-motion'
import { useCallback, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { BoardSync } from '@/components/BoardSync'
import { MoodBoardCanvas } from '@/components/canvas/MoodBoardCanvas'
import { SourcePickerDrawer } from '@/components/canvas/SourcePickerDrawer'
import { ToastHost } from '@/components/canvas/Toast'
import { Toolbar } from '@/components/canvas/Toolbar'
import { nanoid } from 'nanoid'
import { groupBoundingBox } from '@/lib/aabb'
import { updateBoard } from '@/lib/boardsApi'
import { importDriveFile, importNotionPage } from '@/lib/connectionsApi'
import { createDriveFile, createDriveFolder, createNotionPage } from '@/lib/objectFactory'
import { screenToWorld } from '@/lib/transform'
import {
  EASE_OUT_STANDARD,
  FIT_ALL_DURATION_MS,
  SNAP_CURVE,
  ZOOM_RESET_DURATION_MS,
} from '@/lib/motion'
import { openConnectionPopup } from '@/lib/oauthPopup'
import { tweenTransform } from '@/lib/tweenTransform'
import { useCanvasStore } from '@/store/canvas'
import { useSourcePickerStore } from '@/store/sourcePicker'

export function BoardPage() {
  const params = useParams()
  const boardId = params.id
  const [name, setName] = useState('Untitled board')
  const [editingName, setEditingName] = useState(false)
  const scale = useCanvasStore((s) => s.scale)
  const setTransform = useCanvasStore((s) => s.setTransform)
  const tweenCancelRef = useRef<(() => void) | null>(null)

  const animateToFitAll = useCallback(() => {
    const s = useCanvasStore.getState()
    if (s.objects.length === 0) return
    const bbox = groupBoundingBox(s.objects, 40)
    const w = bbox.right - bbox.left
    const h = bbox.bottom - bbox.top
    const vw = s.viewportSize.width
    const vh = s.viewportSize.height
    if (w <= 0 || h <= 0 || vw <= 0 || vh <= 0) return
    const nextScale = Math.max(0.1, Math.min(4, Math.min(vw / w, vh / h)))
    const cx = (bbox.left + bbox.right) / 2
    const cy = (bbox.top + bbox.bottom) / 2
    tweenCancelRef.current?.()
    tweenCancelRef.current = tweenTransform(
      { scale: s.scale, offset: s.offset },
      {
        scale: nextScale,
        offset: { x: vw / 2 - cx * nextScale, y: vh / 2 - cy * nextScale },
      },
      FIT_ALL_DURATION_MS,
      cubicBezier(...SNAP_CURVE),
      (next) => setTransform({ scale: next.scale, offset: next.offset }),
    )
  }, [setTransform])

  const animateToReset = useCallback(() => {
    const s = useCanvasStore.getState()
    tweenCancelRef.current?.()
    tweenCancelRef.current = tweenTransform(
      { scale: s.scale, offset: s.offset },
      { scale: 1, offset: { x: 0, y: 0 } },
      ZOOM_RESET_DURATION_MS,
      cubicBezier(...EASE_OUT_STANDARD),
      (next) => setTransform({ scale: next.scale, offset: next.offset }),
    )
  }, [setTransform])

  const onTitle = useCallback((next: string) => setName(next), [])

  // OAuth flow: open the centred popup, wait for the postMessage handshake,
  // refresh the connections list so the new account appears in the picker.
  // The drawer's empty-state CTA passes this through; once a user has at
  // least one connection, this isn't reachable from the picker (they'd
  // open via the toolbar button instead).
  //
  // If a `pendingPaste` is stashed (set by the canvas paste handler when a
  // Notion URL was dropped with no connection), resume the import here so
  // the user doesn't have to paste again.
  const onConnectNotion = useCallback(async () => {
    try {
      await openConnectionPopup('notion')
      const picker = useSourcePickerStore.getState()
      await picker.refreshConnections()
      const pending = useSourcePickerStore.getState().pendingPaste
      if (pending?.provider === 'notion' && boardId) {
        const fresh = useSourcePickerStore.getState()
        const conn = fresh.connections.find((c) => c.provider === 'notion')
        if (conn) {
          try {
            const data = await importNotionPage(conn.id, pending.pageId)
            const state = useCanvasStore.getState()
            const center = screenToWorld(
              { x: state.viewportSize.width / 2, y: state.viewportSize.height / 2 },
              { scale: state.scale, x: state.offset.x, y: state.offset.y },
            )
            state.commitBeforeAction()
            state.addObject(createNotionPage(center, state.objects.length, data))
            fresh.closePicker()
          } catch (importErr) {
            console.error('Resume of Notion paste failed', importErr)
          }
        }
        useSourcePickerStore.getState().setPendingPaste(null)
      }
    } catch (e) {
      console.error('Notion connect failed', e)
    }
  }, [boardId])

  // Drive OAuth — same shape as onConnectNotion. After the popup closes
  // we resume any pendingPaste targeting drive.
  const onConnectDrive = useCallback(async () => {
    try {
      await openConnectionPopup('drive')
      await useSourcePickerStore.getState().refreshConnections()
      const pending = useSourcePickerStore.getState().pendingPaste
      if (pending?.provider === 'drive' && boardId) {
        const fresh = useSourcePickerStore.getState()
        const conn = fresh.connections.find((c) => c.provider === 'drive')
        if (conn) {
          try {
            const result = await importDriveFile(conn.id, pending.fileId)
            const state = useCanvasStore.getState()
            const center = screenToWorld(
              { x: state.viewportSize.width / 2, y: state.viewportSize.height / 2 },
              { scale: state.scale, x: state.offset.x, y: state.offset.y },
            )
            state.commitBeforeAction()
            if (result.kind === 'file') {
              state.addObject(createDriveFile(center, state.objects.length, result.data))
            } else if (result.kind === 'folder') {
              state.addObject(createDriveFolder(center, state.objects.length, result.data))
            } else if (result.kind === 'pdf') {
              state.addObject({
                id: nanoid(),
                type: 'pdf',
                position: { x: center.x - 90, y: center.y - 120 },
                size: { width: 180, height: 240 },
                rotation: 0,
                zIndex: state.objects.length,
                data: result.data,
              })
            } else {
              state.addObject({
                id: nanoid(),
                type: 'image',
                position: { x: center.x - 200, y: center.y - 150 },
                size: { width: 400, height: 300 },
                rotation: 0,
                zIndex: state.objects.length,
                data: result.data,
              })
            }
            fresh.closePicker()
          } catch (importErr) {
            console.error('Resume of Drive paste failed', importErr)
          }
        }
        useSourcePickerStore.getState().setPendingPaste(null)
      }
    } catch (e) {
      console.error('Drive connect failed', e)
    }
  }, [boardId])

  if (!boardId) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 bg-background">
        <div className="max-w-sm text-center">
          <h2 className="text-base font-semibold text-foreground">Missing board ID</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            The board URL doesn't include an ID.
          </p>
          <Link
            to="/"
            className="mt-5 inline-block bg-primary text-primary-foreground px-3.5 py-2 text-sm font-medium hover:brightness-110 transition-[filter]"
            style={{ borderRadius: 'var(--radius)' }}
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    )
  }

  const commitName = async (next: string) => {
    setEditingName(false)
    const trimmed = next.trim()
    if (!trimmed || trimmed === name) {
      setName(name)
      return
    }
    setName(trimmed)
    try {
      await updateBoard(boardId, { name: trimmed })
    } catch (e) {
      console.error('rename failed', e)
    }
  }

  return (
    <div className="fixed inset-0 bg-background text-foreground">
      <BoardSync boardId={boardId} onTitle={onTitle}>
        <MoodBoardCanvas boardId={boardId} />
        <Toolbar />
        <ToastHost />
        <SourcePickerDrawer onConnectNotion={onConnectNotion} onConnectDrive={onConnectDrive} />

        <div
          className="absolute top-4 left-4 z-30 flex items-center gap-2 bg-card/95 backdrop-blur-md px-3 py-1.5 text-sm shadow-[var(--shadow-toast)]"
          style={{ borderRadius: 'var(--radius-lg)' }}
        >
          <Link
            to="/"
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Back to dashboard"
            title="Back to dashboard"
          >
            <ArrowLeft size={14} weight="regular" />
          </Link>
          {editingName ? (
            <input
              autoFocus
              defaultValue={name}
              className="bg-transparent outline-none border-b border-[var(--border)] focus:border-[var(--accent)] max-w-[240px] text-foreground transition-colors"
              onBlur={(e) => commitName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  setEditingName(false)
                }
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingName(true)}
              className="font-medium text-foreground hover:text-muted-foreground truncate max-w-[240px] transition-colors"
              title="Rename board"
            >
              {name}
            </button>
          )}
        </div>

        <div
          className="absolute bottom-4 right-4 z-20 flex items-center gap-1 bg-card/95 backdrop-blur-md px-1.5 py-1 text-xs font-mono shadow-[var(--shadow-toast)]"
          style={{ borderRadius: 'var(--radius-lg)' }}
        >
          <button
            type="button"
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
            style={{ borderRadius: 'var(--radius)' }}
            onClick={() => setTransform({ scale: Math.max(0.1, scale / 1.2) })}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <Minus size={14} weight="regular" />
          </button>
          <button
            type="button"
            className="px-2 py-1 tabular-nums text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
            style={{ borderRadius: 'var(--radius)' }}
            onClick={animateToReset}
            aria-label="Reset zoom"
            title="Reset to 100%"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
            style={{ borderRadius: 'var(--radius)' }}
            onClick={() => setTransform({ scale: Math.min(4, scale * 1.2) })}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <Plus size={14} weight="regular" />
          </button>
          <div className="mx-0.5 h-4 w-px bg-[var(--border-soft)]" />
          <button
            type="button"
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
            style={{ borderRadius: 'var(--radius)' }}
            onClick={animateToFitAll}
            aria-label="Fit all"
            title="Fit all (⌘1)"
          >
            <CornersOut size={14} weight="regular" />
          </button>
        </div>
      </BoardSync>
    </div>
  )
}
