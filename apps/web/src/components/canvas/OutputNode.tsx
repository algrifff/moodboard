import {
  OUTPUT_FORMAT_LABELS,
  outputFormatSchema,
  outputRenderPath,
  type CanvasObject,
  type OutputCardData,
} from '@moodboard/shared'
import { ArrowSquareOut, Layout } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { OutputFrame } from '@/components/outputs/OutputFrame'
import { useBoxInteraction } from '@/hooks/useBoxInteraction'
import { OBJECT_SPAWN_DURATION, SNAP_CURVE } from '@/lib/motion'
import { SpawnRing } from './SpawnRing'

const FOOTER_PX = 34

// A design output on the board: a scaled, non-interactive preview of its
// latest composed document (sandboxed) with its name below.
// "Open" or a double-click goes to the output. The card is a drag handle
// like any other node; the preview never takes pointer events.
//
// Without `live` (the public board-share viewer, which has no session to
// render with) the card shows its name and format only.
export function OutputNode({
  object,
  scale,
  panMode,
  selected,
  live,
}: {
  object: CanvasObject
  scale: number
  panMode: boolean
  selected: boolean
  live: boolean
}) {
  const data = object.data as OutputCardData
  const HALO = 14
  const interaction = useBoxInteraction(object.id, scale, {
    panMode,
    editing: false,
    minWidth: 160,
    minHeight: 120,
    haloPx: HALO,
  })
  const format = outputFormatSchema.safeParse(data.format)
  const formatLabel = format.success ? OUTPUT_FORMAT_LABELS[format.data] : 'Output'
  const open = () => window.open(`/outputs/${data.outputId}`, '_blank', 'noopener')

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
      onDoubleClick={live ? open : undefined}
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
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <SpawnRing />
        <div className="relative min-h-0 flex-1" style={{ backgroundColor: 'var(--bg-elevated)' }}>
          {live ? (
            <OutputFrame
              src={outputRenderPath(data.outputId)}
              viewport={{ kind: 'fixed', width: data.width, height: data.height }}
              title={data.name}
              className="h-full w-full"
              shadow={false}
              maxScale={4}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Layout size={28} weight="duotone" style={{ color: 'var(--text-faint)' }} />
            </div>
          )}
        </div>
        <div
          className="flex shrink-0 items-center gap-2 px-3"
          style={{ height: FOOTER_PX, color: 'var(--text)' }}
        >
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={data.name}>
            {data.name}
          </span>
          <span className="shrink-0 text-[9.5px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
            {formatLabel}
          </span>
          {live && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                open()
              }}
              className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-[var(--text-mute)] transition-colors hover:text-foreground"
              style={{
                padding: '3px 7px',
                borderRadius: 'var(--radius)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            >
              Open
              <ArrowSquareOut size={10} weight="bold" />
            </button>
          )}
        </div>
      </div>
    </motion.div>
  )
}
