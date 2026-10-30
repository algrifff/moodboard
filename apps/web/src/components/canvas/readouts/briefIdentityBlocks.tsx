import { useEffect, useRef, useState } from 'react'
import { EditableText } from '../EditableText'

// ---------------------------------------------------------------------------
// Brief blocks — each one self-contained, no shared scaffolding so the
// visual treatment per block can stay opinionated.
// ---------------------------------------------------------------------------

export function BlockHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)] font-semibold">
      {children}
    </div>
  )
}

export function ThroughlineBlock({
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

export function PaletteBlock({
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
export function TypographyBlock({
  feel,
  onChange,
}: {
  feel: string
  onChange: (next: string) => void
}) {
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
export function FontsBlock({
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
export function LogoBlock({
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
