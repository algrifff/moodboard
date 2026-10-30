import { kitToCss, type KitTokens } from '@moodboard/shared'
import { useMemo } from 'react'

const SCOPE = 'kit-preview'

// The kit as a template would see it: the compiled --kit-* stylesheet,
// scoped to this element, driving a small specimen. What you see here is
// exactly what `kitToCss` hands Phase 23 templates.
export function KitPreview({ tokens }: { tokens: KitTokens }) {
  const css = useMemo(() => kitToCss(tokens).replace(':root', `.${SCOPE}`), [tokens])
  const logo = tokens.logos[0]
  return (
    <div
      className={`${SCOPE} overflow-hidden`}
      style={{
        borderRadius: 'var(--radius-lg)',
        backgroundColor: 'var(--kit-color-background)',
        color: 'var(--kit-color-text)',
        fontFamily: 'var(--kit-font-body)',
        fontWeight: 'var(--kit-font-body-weight)' as unknown as number,
        boxShadow: '0 0 0 1px var(--border-soft)',
      }}
    >
      <style>{css}</style>
      <div className="p-5">
        {logo && (
          <img
            src={logo.url}
            alt={logo.name}
            className="mb-4 max-h-9 max-w-[60%] object-contain object-left"
          />
        )}
        <div
          style={{
            fontFamily: 'var(--kit-font-display)',
            fontWeight: 'var(--kit-font-display-weight)' as unknown as number,
            fontSize: 26,
            lineHeight: 1.15,
            letterSpacing: '-0.01em',
          }}
        >
          {tokens.summary || 'Headline in the display face'}
        </div>
        <p className="mt-2 text-[13px] leading-relaxed" style={{ opacity: 0.85 }}>
          Body copy reads in the body face, at its regular weight, on the kit’s ground colour.
        </p>
        <div
          className="mt-3 text-[11px] uppercase tracking-[0.14em]"
          style={{
            fontFamily: 'var(--kit-font-mono)',
            fontWeight: 'var(--kit-font-mono-weight)' as unknown as number,
            opacity: 0.7,
          }}
        >
          Label · mono
        </div>
        <div className="mt-4 flex items-center gap-2">
          <span
            className="px-3 py-1.5 text-[13px] font-medium"
            style={{
              backgroundColor: 'var(--kit-color-primary)',
              color: 'var(--kit-color-on-primary)',
            }}
          >
            Primary
          </span>
          <span
            className="px-3 py-1.5 text-[13px] font-medium"
            style={{
              backgroundColor: 'var(--kit-color-accent)',
              color: 'var(--kit-color-on-accent)',
            }}
          >
            Accent
          </span>
          <span
            className="px-3 py-1.5 text-[13px]"
            style={{
              backgroundColor: 'var(--kit-color-surface)',
              boxShadow: 'inset 0 0 0 1px currentColor',
            }}
          >
            Surface
          </span>
        </div>
      </div>
      {tokens.palette.length > 0 && (
        <div className="flex h-8">
          {tokens.palette.map((p) => (
            <div
              key={`${p.role}-${p.hex}`}
              className="flex-1"
              style={{ backgroundColor: p.hex }}
              title={`${p.role} ${p.hex}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
