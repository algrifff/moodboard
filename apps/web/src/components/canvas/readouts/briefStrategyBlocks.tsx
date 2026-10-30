import type { SynthesisBrief } from '@moodboard/shared'
import { EditableText } from '../EditableText'
import { BlockHeading } from './briefIdentityBlocks'
import { Stamp, VideoHeading } from './VideoEditorReadout'

export function AudienceBlock({
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

export function ChannelBlock({
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

// Video direction — the synthesiser's translation of the Senior Video Editor's
// reference-clip read into an actionable plan for the brand's own video.
// Renders only when the brief carries video content (see BriefReadout guard).
export function VideoDirectionBlock({
  data,
  onChange,
}: {
  data: SynthesisBrief['video']
  onChange: (value: SynthesisBrief['video']) => void
}) {
  const patchHook = (i: number, p: Partial<SynthesisBrief['video']['hooks'][number]>) =>
    onChange({ ...data, hooks: data.hooks.map((h, j) => (j === i ? { ...h, ...p } : h)) })
  const patchTransition = (i: number, p: Partial<SynthesisBrief['video']['transitions'][number]>) =>
    onChange({
      ...data,
      transitions: data.transitions.map((t, j) => (j === i ? { ...t, ...p } : t)),
    })
  return (
    <div>
      <BlockHeading>Video direction</BlockHeading>

      {data.hooks.length > 0 && (
        <div className="mt-2 space-y-2">
          <VideoHeading>Hooks to use</VideoHeading>
          {data.hooks.map((h, i) => (
            <div
              key={i}
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--radius)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            >
              <div className="flex items-baseline gap-2">
                <Stamp>{h.at}</Stamp>
                <EditableText
                  as="span"
                  value={h.say}
                  onCommit={(say) => patchHook(i, { say })}
                  className="text-[12.5px] text-foreground font-medium"
                />
              </div>
              {(h.technique || h.why) && (
                <div
                  className="mt-1 text-[11.5px] text-[var(--text-faint)]"
                  style={{ lineHeight: 1.45 }}
                >
                  {h.technique}
                  {h.technique && h.why ? ' — ' : ''}
                  {h.why}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {data.transitions.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          <VideoHeading>Transitions</VideoHeading>
          {data.transitions.map((t, i) => (
            <div key={i} className="flex items-baseline gap-2">
              <Stamp>{t.at}</Stamp>
              <div className="min-w-0 flex-1">
                <span className="text-[12.5px] font-medium text-foreground">{t.type}</span>
                <span className="text-[12.5px] text-[var(--text-soft)]">{' — '}</span>
                <EditableText
                  as="span"
                  value={t.note}
                  onCommit={(note) => patchTransition(i, { note })}
                  className="text-[12.5px] text-[var(--text-soft)]"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {data.pacing.trim().length > 0 && (
        <div className="mt-2.5">
          <VideoHeading>Pacing</VideoHeading>
          <EditableText
            value={data.pacing}
            onCommit={(pacing) => onChange({ ...data, pacing })}
            multiline
            className="mt-0.5 text-[12.5px] text-[var(--text-soft)] leading-snug"
          />
        </div>
      )}
    </div>
  )
}

export function HooksBlock({
  items,
  onChange,
}: {
  items: string[]
  onChange: (items: string[]) => void
}) {
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

export function StatementsBlock({
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

export function WatchForsBlock({
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

export function NotesBlock({
  items,
  onChange,
}: {
  items: string[]
  onChange: (items: string[]) => void
}) {
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
export function PositioningBlock({
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
export function ReferencesBlock({
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
export function TensionsBlock({
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
export function BodyCopyBlock({
  text,
  onChange,
}: {
  text: string
  onChange: (next: string) => void
}) {
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
