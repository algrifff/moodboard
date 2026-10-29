import type { SectionedParagraphs } from '@moodboard/shared'

export function SectionedReadout({ data }: { data: SectionedParagraphs }) {
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

export function SectionedGlance({ data }: { data: SectionedParagraphs }) {
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
