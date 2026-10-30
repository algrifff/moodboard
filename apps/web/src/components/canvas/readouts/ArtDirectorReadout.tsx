import type { AIAnalysis } from '@moodboard/shared'

// ---------------------------------------------------------------------------
// Renderers — Art Director (existing rich shape) + generic sectioned
// ---------------------------------------------------------------------------

export function ArtDirectorReadout({ data }: { data: AIAnalysis }) {
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

export function ArtDirectorGlance({ data }: { data: AIAnalysis }) {
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
