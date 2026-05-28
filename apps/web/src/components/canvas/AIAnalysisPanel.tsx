import type { AgentId, AIAnalysis, SectionedParagraphs, SynthesisBrief } from '@moodboard/shared'
import { ArrowsOutSimple, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AI_PANEL_DURATION, EASE_OUT_STANDARD } from '@/lib/motion'
import { AgentRow, AGENT_ORDER, type PlayState } from './AgentRow'

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
  | { kind: 'ready-brief'; data: SynthesisBrief; cached: boolean }
  | { kind: 'error'; message: string }

// Re-exported for callers that want to iterate canonical agent order without
// pulling the AgentRow module directly.
export { AGENT_ORDER }

// ---------------------------------------------------------------------------
// Panel — avatar row on top, summary card below.
// ---------------------------------------------------------------------------

export function AIAnalysisPanel({
  bounds,
  scale,
  offset,
  slots,
  combinedSlot,
  selectedAgentIds,
  onAddAgent,
  onRemoveAgent,
  onRun,
}: {
  bounds: { left: number; top: number; right: number; bottom: number }
  scale: number
  offset: { x: number; y: number }
  slots: Record<AgentId, SlotState>
  combinedSlot: SlotState
  selectedAgentIds: AgentId[]
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

  // Determine what to show in the summary card. Single agent → that agent's
  // slot; 2+ agents → the combined slot; empty → idle.
  const activeState: SlotState =
    selectedAgentIds.length === 0
      ? { kind: 'idle' }
      : selectedAgentIds.length === 1
        ? (slots[selectedAgentIds[0]!] ?? { kind: 'idle' })
        : combinedSlot

  const playState: PlayState =
    activeState.kind === 'loading'
      ? 'loading'
      : activeState.kind === 'ready-ad' ||
          activeState.kind === 'ready-sec' ||
          activeState.kind === 'ready-brief'
        ? 'ready'
        : activeState.kind === 'error'
          ? 'error'
          : 'idle'

  // Bump z-index when the user has engaged with this panel so the active
  // panel sits above any neighbouring group's idle panel.
  const hasActivity =
    selectedAgentIds.length > 0 || playState !== 'idle' || isAnythingActive(slots, combinedSlot)

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
          empty={selectedAgentIds.length === 0}
          onFullscreen={() => setIsFullscreen(true)}
        />
        <ResizeHandle onMouseDown={onResizeStart} />
      </motion.div>
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {isFullscreen && (
              <FullscreenDrawer state={activeState} onClose={() => setIsFullscreen(false)} />
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

function isAnythingActive(slots: Record<AgentId, SlotState>, combinedSlot: SlotState): boolean {
  if (
    combinedSlot.kind === 'loading' ||
    combinedSlot.kind === 'ready-brief' ||
    combinedSlot.kind === 'error'
  )
    return true
  for (const a of AGENT_ORDER) {
    const k = slots[a]?.kind
    if (k === 'loading' || k === 'ready-ad' || k === 'ready-sec' || k === 'error') {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// The summary card under the avatar row. Idle → dashed; otherwise solid.
// ---------------------------------------------------------------------------

function SummaryCard({
  state,
  empty,
  onFullscreen,
}: {
  state: SlotState
  empty: boolean
  onFullscreen: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const isDone =
    state.kind === 'ready-ad' || state.kind === 'ready-sec' || state.kind === 'ready-brief'
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
    boxShadow: '0 8px 32px -12px rgba(0,0,0,0.6)',
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
        {state.kind === 'ready-brief' &&
          (expanded ? <BriefReadout data={state.data} /> : <BriefGlance data={state.data} />)}
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
// Renderers — Art Director (existing rich shape) + generic sectioned
// ---------------------------------------------------------------------------

function ArtDirectorReadout({ data }: { data: AIAnalysis }) {
  const hasText = data.tropes.length > 0 || data.hooks.length > 0 || data.statements.length > 0

  return (
    <div className="space-y-3">
      <div
        className="font-medium text-foreground"
        style={{
          fontFamily: 'ui-serif, Georgia, "Iowan Old Style", serif',
          fontSize: 15,
          lineHeight: 1.35,
        }}
      >
        {data.headline}
      </div>
      <PaletteRow palette={data.palette} />

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium text-foreground">{data.mood}</span>
          <span className="text-[11px] text-muted-foreground">{data.tone}</span>
        </div>
        <p className="mt-1 text-[var(--text-soft)]">{data.summary}</p>
      </div>

      {data.references.length > 0 && (
        <Section heading="In conversation with">
          <Chips items={data.references} />
        </Section>
      )}
      {data.typographicVoice.length > 0 && (
        <Section heading="Typographic voice">
          <BulletList items={data.typographicVoice} prefix="–" />
        </Section>
      )}
      {data.tensions.length > 0 && (
        <Section heading="Tensions">
          <BulletList items={data.tensions} prefix="↔" />
        </Section>
      )}
      {data.risks.length > 0 && (
        <Section heading="Risks">
          <ul className="mt-1 text-[12.5px] text-[var(--warning)] space-y-0.5">
            {data.risks.map((r, i) => (
              <li key={i}>! {r}</li>
            ))}
          </ul>
        </Section>
      )}

      <div className="grid grid-cols-2 gap-3">
        {data.adjectives.length > 0 && (
          <Section heading="Adjectives">
            <Chips items={data.adjectives} />
          </Section>
        )}
        {data.emotions.length > 0 && (
          <Section heading="Emotions">
            <Chips items={data.emotions} />
          </Section>
        )}
      </div>

      {data.themes.length > 0 && (
        <Section heading="Themes">
          <Chips items={data.themes} />
        </Section>
      )}

      {hasText && (
        <div className="space-y-3 pt-2 border-t border-[var(--border-soft)]">
          {data.hooks.length > 0 && (
            <Section heading="Hooks">
              <ul className="mt-1 text-[12.5px] text-foreground font-medium space-y-0.5">
                {data.hooks.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            </Section>
          )}
          {data.statements.length > 0 && (
            <Section heading="Statements">
              <ul className="mt-1 text-[12.5px] text-[var(--text-soft)] list-disc list-inside space-y-0.5 marker:text-[var(--text-faint)]">
                {data.statements.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </Section>
          )}
          {data.tropes.length > 0 && (
            <Section heading="Tropes / watch for">
              <Chips items={data.tropes} tone="warn" />
            </Section>
          )}
        </div>
      )}
    </div>
  )
}

function SectionedReadout({ data }: { data: SectionedParagraphs }) {
  return (
    <div className="space-y-3">
      {data.sections.map((s, i) => (
        <div key={i}>
          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)] font-semibold">
            {s.heading}
          </div>
          <p
            className="mt-1 text-[12.5px] text-[var(--text-soft)] whitespace-pre-line"
            style={{ lineHeight: 1.55 }}
          >
            {s.body}
          </p>
        </div>
      ))}
    </div>
  )
}

function ArtDirectorGlance({ data }: { data: AIAnalysis }) {
  return (
    <div className="space-y-2">
      <div
        className="font-medium text-foreground"
        style={{
          fontFamily: 'ui-serif, Georgia, "Iowan Old Style", serif',
          fontSize: 15,
          lineHeight: 1.35,
        }}
      >
        {data.headline}
      </div>
      <PaletteRow palette={data.palette} />
    </div>
  )
}

function SectionedGlance({ data }: { data: SectionedParagraphs }) {
  const first = data.sections[0]
  if (!first) return null
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)] font-semibold">
        {first.heading}
      </div>
      <p
        className="text-[12.5px] text-[var(--text-soft)]"
        style={{
          lineHeight: 1.55,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {first.body}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)] font-semibold">
        {heading}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function PaletteRow({ palette }: { palette: string[] }) {
  if (palette.length === 0) return null
  return (
    <div className="flex items-center gap-1.5">
      {palette.map((hex, i) => (
        <span
          key={`${hex}-${i}`}
          title={hex.toUpperCase()}
          style={{
            display: 'inline-block',
            width: 18,
            height: 18,
            borderRadius: 'var(--radius)',
            backgroundColor: hex,
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)',
          }}
        />
      ))}
    </div>
  )
}

function BulletList({ items, prefix }: { items: string[]; prefix: string }) {
  return (
    <ul className="mt-1 text-[12.5px] text-[var(--text-soft)] space-y-0.5">
      {items.map((t, i) => (
        <li key={i}>
          {prefix} {t}
        </li>
      ))}
    </ul>
  )
}

function Chips({
  items,
  tone = 'neutral',
}: {
  items: string[]
  tone?: 'neutral' | 'warn' | 'positive'
}) {
  if (items.length === 0) return null
  const cls =
    tone === 'warn'
      ? 'bg-[oklch(35%_0.12_75)] text-[var(--warning)]'
      : tone === 'positive'
        ? 'bg-[oklch(28%_0.10_155)] text-[var(--success)]'
        : 'bg-[var(--bg-elevated)] text-[var(--text-soft)]'
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((t, i) => (
        <span
          key={`${t}-${i}`}
          className={`inline-block px-2 py-0.5 text-[11px] ${cls}`}
          style={{ borderRadius: 'var(--radius)' }}
        >
          {t}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fullscreen-ish side peek. Slides in from the viewport's right edge to a
// generous reading width. Reuses the readouts above so single-agent and
// combined synthesis content render identically — just with more room.
// ---------------------------------------------------------------------------

function FullscreenDrawer({ state, onClose }: { state: SlotState; onClose: () => void }) {
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
        boxShadow: '-12px 0 48px -12px rgba(0,0,0,0.7)',
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
        {state.kind === 'ready-brief' && <BriefReadout data={state.data} />}
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

// ---------------------------------------------------------------------------
// Brief renderer — the synthesiser's structured output rendered as a
// presentation-style layout. Every block self-skips when its data is empty
// so a 2-agent synthesis doesn't drag empty sections through the page.
// ---------------------------------------------------------------------------

function BriefReadout({ data }: { data: SynthesisBrief }) {
  const hasPositioning =
    data.positioning.model.trim().length > 0 ||
    data.positioning.niche.trim().length > 0 ||
    data.positioning.category.trim().length > 0
  return (
    <div className="space-y-5">
      {data.throughline.trim().length > 0 && (
        <ThroughlineBlock text={data.throughline} source={data.throughlineSource} />
      )}
      {hasPositioning && <PositioningBlock data={data.positioning} />}
      {data.palette.length > 0 && <PaletteBlock items={data.palette} />}
      {data.typography.feel.trim().length > 0 && (
        <TypographyBlock feel={data.typography.feel} samples={data.typography.samples} />
      )}
      {data.references.length > 0 && <ReferencesBlock items={data.references} />}
      {data.tensions.length > 0 && <TensionsBlock items={data.tensions} />}
      {data.audiences.length > 0 && <AudienceBlock items={data.audiences} />}
      {data.channels.length > 0 && <ChannelBlock items={data.channels} />}
      {data.hooks.length > 0 && <HooksBlock items={data.hooks} />}
      {data.bodyCopy.trim().length > 0 && <BodyCopyBlock text={data.bodyCopy} />}
      {data.statements.length > 0 && <StatementsBlock items={data.statements} />}
      {data.watchFors.length > 0 && <WatchForsBlock items={data.watchFors} />}
      {data.notes.length > 0 && <NotesBlock items={data.notes} />}
    </div>
  )
}

// Glance — collapsed snapshot. Throughline + a thin palette row if present.
function BriefGlance({ data }: { data: SynthesisBrief }) {
  return (
    <div className="space-y-2">
      {data.throughline.trim().length > 0 && (
        <div
          className="font-medium text-foreground"
          style={{
            fontFamily: 'ui-serif, Georgia, "Iowan Old Style", serif',
            fontSize: 15,
            lineHeight: 1.4,
          }}
        >
          {data.throughline}
        </div>
      )}
      {data.palette.length > 0 && (
        <div className="flex items-center gap-1.5">
          {data.palette.slice(0, 6).map((p, i) => (
            <span
              key={`${p.hex}-${i}`}
              title={`${p.hex.toUpperCase()} — ${p.role}`}
              style={{
                display: 'inline-block',
                width: 18,
                height: 18,
                borderRadius: 'var(--radius)',
                backgroundColor: p.hex,
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)',
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Brief blocks — each one self-contained, no shared scaffolding so the
// visual treatment per block can stay opinionated.
// ---------------------------------------------------------------------------

function BlockHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)] font-semibold">
      {children}
    </div>
  )
}

function ThroughlineBlock({ text, source }: { text: string; source: string }) {
  return (
    <div
      style={{
        padding: '14px 14px 12px',
        borderLeft: '2px solid var(--accent)',
        backgroundColor: 'var(--accent-fade)',
        borderRadius: 'var(--radius)',
      }}
    >
      <BlockHeading>The throughline</BlockHeading>
      <div
        className="mt-1.5 font-medium text-foreground"
        style={{
          fontFamily: 'ui-serif, Georgia, "Iowan Old Style", serif',
          fontSize: 16,
          lineHeight: 1.4,
        }}
      >
        {text}
      </div>
      {source.trim().length > 0 && (
        <div className="mt-2 text-[11px] text-[var(--text-faint)]">— {source}</div>
      )}
    </div>
  )
}

function PaletteBlock({ items }: { items: { hex: string; role: string; note: string }[] }) {
  return (
    <div>
      <BlockHeading>Palette</BlockHeading>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2.5">
        {items.map((p, i) => (
          <div key={`${p.hex}-${i}`} className="flex items-start gap-2.5" style={{ minWidth: 0 }}>
            <span
              title={p.hex.toUpperCase()}
              style={{
                flex: '0 0 auto',
                display: 'inline-block',
                width: 28,
                height: 28,
                borderRadius: 'var(--radius)',
                backgroundColor: p.hex,
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)',
              }}
            />
            <div className="min-w-0">
              <div className="text-[11px] text-foreground font-medium leading-tight">{p.role}</div>
              <div
                className="text-[11px] text-[var(--text-mute)] font-mono leading-tight"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {p.hex.toUpperCase()}
              </div>
              {p.note.trim().length > 0 && (
                <div className="mt-0.5 text-[11px] text-[var(--text-soft)] leading-snug">
                  {p.note}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const SAMPLE_SIZES: Record<string, { size: number; family: string; weight: number }> = {
  display: {
    size: 26,
    family: 'ui-serif, Georgia, "Iowan Old Style", serif',
    weight: 500,
  },
  subhead: {
    size: 18,
    family: 'ui-serif, Georgia, "Iowan Old Style", serif',
    weight: 500,
  },
  body: { size: 14, family: 'inherit', weight: 400 },
  caption: { size: 11, family: 'inherit', weight: 500 },
}

function TypographyBlock({
  feel,
  samples,
}: {
  feel: string
  samples: { role: string; text: string }[]
}) {
  return (
    <div>
      <BlockHeading>Typography</BlockHeading>
      <div className="mt-1.5 text-[12.5px] text-[var(--text-soft)] italic">{feel}</div>
      {samples.length > 0 && (
        <div
          className="mt-3 space-y-2.5"
          style={{
            padding: '14px 14px',
            borderRadius: 'var(--radius)',
            backgroundColor: 'var(--bg-elevated)',
          }}
        >
          {samples.map((s, i) => {
            const sz = SAMPLE_SIZES[s.role.toLowerCase()] ?? SAMPLE_SIZES.body!
            const isCaption = s.role.toLowerCase() === 'caption'
            return (
              <div key={i}>
                <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)] mb-0.5">
                  {s.role}
                </div>
                <div
                  className="text-foreground"
                  style={{
                    fontSize: sz.size,
                    fontFamily: sz.family,
                    fontWeight: sz.weight,
                    lineHeight: isCaption ? 1.4 : 1.25,
                    letterSpacing: isCaption ? '0.08em' : undefined,
                    textTransform: isCaption ? 'uppercase' : undefined,
                  }}
                >
                  {s.text}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function AudienceBlock({ items }: { items: { label: string; insight: string }[] }) {
  return (
    <div>
      <BlockHeading>Audiences</BlockHeading>
      <div className="mt-2 space-y-2">
        {items.map((a, i) => (
          <div
            key={i}
            style={{
              padding: '10px 12px',
              borderRadius: 'var(--radius)',
              backgroundColor: 'var(--bg-elevated)',
            }}
          >
            <div
              className="text-foreground"
              style={{
                fontFamily: 'ui-serif, Georgia, "Iowan Old Style", serif',
                fontSize: 14,
                fontWeight: 500,
                lineHeight: 1.3,
              }}
            >
              {a.label}
            </div>
            <div className="mt-1 text-[12.5px] text-[var(--text-soft)] leading-snug">
              {a.insight}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ChannelBlock({ items }: { items: { name: string; play: string }[] }) {
  return (
    <div>
      <BlockHeading>Channels</BlockHeading>
      <div className="mt-2 space-y-1.5">
        {items.map((c, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <span
              className="text-[var(--accent)]"
              style={{
                fontSize: 12,
                lineHeight: '1.4',
                flex: '0 0 auto',
                marginTop: 1,
              }}
            >
              →
            </span>
            <div className="min-w-0">
              <span className="text-[12.5px] text-foreground font-medium">{c.name}</span>
              <span className="text-[12.5px] text-[var(--text-soft)]">
                {' — '}
                {c.play}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function HooksBlock({ items }: { items: string[] }) {
  return (
    <div>
      <BlockHeading>Hooks</BlockHeading>
      <div className="mt-2 space-y-1.5">
        {items.map((h, i) => (
          <div
            key={i}
            className="text-foreground"
            style={{
              fontFamily: 'ui-serif, Georgia, "Iowan Old Style", serif',
              fontSize: 14,
              lineHeight: 1.35,
              paddingLeft: 10,
              borderLeft: '2px solid var(--accent)',
            }}
          >
            {h}
          </div>
        ))}
      </div>
    </div>
  )
}

function StatementsBlock({ items }: { items: string[] }) {
  return (
    <div>
      <BlockHeading>Statements</BlockHeading>
      <ul className="mt-2 space-y-1.5">
        {items.map((s, i) => (
          <li
            key={i}
            className="text-[12.5px] text-[var(--text-soft)] leading-snug flex items-start gap-2"
          >
            <span className="text-[var(--accent)]" style={{ flex: '0 0 auto', marginTop: 1 }}>
              •
            </span>
            <span>{s}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function WatchForsBlock({ items }: { items: string[] }) {
  return (
    <div>
      <BlockHeading>Watch for</BlockHeading>
      <ul className="mt-2 space-y-1.5">
        {items.map((w, i) => (
          <li
            key={i}
            className="text-[12.5px] leading-snug flex items-start gap-2"
            style={{ color: 'var(--warning)' }}
          >
            <span style={{ flex: '0 0 auto', marginTop: 1 }}>×</span>
            <span>{w}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function NotesBlock({ items }: { items: string[] }) {
  return (
    <div>
      <BlockHeading>Notes</BlockHeading>
      <ul className="mt-2 space-y-1">
        {items.map((n, i) => (
          <li
            key={i}
            className="text-[11.5px] text-[var(--text-mute)] italic leading-snug flex items-start gap-2"
          >
            <span style={{ flex: '0 0 auto' }}>–</span>
            <span>{n}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Three labeled mini-rows for the Business Analyst's contribution.
function PositioningBlock({ data }: { data: { model: string; niche: string; category: string } }) {
  const rows: { label: string; text: string }[] = [
    { label: 'Model', text: data.model },
    { label: 'Niche', text: data.niche },
    { label: 'Category', text: data.category },
  ].filter((r) => r.text.trim().length > 0)
  if (rows.length === 0) return null
  return (
    <div>
      <BlockHeading>Positioning</BlockHeading>
      <div className="mt-2 space-y-2">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)] font-semibold mb-0.5">
              {r.label}
            </div>
            <div className="text-[12.5px] text-foreground leading-snug">{r.text}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Small-caps chip row — the lineage line for the brief.
function ReferencesBlock({ items }: { items: string[] }) {
  return (
    <div>
      <BlockHeading>References</BlockHeading>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {items.map((r, i) => (
          <span
            key={`${r}-${i}`}
            className="inline-block px-2 py-1 text-[10.5px] uppercase tracking-[0.08em] text-[var(--text-soft)]"
            style={{
              borderRadius: 'var(--radius)',
              backgroundColor: 'var(--bg-elevated)',
            }}
          >
            {r}
          </span>
        ))}
      </div>
    </div>
  )
}

// `↔` indicator + verbatim tension line — distinct from watchFors which use `×`.
function TensionsBlock({ items }: { items: string[] }) {
  return (
    <div>
      <BlockHeading>Tensions</BlockHeading>
      <div className="mt-2 space-y-1.5">
        {items.map((t, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="text-[var(--accent)]" style={{ flex: '0 0 auto', marginTop: 1 }}>
              ↔
            </span>
            <span className="text-[12.5px] text-[var(--text-soft)] leading-snug">{t}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// The only longform field in the brief — rendered as a serif card so it
// reads like an actual about-page mockup.
function BodyCopyBlock({ text }: { text: string }) {
  return (
    <div>
      <BlockHeading>Body copy</BlockHeading>
      <div
        className="mt-2 text-foreground"
        style={{
          fontFamily: 'ui-serif, Georgia, "Iowan Old Style", serif',
          fontSize: 14,
          lineHeight: 1.6,
          padding: '14px 16px',
          borderRadius: 'var(--radius)',
          backgroundColor: 'var(--bg-elevated)',
        }}
      >
        {text}
      </div>
    </div>
  )
}
