import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { BoardSync } from '@/components/BoardSync'
import { MoodBoardCanvas } from '@/components/canvas/MoodBoardCanvas'
import { ToastHost } from '@/components/canvas/Toast'
import { Toolbar } from '@/components/canvas/Toolbar'
import { updateBoard } from '@/lib/boardsApi'
import { useCanvasStore } from '@/store/canvas'

export function BoardPage() {
  const params = useParams()
  const boardId = params.id
  const [name, setName] = useState('Untitled board')
  const [editingName, setEditingName] = useState(false)
  const scale = useCanvasStore((s) => s.scale)
  const setTransform = useCanvasStore((s) => s.setTransform)

  const onTitle = useCallback((next: string) => setName(next), [])

  if (!boardId) {
    return <div className="p-8 text-sm">Missing board id.</div>
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
        <MoodBoardCanvas />
        <Toolbar />
        <ToastHost />

        <div className="absolute top-4 left-4 z-30 flex items-center gap-2 rounded-md border bg-white/95 backdrop-blur-sm px-3 py-1.5 shadow-sm text-sm">
          <Link to="/" className="text-slate-500 hover:text-slate-900">
            ←
          </Link>
          {editingName ? (
            <input
              autoFocus
              defaultValue={name}
              className="bg-transparent outline-none border-b border-slate-300 focus:border-slate-700 max-w-[240px]"
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
              className="font-medium text-slate-900 hover:text-slate-700 truncate max-w-[240px]"
              title="Rename board"
            >
              {name}
            </button>
          )}
        </div>

        <div className="absolute bottom-4 right-4 z-20 flex items-center gap-2 rounded-md border bg-white/90 px-2 py-1 text-xs font-mono shadow-sm">
          <button
            type="button"
            className="px-1.5 py-0.5 hover:bg-slate-100 rounded"
            onClick={() => setTransform({ scale: Math.max(0.1, scale / 1.2) })}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className="px-1.5 py-0.5 hover:bg-slate-100 rounded tabular-nums"
            onClick={() => setTransform({ scale: 1, offset: { x: 0, y: 0 } })}
            aria-label="Reset zoom"
            title="Reset to 100%"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            className="px-1.5 py-0.5 hover:bg-slate-100 rounded"
            onClick={() => setTransform({ scale: Math.min(4, scale * 1.2) })}
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      </BoardSync>
    </div>
  )
}
