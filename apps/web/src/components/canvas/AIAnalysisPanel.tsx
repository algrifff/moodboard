import type { AgentId, AIAnalysis, SectionedParagraphs, SynthesisBrief } from '@moodboard/shared'
import { ArrowsOutSimple, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AI_PANEL_DURATION, EASE_OUT_STANDARD } from '@/lib/motion'
import { AgentRow, type PlayState } from './AgentRow'
import { EditableText } from './EditableText'

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

// ---------------------------------------------------------------------------
// Brief renderer — the synthesiser's structured output rendered as a
// presentation-style layout. Every block self-skips when its data is empty
// so a 2-agent synthesis doesn't drag empty sections through the page.
// ---------------------------------------------------------------------------

function BriefReadout({
  data,
  logoOverrideOptions,
  onChangeLogos,
  onPatchBrief,
}: {
  data: SynthesisBrief
  logoOverrideOptions: { url: string }[]
  onChangeLogos: (urls: string[]) => void
  onPatchBrief: (brief: SynthesisBrief) => void
}) {
  // Convenience wrapper — each block hands us its new slice of the brief
  // and we splice it onto the rest. Pass these into each block's
  // onChange prop.
  const patch =
    <K extends keyof SynthesisBrief>(key: K) =>
    (value: SynthesisBrief[K]) =>
      onPatchBrief({ ...data, [key]: value })
  const hasPositioning =
    data.positioning.model.trim().length > 0 ||
    data.positioning.niche.trim().length > 0 ||
    data.positioning.category.trim().length > 0
  return (
    <div className="space-y-5">
      {data.throughline.trim().length > 0 && (
        <ThroughlineBlock
          text={data.throughline}
          source={data.throughlineSource}
          onChange={patch('throughline')}
        />
      )}
      {hasPositioning && (
        <PositioningBlock data={data.positioning} onChange={patch('positioning')} />
      )}
      {data.logo.length > 0 && (
        <LogoBlock
          logos={data.logo}
          overrideOptions={logoOverrideOptions}
          onChange={onChangeLogos}
          onChangeReason={(i, reason) =>
            patch('logo')(data.logo.map((l, j) => (j === i ? { ...l, reason } : l)))
          }
        />
      )}
      {data.palette.length > 0 && <PaletteBlock items={data.palette} onChange={patch('palette')} />}
      {data.typography.feel.trim().length > 0 && (
        <TypographyBlock
          feel={data.typography.feel}
          onChange={(feel) => patch('typography')({ feel })}
        />
      )}
      {data.fonts.length > 0 && <FontsBlock items={data.fonts} onChange={patch('fonts')} />}
      {data.references.length > 0 && (
        <ReferencesBlock items={data.references} onChange={patch('references')} />
      )}
      {data.tensions.length > 0 && (
        <TensionsBlock items={data.tensions} onChange={patch('tensions')} />
      )}
      {data.audiences.length > 0 && (
        <AudienceBlock items={data.audiences} onChange={patch('audiences')} />
      )}
      {data.channels.length > 0 && (
        <ChannelBlock items={data.channels} onChange={patch('channels')} />
      )}
      {data.hooks.length > 0 && <HooksBlock items={data.hooks} onChange={patch('hooks')} />}
      {data.bodyCopy.trim().length > 0 && (
        <BodyCopyBlock text={data.bodyCopy} onChange={patch('bodyCopy')} />
      )}
      {data.statements.length > 0 && (
        <StatementsBlock items={data.statements} onChange={patch('statements')} />
      )}
      {data.watchFors.length > 0 && (
        <WatchForsBlock items={data.watchFors} onChange={patch('watchFors')} />
      )}
      {data.notes.length > 0 && <NotesBlock items={data.notes} onChange={patch('notes')} />}
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

function ThroughlineBlock({
  text,
  source,
  onChange,
}: {
  text: string
  source: string
  onChange: (next: string) => void
}) {
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
      <EditableText
        value={text}
        onCommit={onChange}
        multiline
        className="mt-1.5 font-medium text-foreground"
        style={{
          fontFamily: 'ui-serif, Georgia, "Iowan Old Style", serif',
          fontSize: 16,
          lineHeight: 1.4,
        }}
      />
      {source.trim().length > 0 && (
        <div className="mt-2 text-[11px] text-[var(--text-faint)]">— {source}</div>
      )}
    </div>
  )
}

function PaletteBlock({
  items,
  onChange,
}: {
  items: { hex: string; role: string; note: string }[]
  onChange: (items: { hex: string; role: string; note: string }[]) => void
}) {
  const patchItem = (i: number, p: Partial<{ role: string; note: string }>) =>
    onChange(items.map((it, j) => (j === i ? { ...it, ...p } : it)))
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
              <EditableText
                value={p.role}
                onCommit={(role) => patchItem(i, { role })}
                className="text-[11px] text-foreground font-medium leading-tight"
              />
              <div
                className="text-[11px] text-[var(--text-mute)] font-mono leading-tight"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {p.hex.toUpperCase()}
              </div>
              <EditableText
                value={p.note}
                onCommit={(note) => patchItem(i, { note })}
                multiline
                className="mt-0.5 text-[11px] text-[var(--text-soft)] leading-snug"
              />
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

// Typography block now carries only the `feel` line. Concrete typeface
// samples moved to FontsBlock (Move A consolidation).
function TypographyBlock({ feel, onChange }: { feel: string; onChange: (next: string) => void }) {
  return (
    <div>
      <BlockHeading>Typography</BlockHeading>
      <EditableText
        value={feel}
        onCommit={onChange}
        multiline
        className="mt-1.5 text-[12.5px] text-[var(--text-soft)] italic"
      />
    </div>
  )
}

// Per-typeface card: role label + name (or category fallback) + sample
// rendered at the role's display size. Stacks vertically so each typeface
// reads as its own piece of the system.
function FontsBlock({
  items,
  onChange,
}: {
  items: { name: string; category: string; role: string; sample: string }[]
  onChange: (items: { name: string; category: string; role: string; sample: string }[]) => void
}) {
  const patchItem = (
    i: number,
    p: Partial<{ name: string; category: string; role: string; sample: string }>,
  ) => onChange(items.map((it, j) => (j === i ? { ...it, ...p } : it)))
  return (
    <div>
      <BlockHeading>Fonts</BlockHeading>
      <div
        className="mt-2 space-y-3"
        style={{
          padding: '14px 14px',
          borderRadius: 'var(--radius)',
          backgroundColor: 'var(--bg-elevated)',
        }}
      >
        {items.map((f, i) => {
          const sz = SAMPLE_SIZES[f.role.toLowerCase()] ?? SAMPLE_SIZES.body!
          const isCaption = f.role.toLowerCase() === 'caption'
          // Name takes precedence; fall back to category when the AD only
          // had a typographic family to describe.
          const labelValue = f.name.trim().length > 0 ? 'name' : 'category'
          return (
            <div key={i}>
              <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)] mb-0.5 flex items-baseline gap-2">
                <EditableText
                  as="span"
                  value={f.role}
                  onCommit={(role) => patchItem(i, { role })}
                />
                <span className="text-[var(--text-mute)] normal-case tracking-normal">
                  ·{' '}
                  <EditableText
                    as="span"
                    value={labelValue === 'name' ? f.name : f.category}
                    onCommit={(v) =>
                      labelValue === 'name'
                        ? patchItem(i, { name: v })
                        : patchItem(i, { category: v })
                    }
                  />
                </span>
              </div>
              <EditableText
                value={f.sample}
                onCommit={(sample) => patchItem(i, { sample })}
                multiline
                className="text-foreground"
                style={{
                  fontSize: sz.size,
                  fontFamily: sz.family,
                  fontWeight: sz.weight,
                  lineHeight: isCaption ? 1.4 : 1.25,
                  letterSpacing: isCaption ? '0.08em' : undefined,
                  textTransform: isCaption ? 'uppercase' : undefined,
                }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// The brand's mark — image displayed at logo size on an elevated surface
// with the AD's one-clause reason underneath. Clicking the image opens a
// popover with thumbnails of every image in the group so the user can
// override the AD's pick; useful when the model misses or grabs a
// photographic reference instead of the mark.
// Brand-mark variants. A brand usually has more than one — primary
// wordmark, icon, monogram, white-on-dark, etc. Renders all logos
// side-by-side with their AD-written variant label underneath each.
// Clicking the block opens a multi-select picker over every image in
// the group; each click toggles a thumbnail in/out of the logo set.
function LogoBlock({
  logos,
  overrideOptions,
  onChange,
  onChangeReason,
}: {
  logos: { url: string; reason: string }[]
  overrideOptions: { url: string }[]
  onChange: (urls: string[]) => void
  onChangeReason: (index: number, reason: string) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [pickerOpen])

  // Only show the override hint when there's something to pick from.
  const canOverride = overrideOptions.length > 0
  const currentUrls = new Set(logos.map((l) => l.url))
  const togglePick = (url: string) => {
    const next = currentUrls.has(url)
      ? logos.filter((l) => l.url !== url).map((l) => l.url)
      : [...logos.map((l) => l.url), url]
    onChange(next)
  }

  return (
    <div>
      <BlockHeading>{logos.length > 1 ? 'Logo variants' : 'Logo'}</BlockHeading>
      <div
        className="mt-2"
        style={{
          position: 'relative',
          padding: '20px 16px',
          borderRadius: 'var(--radius)',
          backgroundColor: 'var(--bg-elevated)',
        }}
      >
        <button
          type="button"
          onClick={() => canOverride && setPickerOpen((v) => !v)}
          aria-label={canOverride ? 'Edit logo variants' : 'Logo'}
          title={canOverride ? 'Click to add or remove logo variants' : undefined}
          style={{
            display: 'block',
            width: '100%',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: canOverride ? 'pointer' : 'default',
          }}
        >
          <div
            className="flex flex-wrap items-end justify-center"
            style={{ columnGap: 20, rowGap: 16 }}
          >
            {logos.map((logo, i) => (
              <div
                key={`${logo.url}-${i}`}
                className="flex flex-col items-center"
                style={{ maxWidth: 220, gap: 6 }}
              >
                <img
                  src={logo.url}
                  alt={logo.reason || `Brand mark ${i + 1}`}
                  loading="lazy"
                  style={{
                    // Single-logo case gets a bigger display; multi-logo
                    // shrinks each one so they fit side by side.
                    maxWidth: logos.length === 1 ? 220 : 140,
                    maxHeight: logos.length === 1 ? 120 : 90,
                    objectFit: 'contain',
                    display: 'block',
                  }}
                />
                <EditableText
                  value={logo.reason}
                  onCommit={(reason) => onChangeReason(i, reason)}
                  multiline
                  className="text-[11px] text-[var(--text-mute)] italic leading-snug text-center"
                  style={{ maxWidth: 180 }}
                />
              </div>
            ))}
          </div>
        </button>

        {pickerOpen && canOverride && (
          <div
            ref={pickerRef}
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: '50%',
              transform: 'translateX(-50%)',
              minWidth: 240,
              maxWidth: 360,
              backgroundColor: 'var(--bg-card)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-popover)',
              padding: 10,
              zIndex: 60,
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)] font-semibold mb-2">
              Toggle logo variants
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {overrideOptions.map((opt, i) => {
                const isCurrent = currentUrls.has(opt.url)
                return (
                  <button
                    key={`${opt.url}-${i}`}
                    type="button"
                    onClick={() => togglePick(opt.url)}
                    style={{
                      padding: 0,
                      borderRadius: 'var(--radius)',
                      backgroundColor: 'var(--bg-elevated)',
                      cursor: 'pointer',
                      overflow: 'hidden',
                      aspectRatio: '1 / 1',
                      outline: isCurrent ? '2px solid var(--accent)' : 'none',
                      outlineOffset: -2,
                      border: 'none',
                      opacity: isCurrent ? 1 : 0.7,
                      transition: 'opacity 120ms',
                    }}
                    aria-pressed={isCurrent}
                    aria-label={isCurrent ? 'Remove from logo set' : 'Add to logo set'}
                  >
                    <img
                      src={opt.url}
                      alt=""
                      loading="lazy"
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        display: 'block',
                      }}
                    />
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function AudienceBlock({
  items,
  onChange,
}: {
  items: { label: string; insight: string }[]
  onChange: (items: { label: string; insight: string }[]) => void
}) {
  const patchItem = (i: number, p: Partial<{ label: string; insight: string }>) =>
    onChange(items.map((it, j) => (j === i ? { ...it, ...p } : it)))
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
            <EditableText
              value={a.label}
              onCommit={(label) => patchItem(i, { label })}
              className="text-foreground"
              style={{
                fontFamily: 'ui-serif, Georgia, "Iowan Old Style", serif',
                fontSize: 14,
                fontWeight: 500,
                lineHeight: 1.3,
              }}
            />
            <EditableText
              value={a.insight}
              onCommit={(insight) => patchItem(i, { insight })}
              multiline
              className="mt-1 text-[12.5px] text-[var(--text-soft)] leading-snug"
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function ChannelBlock({
  items,
  onChange,
}: {
  items: { name: string; play: string }[]
  onChange: (items: { name: string; play: string }[]) => void
}) {
  const patchItem = (i: number, p: Partial<{ name: string; play: string }>) =>
    onChange(items.map((it, j) => (j === i ? { ...it, ...p } : it)))
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
            <div className="min-w-0 flex-1">
              <EditableText
                as="span"
                value={c.name}
                onCommit={(name) => patchItem(i, { name })}
                className="text-[12.5px] text-foreground font-medium"
              />
              <span className="text-[12.5px] text-[var(--text-soft)]">{' — '}</span>
              <EditableText
                as="span"
                value={c.play}
                onCommit={(play) => patchItem(i, { play })}
                className="text-[12.5px] text-[var(--text-soft)]"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function HooksBlock({ items, onChange }: { items: string[]; onChange: (items: string[]) => void }) {
  const patchItem = (i: number, v: string) => onChange(items.map((it, j) => (j === i ? v : it)))
  return (
    <div>
      <BlockHeading>Hooks</BlockHeading>
      <div className="mt-2 space-y-1.5">
        {items.map((h, i) => (
          <EditableText
            key={i}
            value={h}
            onCommit={(v) => patchItem(i, v)}
            multiline
            className="text-foreground"
            style={{
              fontFamily: 'ui-serif, Georgia, "Iowan Old Style", serif',
              fontSize: 14,
              lineHeight: 1.35,
              paddingLeft: 10,
              borderLeft: '2px solid var(--accent)',
            }}
          />
        ))}
      </div>
    </div>
  )
}

function StatementsBlock({
  items,
  onChange,
}: {
  items: string[]
  onChange: (items: string[]) => void
}) {
  const patchItem = (i: number, v: string) => onChange(items.map((it, j) => (j === i ? v : it)))
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
            <EditableText
              as="span"
              value={s}
              onCommit={(v) => patchItem(i, v)}
              className="flex-1"
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

function WatchForsBlock({
  items,
  onChange,
}: {
  items: string[]
  onChange: (items: string[]) => void
}) {
  const patchItem = (i: number, v: string) => onChange(items.map((it, j) => (j === i ? v : it)))
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
            <EditableText
              as="span"
              value={w}
              onCommit={(v) => patchItem(i, v)}
              className="flex-1"
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

function NotesBlock({ items, onChange }: { items: string[]; onChange: (items: string[]) => void }) {
  const patchItem = (i: number, v: string) => onChange(items.map((it, j) => (j === i ? v : it)))
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
            <EditableText
              as="span"
              value={n}
              onCommit={(v) => patchItem(i, v)}
              className="flex-1"
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

// Three labeled mini-rows for the Business Analyst's contribution.
function PositioningBlock({
  data,
  onChange,
}: {
  data: { model: string; niche: string; category: string }
  onChange: (next: { model: string; niche: string; category: string }) => void
}) {
  const rows = (
    [
      { key: 'model', label: 'Model', text: data.model },
      { key: 'niche', label: 'Niche', text: data.niche },
      { key: 'category', label: 'Category', text: data.category },
    ] as const
  ).filter((r) => r.text.trim().length > 0)
  if (rows.length === 0) return null
  return (
    <div>
      <BlockHeading>Positioning</BlockHeading>
      <div className="mt-2 space-y-2">
        {rows.map((r) => (
          <div key={r.key}>
            <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)] font-semibold mb-0.5">
              {r.label}
            </div>
            <EditableText
              value={r.text}
              onCommit={(v) => onChange({ ...data, [r.key]: v })}
              multiline
              className="text-[12.5px] text-foreground leading-snug"
            />
          </div>
        ))}
      </div>
    </div>
  )
}

// Small-caps chip row — the lineage line for the brief.
function ReferencesBlock({
  items,
  onChange,
}: {
  items: string[]
  onChange: (items: string[]) => void
}) {
  const patchItem = (i: number, v: string) => onChange(items.map((it, j) => (j === i ? v : it)))
  return (
    <div>
      <BlockHeading>References</BlockHeading>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {items.map((r, i) => (
          <EditableText
            key={`${r}-${i}`}
            as="span"
            value={r}
            onCommit={(v) => patchItem(i, v)}
            className="inline-block px-2 py-1 text-[10.5px] uppercase tracking-[0.08em] text-[var(--text-soft)]"
            style={{
              borderRadius: 'var(--radius)',
              backgroundColor: 'var(--bg-elevated)',
            }}
          />
        ))}
      </div>
    </div>
  )
}

// `↔` indicator + verbatim tension line — distinct from watchFors which use `×`.
function TensionsBlock({
  items,
  onChange,
}: {
  items: string[]
  onChange: (items: string[]) => void
}) {
  const patchItem = (i: number, v: string) => onChange(items.map((it, j) => (j === i ? v : it)))
  return (
    <div>
      <BlockHeading>Tensions</BlockHeading>
      <div className="mt-2 space-y-1.5">
        {items.map((t, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="text-[var(--accent)]" style={{ flex: '0 0 auto', marginTop: 1 }}>
              ↔
            </span>
            <EditableText
              as="span"
              value={t}
              onCommit={(v) => patchItem(i, v)}
              className="text-[12.5px] text-[var(--text-soft)] leading-snug flex-1"
            />
          </div>
        ))}
      </div>
    </div>
  )
}

// The only longform field in the brief — rendered as a serif card so it
// reads like an actual about-page mockup.
function BodyCopyBlock({ text, onChange }: { text: string; onChange: (next: string) => void }) {
  return (
    <div>
      <BlockHeading>Body copy</BlockHeading>
      <EditableText
        value={text}
        onCommit={onChange}
        multiline
        className="mt-2 text-foreground"
        style={{
          fontFamily: 'ui-serif, Georgia, "Iowan Old Style", serif',
          fontSize: 14,
          lineHeight: 1.6,
          padding: '14px 16px',
          borderRadius: 'var(--radius)',
          backgroundColor: 'var(--bg-elevated)',
        }}
      />
    </div>
  )
}
