import { ArrowsOutSimple, Sparkle } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { AI_PANEL_DURATION, EASE_OUT_STANDARD } from '@/lib/motion'
import type { SlotState } from '@/store/groupPanels'
import { ArtDirectorGlance } from './readouts/ArtDirectorReadout'
import { BriefGlance } from './readouts/BriefReadout'
import { SectionedGlance } from './readouts/SectionedReadout'
import { VideoEditorGlance } from './readouts/VideoEditorReadout'

const PANEL_WIDTH = 260
const PALETTE_HEIGHT = 32
const PALETTE_GAP = 12

const READY_LABEL: Partial<Record<SlotState['kind'], string>> = {
  'ready-brief': 'Brief',
  'ready-ad': 'Art Director',
  'ready-sec': 'Specialist read',
  'ready-video': 'Video breakdown',
}

// The group's glance on the canvas: what the group currently shows, at a
// size that stays out of the way. Running agents and the full readout live
// in the agent sidebar — clicking opens it there.
export function AIAnalysisPanel({
  bounds,
  scale,
  offset,
  slot,
  active,
  onOpen,
  onAsk,
}: {
  bounds: { left: number; top: number; right: number; bottom: number }
  scale: number
  offset: { x: number; y: number }
  slot: SlotState
  // The sidebar is showing this group's readout.
  active: boolean
  onOpen: () => void
  onAsk: () => void
}) {
  // Anchor on the right edge of the group, below the palette swatches.
  const left = bounds.right * scale + offset.x + 9
  const top = bounds.top * scale + offset.y + PALETTE_HEIGHT + PALETTE_GAP

  return (
    <motion.div
      initial={{ y: 12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: AI_PANEL_DURATION, ease: EASE_OUT_STANDARD }}
      style={{
        position: 'absolute',
        left,
        top,
        width: PANEL_WIDTH,
        pointerEvents: 'auto',
        zIndex: slot.kind === 'idle' ? 15 : 25,
      }}
    >
      {slot.kind === 'idle' ? (
        <button
          type="button"
          onClick={onAsk}
          className="group inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] text-[var(--text-mute)] hover:text-foreground hover:border-[var(--accent)] transition-colors"
          style={{ borderRadius: 'var(--radius-lg)', border: '1.5px dashed var(--border-soft)' }}
        >
          <Sparkle size={13} weight="fill" className="text-[var(--accent)]" />
          Ask the agent for a brief
        </button>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onOpen()
          }}
          className="cursor-pointer text-left"
          style={{
            backgroundColor: 'var(--bg-card)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: active
              ? '0 0 0 1.5px var(--accent), var(--shadow-card)'
              : 'var(--shadow-card)',
            padding: 12,
            color: 'var(--text)',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span
              className={`text-[11.5px] uppercase tracking-[0.12em] ${
                slot.kind === 'loading' ? 'text-shimmer' : 'text-[var(--text-mute)]'
              }`}
            >
              {slot.kind === 'loading'
                ? 'Reading…'
                : slot.kind === 'error'
                  ? 'Error'
                  : READY_LABEL[slot.kind]}
            </span>
            <span
              className="inline-flex items-center gap-1 text-[11px] text-[var(--text-faint)]"
              title="Open in the sidebar"
            >
              Open
              <ArrowsOutSimple size={12} weight="bold" />
            </span>
          </div>
          {slot.kind !== 'loading' && (
            <div className="mt-2.5 pt-2.5 border-t border-[var(--border-soft)]">
              {slot.kind === 'ready-brief' && <BriefGlance data={slot.data} />}
              {slot.kind === 'ready-ad' && <ArtDirectorGlance data={slot.data} />}
              {slot.kind === 'ready-sec' && <SectionedGlance data={slot.data} />}
              {slot.kind === 'ready-video' && <VideoEditorGlance data={slot.data} />}
              {slot.kind === 'error' && (
                <div className="text-[11.5px] text-destructive break-words line-clamp-3">
                  {slot.message}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </motion.div>
  )
}
