import type { CanvasObject, FigmaFrameData } from '@moodboard/shared'
import { ArrowClockwise, ArrowSquareOut, ChatCircleText } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useState } from 'react'
import { useBoxInteraction } from '@/hooks/useBoxInteraction'
import { refreshFigmaFrame } from '@/lib/figmaApi'
import { useReadOnly } from '@/lib/readOnlyContext'
import { OBJECT_SPAWN_DURATION, SNAP_CURVE } from '@/lib/motion'
import { useAgentSidebarStore } from '@/store/agentSidebar'
import { useCanvasStore } from '@/store/canvas'
import { FigmaLogo } from './sourceLogos'
import { SpawnRing } from './SpawnRing'
import { showToast } from './Toast'

const FOOTER_PX = 34

// A frame imported from Figma: its render (saved to the asset library) with
// the frame's name below, a Figma chip, and three small actions — refresh from
// the file, start an agent thread with this frame as the visual reference, and
// open it in Figma. The picture and the footer are a drag handle like any other
// card; only the buttons take clicks.
export function FigmaNode({
  object,
  scale,
  panMode,
  selected,
  boardId,
}: {
  object: CanvasObject
  scale: number
  panMode: boolean
  selected: boolean
  boardId: string
}) {
  const live = !useReadOnly()
  const data = object.data as FigmaFrameData
  const updateObject = useCanvasStore((s) => s.updateObject)
  const startFromFigmaFrame = useAgentSidebarStore((s) => s.startFromFigmaFrame)
  const [refreshing, setRefreshing] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)

  const HALO = 14
  const interaction = useBoxInteraction(object.id, scale, {
    panMode,
    editing: false,
    minWidth: 160,
    minHeight: 120,
    haloPx: HALO,
  })

  const onRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (refreshing) return
    setRefreshing(true)
    try {
      const fresh = await refreshFigmaFrame(boardId, object.id)
      if (!fresh.changed) {
        showToast(`“${data.name}” is up to date`)
        return
      }
      useCanvasStore.getState().commitBeforeAction()
      updateObject(object.id, { data: fresh.data })
      setImageFailed(false)
      showToast(`Refreshed “${data.name}” from Figma`)
    } catch (err) {
      showToast(`Couldn’t refresh: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setRefreshing(false)
    }
  }

  const stop = (e: React.PointerEvent) => e.stopPropagation()

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: OBJECT_SPAWN_DURATION, ease: [...SNAP_CURVE] }}
      onPointerEnter={interaction.onPointerEnter}
      onPointerLeave={interaction.onPointerLeave}
      onPointerMove={interaction.onPointerMove}
      onPointerDown={interaction.onPointerDown}
      onPointerUp={interaction.onPointerUp}
      data-figma-frame={data.nodeId}
      style={{
        position: 'absolute',
        left: object.position.x - HALO,
        top: object.position.y - HALO,
        width: object.size.width + HALO * 2,
        height: object.size.height + HALO * 2,
        padding: HALO,
        boxSizing: 'border-box',
        cursor: interaction.cursor,
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          backgroundColor: 'var(--bg-card)',
          boxShadow: 'var(--shadow-card)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          outline: selected || interaction.nearEdge ? '2px solid var(--accent)' : 'none',
          outlineOffset: 3,
          color: 'var(--text)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <SpawnRing />
        <div className="relative min-h-0 flex-1" style={{ backgroundColor: 'var(--bg-elevated)' }}>
          {imageFailed ? (
            <div className="flex h-full w-full items-center justify-center px-3 text-center text-[11px] text-[var(--text-faint)]">
              The render is missing — refresh to make a new one.
            </div>
          ) : (
            <img
              src={data.url}
              alt={`${data.name} — ${data.fileName}`}
              draggable={false}
              onError={() => setImageFailed(true)}
              className="h-full w-full select-none object-contain"
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 px-2.5" style={{ height: FOOTER_PX }}>
          <FigmaLogo size={11} />
          <span
            className="min-w-0 flex-1 truncate text-[12.5px] font-medium"
            title={`${data.name} — ${data.fileName}`}
          >
            {data.name}
          </span>
          {live && (
            <>
              <CardButton label="Refresh from Figma" onPointerDown={stop} onClick={onRefresh}>
                <ArrowClockwise
                  size={12}
                  style={{ animation: refreshing ? 'mb-spin 800ms linear infinite' : 'none' }}
                />
              </CardButton>
              <CardButton
                label="Use as reference"
                onPointerDown={stop}
                onClick={(e) => {
                  e.stopPropagation()
                  startFromFigmaFrame(object)
                }}
              >
                <ChatCircleText size={12} />
              </CardButton>
            </>
          )}
          <a
            href={data.figmaUrl}
            target="_blank"
            rel="noreferrer noopener"
            onPointerDown={stop}
            onClick={(e) => e.stopPropagation()}
            aria-label="Open in Figma"
            title="Open in Figma"
            className="inline-flex shrink-0 items-center justify-center text-[var(--text-mute)] transition-colors hover:text-foreground"
            style={{ width: 22, height: 22, borderRadius: 999 }}
          >
            <ArrowSquareOut size={12} />
          </a>
        </div>
      </div>
    </motion.div>
  )
}

function CardButton({
  label,
  onClick,
  onPointerDown,
  children,
}: {
  label: string
  onClick: (e: React.MouseEvent) => void
  onPointerDown: (e: React.PointerEvent) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={onPointerDown}
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 items-center justify-center text-[var(--text-mute)] transition-colors hover:text-foreground"
      style={{ width: 22, height: 22, borderRadius: 999 }}
    >
      {children}
    </button>
  )
}
