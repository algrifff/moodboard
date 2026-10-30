import type {
  AgentId,
  AIAnalysis,
  SectionedParagraphs,
  SynthesisBrief,
  VideoEditorBreakdown,
} from '@moodboard/shared'
import { ArrowsOutSimple, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AI_PANEL_DURATION, EASE_OUT_STANDARD } from '@/lib/motion'
import { AgentRow, type PlayState } from './AgentRow'
import { ArtDirectorGlance, ArtDirectorReadout } from './readouts/ArtDirectorReadout'
import { BriefGlance, BriefReadout } from './readouts/BriefReadout'
import { SectionedGlance, SectionedReadout } from './readouts/SectionedReadout'
import { VideoEditorGlance, VideoEditorReadout } from './readouts/VideoEditorReadout'

// Inline panel width bounds. Default sits at 320 to match the original
// fixed layout; drag the right edge to widen for long-form readouts.
const DEFAULT_PANEL_WIDTH = 320
const MIN_PANEL_WIDTH = 280
const MAX_PANEL_WIDTH = 640

// ---------------------------------------------------------------------------
// Per-agent slot state
// ---------------------------------------------------------------------------

export type SlotState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready-ad'; data: AIAnalysis; cached: boolean }
  | { kind: 'ready-sec'; data: SectionedParagraphs; cached: boolean }
  | { kind: 'ready-video'; data: VideoEditorBreakdown; cached: boolean }
  | { kind: 'ready-brief'; data: SynthesisBrief; cached: boolean }
  | { kind: 'error'; message: string }

// ---------------------------------------------------------------------------
// Panel — avatar row on top, summary card below.
// ---------------------------------------------------------------------------

export function AIAnalysisPanel({
  bounds,
  scale,
  offset,
  displaySlot,
  selectedAgentIds,
  selectionMatchesDisplay,
  logoOverrideOptions,
  onChangeLogos,
  onPatchBrief,
  onAddAgent,
  onRemoveAgent,
  onRun,
}: {
  bounds: { left: number; top: number; right: number; bottom: number }
  scale: number
  offset: { x: number; y: number }
  // The single slot this panel renders. Decoupled from selection — only
  // a fresh analysis run replaces it. Set by GroupsLayer's displayByGroup.
  displaySlot: SlotState
  selectedAgentIds: AgentId[]
  // True when the current selection matches the agents that produced
  // `displaySlot`. Drives the play button: matches → refresh icon (re-run
  // same combo); differs → play icon (the click will run something new).
  selectionMatchesDisplay: boolean
  // Images in this group the user could pin as the logo (overrides the
  // AD's pick). Empty when the group has no images.
  logoOverrideOptions: { url: string }[]
  onChangeLogos: (urls: string[]) => void
  // Patch the entire SynthesisBrief in place — used by inline-editable
  // fields in the BriefReadout. Bubbles up to GroupsLayer's
  // displayByGroup, which persists via the existing save effect.
  onPatchBrief: (brief: SynthesisBrief) => void
  onAddAgent: (id: AgentId) => void
  onRemoveAgent: (id: AgentId) => void
  onRun: () => void
}) {
  // Anchor on the right edge of the group, below the palette swatches.
  const screenRight = bounds.right * scale + offset.x
  const screenTop = bounds.top * scale + offset.y
  const PALETTE_HEIGHT = 32
  const PALETTE_GAP = 12
  const left = screenRight + 9
  const top = screenTop + PALETTE_HEIGHT + PALETTE_GAP

  // Resizable inline width + slide-out drawer toggle. Both live local to the
  // panel; they intentionally don't survive a group's member-set changing
  // because the panel's key flips and it remounts.
  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH)
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Drag the right edge to widen. Capture initial mouse X + width on
  // pointerdown, listen on document so the drag survives the cursor leaving
  // the handle, restore body cursor/select on release.
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = width
    const prevUserSelect = document.body.style.userSelect
    const prevCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ew-resize'
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(
        MAX_PANEL_WIDTH,
        Math.max(MIN_PANEL_WIDTH, startWidth + (ev.clientX - startX)),
      )
      setWidth(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = prevCursor
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Esc closes the drawer.
  useEffect(() => {
    if (!isFullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isFullscreen])

  // The panel renders whatever `displaySlot` says — selection is just
  // metadata for what the play button will do next.
  const activeState: SlotState = displaySlot

  // Loading + error states track the slot directly. "ready" only when the
  // current selection actually matches what produced the displayed result
  // — otherwise clicking play runs a new combo, not a refresh.
  const isReadyKind =
    activeState.kind === 'ready-ad' ||
    activeState.kind === 'ready-sec' ||
    activeState.kind === 'ready-video' ||
    activeState.kind === 'ready-brief'
  const playState: PlayState =
    activeState.kind === 'loading'
      ? 'loading'
      : activeState.kind === 'error' && selectionMatchesDisplay
        ? 'error'
        : isReadyKind && selectionMatchesDisplay
          ? 'ready'
          : 'idle'

  // Bump z-index when the user has engaged with this panel so the active
  // panel sits above any neighbouring group's idle panel.
  const hasActivity = selectedAgentIds.length > 0 || activeState.kind !== 'idle'

  return (
    <>
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: AI_PANEL_DURATION, ease: EASE_OUT_STANDARD }}
        style={{
          position: 'absolute',
          left,
          top,
          width,
          pointerEvents: 'auto',
          zIndex: hasActivity ? 25 : 15,
        }}
        className="flex flex-col gap-2"
      >
        <AgentRow
          selectedIds={selectedAgentIds}
          playState={playState}
          onAddAgent={onAddAgent}
          onRemoveAgent={onRemoveAgent}
          onRun={onRun}
        />
        <SummaryCard
          state={activeState}
          empty={selectedAgentIds.length === 0 && activeState.kind === 'idle'}
          onFullscreen={() => setIsFullscreen(true)}
          logoOverrideOptions={logoOverrideOptions}
          onChangeLogos={onChangeLogos}
          onPatchBrief={onPatchBrief}
        />
        <ResizeHandle onMouseDown={onResizeStart} />
      </motion.div>
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {isFullscreen && (
              <motion.div
                key="fullscreen-scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22, ease: EASE_OUT_STANDARD }}
                onClick={() => setIsFullscreen(false)}
                style={{
                  position: 'fixed',
                  inset: 0,
                  backgroundColor: 'var(--scrim)',
                  zIndex: 79,
                  pointerEvents: 'auto',
                }}
                aria-hidden
              />
            )}
            {isFullscreen && (
              <FullscreenDrawer
                key="fullscreen-drawer"
                state={activeState}
                onClose={() => setIsFullscreen(false)}
                logoOverrideOptions={logoOverrideOptions}
                onChangeLogos={onChangeLogos}
                onPatchBrief={onPatchBrief}
              />
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  )
}

// Right-edge drag affordance. Sits outside the card padding so users hit a
// generous 8-px target; a 1.5-px accent line fades in on hover so the
// affordance is discoverable without adding chrome at rest.
function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: -4,
        width: 8,
        cursor: 'ew-resize',
        zIndex: 1,
      }}
      aria-label="Resize panel"
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          right: 4,
          width: 1.5,
          backgroundColor: hover ? 'var(--accent)' : 'transparent',
          transition: 'background-color 120ms',
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// The summary card under the avatar row. Idle → dashed; otherwise solid.
// ---------------------------------------------------------------------------

