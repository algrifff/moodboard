import type { AgentId } from '@moodboard/shared'
import {
  ArrowsClockwise,
  Briefcase,
  Megaphone,
  Palette,
  PenNib,
  Play,
  Plus,
  type Icon,
  UsersThree,
  X,
} from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { EASE_OUT_STANDARD } from '@/lib/motion'

// One source of truth for agent presentation — label + icon shared by the
// row, the add-popover, and any tooltip surfaces.
export const AGENT_META: Record<AgentId, { label: string; icon: Icon }> = {
  'art-director': { label: 'Art Director', icon: Palette },
  'business-analyst': { label: 'Business Analyst', icon: Briefcase },
  'audience-profiler': { label: 'Audience Profiler', icon: UsersThree },
  'channel-strategist': { label: 'Channel Strategist', icon: Megaphone },
  copywriter: { label: 'Copywriter', icon: PenNib },
}

export const AGENT_ORDER: AgentId[] = [
  'art-director',
  'business-analyst',
  'audience-profiler',
  'channel-strategist',
  'copywriter',
]

export type PlayState = 'idle' | 'loading' | 'ready' | 'error'

const AVATAR_SIZE = 32

export function AgentRow({
  selectedIds,
  playState,
  onAddAgent,
  onRemoveAgent,
  onRun,
}: {
  selectedIds: AgentId[]
  playState: PlayState
  onAddAgent: (id: AgentId) => void
  onRemoveAgent: (id: AgentId) => void
  onRun: () => void
}) {
  const canAddMore = selectedIds.length < AGENT_ORDER.length
  const canRun = selectedIds.length > 0 && playState !== 'loading'

  return (
    <div className="flex items-center gap-1.5">
      {selectedIds.map((id) => (
        <AgentAvatar key={id} agentId={id} onRemove={() => onRemoveAgent(id)} />
      ))}
      {canAddMore && <AddAgentSlot excluded={selectedIds} onPick={(id) => onAddAgent(id)} />}
      <div className="flex-1" />
      <PlayButton state={playState} disabled={!canRun} onClick={onRun} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Selected agent — filled accent disc, icon, hover-× to remove.
// ---------------------------------------------------------------------------

function AgentAvatar({ agentId, onRemove }: { agentId: AgentId; onRemove: () => void }) {
  const meta = AGENT_META[agentId]
  const IconCmp = meta.icon
  return (
    <div className="relative group" style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}>
      <div
        className="inline-flex items-center justify-center"
        style={{
          width: AVATAR_SIZE,
          height: AVATAR_SIZE,
          borderRadius: 999,
          backgroundColor: 'var(--accent)',
          color: 'var(--bg)',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.30), inset 0 0 0 1px rgba(255, 255, 255, 0.10)',
        }}
        title={meta.label}
        aria-label={meta.label}
      >
        <IconCmp size={15} weight="bold" />
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onRemove()
        }}
        className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center"
        style={{
          width: 14,
          height: 14,
          borderRadius: 999,
          backgroundColor: 'var(--bg-card)',
          color: 'var(--text)',
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.5)',
        }}
        aria-label={`Remove ${meta.label}`}
        title={`Remove ${meta.label}`}
      >
        <X size={8} weight="bold" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty slot — dashed circle with a +. Click opens a small popover listing
// the agents not yet added.
// ---------------------------------------------------------------------------

function AddAgentSlot({
  excluded,
  onPick,
}: {
  excluded: AgentId[]
  onPick: (id: AgentId) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const available = AGENT_ORDER.filter((id) => !excluded.includes(id))

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center transition-colors text-[var(--text-mute)] hover:text-foreground"
        style={{
          width: AVATAR_SIZE,
          height: AVATAR_SIZE,
          borderRadius: 999,
          border: '1.5px dashed var(--border-soft)',
          backgroundColor: 'transparent',
        }}
        aria-label="Add an agent"
        title="Add an agent"
      >
        <Plus size={13} weight="bold" />
      </button>
      {open && available.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.14, ease: [...EASE_OUT_STANDARD] }}
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            left: 0,
            minWidth: 200,
            backgroundColor: 'var(--bg-card)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 10px 32px -12px rgba(0,0,0,0.7)',
            padding: 4,
            zIndex: 60,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {available.map((id) => {
            const meta = AGENT_META[id]
            const IconCmp = meta.icon
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  onPick(id)
                  setOpen(false)
                }}
                className="w-full flex items-center gap-2.5 px-2 py-1.5 text-[13px] text-left text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
                style={{ borderRadius: 'var(--radius)' }}
              >
                <span
                  className="inline-flex items-center justify-center shrink-0"
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 999,
                    backgroundColor: 'var(--accent)',
                    color: 'var(--bg)',
                  }}
                >
                  <IconCmp size={11} weight="bold" />
                </span>
                <span className="truncate">{meta.label}</span>
              </button>
            )
          })}
        </motion.div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Play / spinner / refresh / retry — single button, swapping icon by state.
// ---------------------------------------------------------------------------

function PlayButton({
  state,
  disabled,
  onClick,
}: {
  state: PlayState
  disabled: boolean
  onClick: () => void
}) {
  const isReady = state === 'ready'
  const isLoading = state === 'loading'
  const isError = state === 'error'
  const filled = !isReady // play (idle) and loading get filled accent; ready/error get a softer treatment
  const bg = isError ? 'var(--danger)' : isReady ? 'var(--bg-elevated)' : 'var(--accent)'
  const fg = isReady ? 'var(--text)' : 'var(--bg)'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center transition-[filter,background-color,opacity] hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100"
      style={{
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        borderRadius: 999,
        backgroundColor: bg,
        color: fg,
        boxShadow: filled
          ? '0 1px 3px rgba(0, 0, 0, 0.30), inset 0 0 0 1px rgba(255, 255, 255, 0.10)'
          : 'inset 0 0 0 1px var(--border-soft)',
      }}
      aria-label={
        isLoading
          ? 'Running…'
          : isReady
            ? 'Re-run analysis'
            : isError
              ? 'Retry analysis'
              : 'Run analysis'
      }
      title={isLoading ? 'Running…' : isReady ? 'Re-run' : isError ? 'Retry' : 'Run'}
    >
      {isLoading ? (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-[var(--bg)]/40 border-t-[var(--bg)]" />
      ) : isReady ? (
        <ArrowsClockwise size={13} weight="bold" />
      ) : (
        <Play size={13} weight="fill" />
      )}
    </button>
  )
}