function SummaryCard({
  state,
  empty,
  onFullscreen,
  logoOverrideOptions,
  onChangeLogos,
  onPatchBrief,
}: {
  state: SlotState
  empty: boolean
  onFullscreen: () => void
  logoOverrideOptions: { url: string }[]
  onChangeLogos: (urls: string[]) => void
  onPatchBrief: (brief: SynthesisBrief) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const isDone =
    state.kind === 'ready-ad' ||
    state.kind === 'ready-sec' ||
    state.kind === 'ready-video' ||
    state.kind === 'ready-brief'
  const isIdle = state.kind === 'idle'

  const idleStyle: React.CSSProperties = {
    backgroundColor: 'transparent',
    borderRadius: 'var(--radius-lg)',
    border: '1.5px dashed var(--border-soft)',
    padding: 12,
    color: 'var(--text-mute)',
    fontSize: 13,
    lineHeight: 1.5,
  }
  const activeStyle: React.CSSProperties = {
    backgroundColor: 'var(--bg-card)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: 'var(--shadow-card)',
    padding: 12,
    color: 'var(--text)',
    fontSize: 13,
    lineHeight: 1.5,
  }

  if (empty) {
    return (
      <div style={idleStyle} className="text-center">
        <span className="text-[12.5px]">Add an agent and hit play to read this group.</span>
      </div>
    )
  }

  return (
    <div style={isIdle ? idleStyle : activeStyle}>
      {/* Header — only the expand affordance when ready; otherwise a status
          line (loading / idle / error) without any controls (the play button
          on the row above handles run/re-run/retry). */}
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-[12.5px] uppercase tracking-[0.12em] ${
            state.kind === 'loading' ? 'text-shimmer' : 'text-[var(--text-mute)]'
          }`}
        >
          {state.kind === 'loading'
            ? 'Reading…'
            : state.kind === 'error'
              ? 'Error'
              : isDone
                ? expanded
                  ? 'Summary'
                  : 'At a glance'
                : 'Ready to run'}
        </span>
        {isDone && (
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onFullscreen}
              className="inline-flex items-center justify-center text-[var(--text-faint)] hover:text-foreground transition-colors"
              style={{ width: 16, height: 16 }}
              aria-label="Open as side panel"
              title="Open as side panel"
            >
              <ArrowsOutSimple size={13} weight="bold" />
            </button>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] text-[var(--text-faint)] hover:text-foreground transition-colors"
            >
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-[var(--border-soft)]">
        {state.kind === 'ready-ad' &&
          (expanded ? (
            <ArtDirectorReadout data={state.data} />
          ) : (
            <ArtDirectorGlance data={state.data} />
          ))}
        {state.kind === 'ready-sec' &&
          (expanded ? (
            <SectionedReadout data={state.data} />
          ) : (
            <SectionedGlance data={state.data} />
          ))}
        {state.kind === 'ready-video' &&
          (expanded ? (
            <VideoEditorReadout data={state.data} />
          ) : (
            <VideoEditorGlance data={state.data} />
          ))}
        {state.kind === 'ready-brief' &&
          (expanded ? (
            <BriefReadout
              data={state.data}
              logoOverrideOptions={logoOverrideOptions}
              onChangeLogos={onChangeLogos}
              onPatchBrief={onPatchBrief}
            />
          ) : (
            <BriefGlance data={state.data} />
          ))}
        {state.kind === 'error' && (
          <div className="text-[11px] text-destructive break-words">{state.message}</div>
        )}
        {state.kind === 'idle' && (
          <div className="text-[11px] text-[var(--text-faint)]">Hit the play button to run.</div>
        )}
        {state.kind === 'loading' && (
          <div className="text-[11px] text-[var(--text-faint)]">
            This usually takes a few seconds.
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fullscreen-ish side peek. Slides in from the viewport's right edge to a
// generous reading width. Reuses the readouts above so single-agent and
// combined synthesis content render identically — just with more room.
// ---------------------------------------------------------------------------

function FullscreenDrawer({
  state,
  onClose,
  logoOverrideOptions,
  onChangeLogos,
  onPatchBrief,
}: {
  state: SlotState
  onClose: () => void
  logoOverrideOptions: { url: string }[]
  onChangeLogos: (urls: string[]) => void
  onPatchBrief: (brief: SynthesisBrief) => void
}) {
  return (
    <motion.div
      data-canvas-scrollable
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ duration: 0.32, ease: EASE_OUT_STANDARD }}
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(720px, max(480px, 50vw))',
        backgroundColor: 'var(--bg-card)',
        boxShadow: 'var(--shadow-drawer)',
        zIndex: 80,
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: 'auto',
      }}
    >
      <div
        className="flex items-center justify-between gap-2"
        style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--border-soft)',
        }}
      >
        <span className="text-[12.5px] uppercase tracking-[0.12em] text-[var(--text-mute)]">
          {state.kind === 'loading' ? 'Reading…' : state.kind === 'error' ? 'Error' : 'Summary'}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center justify-center text-[var(--text-mute)] hover:text-foreground transition-colors"
          style={{ width: 28, height: 28, borderRadius: 999 }}
          aria-label="Close side panel"
          title="Close (Esc)"
        >
          <X size={14} weight="bold" />
        </button>
      </div>
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px 24px 32px',
          fontSize: 14,
          lineHeight: 1.65,
          color: 'var(--text)',
        }}
      >
        {state.kind === 'ready-ad' && <ArtDirectorReadout data={state.data} />}
        {state.kind === 'ready-sec' && <SectionedReadout data={state.data} />}
        {state.kind === 'ready-video' && <VideoEditorReadout data={state.data} />}
        {state.kind === 'ready-brief' && (
          <BriefReadout
            data={state.data}
            logoOverrideOptions={logoOverrideOptions}
            onChangeLogos={onChangeLogos}
            onPatchBrief={onPatchBrief}
          />
        )}
        {state.kind === 'error' && (
          <div className="text-[13px] text-destructive break-words">{state.message}</div>
        )}
        {state.kind === 'loading' && (
          <div className="text-[13px] text-[var(--text-faint)]">
            This usually takes a few seconds.
          </div>
        )}
        {state.kind === 'idle' && (
          <div className="text-[13px] text-[var(--text-faint)]">Hit the play button to run.</div>
        )}
      </div>
    </motion.div>
  )
}
