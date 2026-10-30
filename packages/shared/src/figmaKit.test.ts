import { describe, expect, it } from 'vitest'
import { kitToCss } from './kitCss'
import {
  figmaFontCategory,
  figmaRgbToHex,
  figmaRoleName,
  kitFromFigma,
  mergeFigmaIntoKit,
  type FigmaKitInput,
} from './figmaKit'
import { emptyKitTokens, kitTokensSchema } from './kits'

function input(overrides: Partial<FigmaKitInput> = {}): FigmaKitInput {
  return {
    fileKey: 'AbCdEfGhIjKlMnOpQrStUv',
    fileName: 'Acme Brand',
    lastModified: '2026-03-04T10:00:00Z',
    colours: [
      { name: 'Colors/Brand/Primary', hex: '#1F2A44', alpha: 1, source: 'style' },
      { name: 'Colors/Brand/Accent', hex: '#F2C14E', alpha: 1, source: 'style' },
      { name: 'Neutral/Paper', hex: '#FAF7F2', alpha: 1, source: 'style' },
      { name: 'Neutral/Ink', hex: '#111111', alpha: 1, source: 'style' },
      { name: 'Brand/Primary copy', hex: '#1f2a44', alpha: 1, source: 'style' },
      { name: 'Overlay/Scrim', hex: '#000000', alpha: 0.4, source: 'style' },
    ],
    texts: [
      {
        name: 'Display/H1',
        family: 'Aktiv Grotesk',
        weight: 700,
        size: 64,
        uses: 4,
        source: 'style',
      },
      {
        name: 'Display/H2',
        family: 'Aktiv Grotesk',
        weight: 500,
        size: 40,
        uses: 6,
        source: 'style',
      },
      {
        name: 'Body/Regular',
        family: 'Source Serif',
        weight: 400,
        size: 16,
        uses: 30,
        source: 'style',
      },
      {
        name: 'Body/Bold',
        family: 'Source Serif',
        weight: 700,
        size: 16,
        uses: 10,
        source: 'style',
      },
      {
        name: 'Code/Inline',
        family: 'JetBrains Mono',
        weight: 400,
        size: 14,
        uses: 5,
        source: 'style',
      },
      { name: 'Label/Odd', family: 'Comic Neue', weight: 400, size: 12, uses: 1, source: 'style' },
    ],
    skipped: [{ label: 'Gradient/Sunset', reason: 'Gradient fill.' }],
    variables: 'forbidden',
    ...overrides,
  }
}

describe('figma colour helpers', () => {
  it('converts float channels to hex', () => {
    expect(figmaRgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000')
    expect(figmaRgbToHex({ r: 1, g: 1, b: 1 })).toBe('#FFFFFF')
    expect(figmaRgbToHex({ r: 0.1215686, g: 0.1647059, b: 0.2666667 })).toBe('#1F2A44')
    expect(figmaRgbToHex({ r: 2, g: -1, b: 0.5 })).toBe('#FF0080')
  })

  it('turns style paths into roles', () => {
    expect(figmaRoleName('Colors/Brand/Primary', 'x')).toBe('Brand Primary')
    expect(figmaRoleName('Primary', 'x')).toBe('Primary')
    expect(figmaRoleName('Color', 'x')).toBe('Color')
    expect(figmaRoleName('', 'Colour 3')).toBe('Colour 3')
    expect(figmaRoleName('color/brand_primary/500', 'x')).toBe('Brand Primary 500')
    expect(figmaRoleName('Brand iOS Blue', 'x')).toBe('Brand iOS Blue')
    expect(
      figmaRoleName('A very long style name that keeps going and going', 'x').length,
    ).toBeLessThanOrEqual(40)
  })
})

describe('kitFromFigma colours', () => {
  const { tokens, report } = kitFromFigma(input())

  it('maps named colours into palette roles', () => {
    expect(tokens.palette.map((p) => [p.role, p.hex])).toEqual([
      ['Brand Primary', '#1F2A44'],
      ['Brand Accent', '#F2C14E'],
      ['Neutral Paper', '#FAF7F2'],
      ['Neutral Ink', '#111111'],
    ])
    expect(report.mapped.filter((m) => m.kind === 'colour')).toHaveLength(4)
  })

  it('says why a colour was left behind', () => {
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        { label: 'Brand/Primary copy', reason: 'Same colour as “Colors/Brand/Primary”.' },
        { label: 'Overlay/Scrim', reason: 'Semi-transparent (40%).' },
        { label: 'Gradient/Sunset', reason: 'Gradient fill.' },
      ]),
    )
  })

  it('produces a kit the CSS contract can compile', () => {
    const css = kitToCss(tokens)
    expect(css).toContain('--kit-color-primary: #1F2A44;')
    expect(css).toContain('--kit-color-accent: #F2C14E;')
    expect(css).toContain('--kit-color-background: #FAF7F2;')
    expect(css).toContain('--kit-color-text: #111111;')
  })

  it('falls back to observed fills only when nothing is named, and says so', () => {
    const observed = kitFromFigma(
      input({
        colours: [
          { name: 'Fill #112233', hex: '#112233', alpha: 1, source: 'observed' },
          { name: 'Fill #FFEEDD', hex: '#FFEEDD', alpha: 1, source: 'observed' },
        ],
      }),
    )
    expect(observed.tokens.palette).toHaveLength(2)
    expect(observed.report.skipped[0]!.reason).toMatch(/most-used fills/)

    const named = kitFromFigma(
      input({
        colours: [
          ...input().colours,
          { name: 'Fill #112233', hex: '#112233', alpha: 1, source: 'observed' },
        ],
      }),
    )
    expect(named.tokens.palette.map((p) => p.hex)).not.toContain('#112233')
  })

  it('keeps roles unique and stops at the palette limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: i < 2 ? 'Same Name' : `Shade ${i}`,
      hex: `#${(i * 8 + 16).toString(16).padStart(2, '0')}2030`,
      alpha: 1,
      source: 'style' as const,
    }))
    const out = kitFromFigma(input({ colours: many }))
    expect(out.tokens.palette).toHaveLength(24)
    expect(new Set(out.tokens.palette.map((p) => p.role.toLowerCase())).size).toBe(24)
    expect(out.report.skipped.filter((s) => /limit/.test(s.reason))).toHaveLength(6)
  })

  it('skips a malformed colour instead of throwing', () => {
    const out = kitFromFigma(
      input({ colours: [{ name: 'Bad', hex: 'red', alpha: 1, source: 'style' }] }),
    )
    expect(out.tokens.palette).toEqual([])
    expect(out.report.skipped[0]).toEqual({ label: 'Bad', reason: 'Not a plain RGB colour.' })
  })
})

describe('kitFromFigma fonts', () => {
  const { tokens, report } = kitFromFigma(input())

  it('puts headline, body and code styles into their slots with weights', () => {
    expect(tokens.fonts.display).toMatchObject({
      family: 'Aktiv Grotesk',
      category: 'sans',
      weights: [500, 700],
      url: null,
    })
    expect(tokens.fonts.body).toMatchObject({
      family: 'Source Serif',
      category: 'serif',
      weights: [400, 700],
    })
    expect(tokens.fonts.mono).toMatchObject({ family: 'JetBrains Mono', category: 'mono' })
    expect(tokens.fonts.display!.usage).toContain('Display/H1 (64px 700)')
  })

  it('lists the font it had no slot for', () => {
    expect(report.skipped.some((s) => s.label === 'Font “Comic Neue”')).toBe(true)
    expect(tokens.notes).toContain('Additional font: Comic Neue')
  })

  it('infers slots from size and usage when the names say nothing', () => {
    const out = kitFromFigma(
      input({
        texts: [
          { name: 'Style A', family: 'Big Face', weight: 800, size: 72, uses: 2, source: 'style' },
          {
            name: 'Style B',
            family: 'Small Face',
            weight: 400,
            size: 15,
            uses: 40,
            source: 'style',
          },
        ],
      }),
    )
    expect(out.tokens.fonts.display?.family).toBe('Big Face')
    expect(out.tokens.fonts.body?.family).toBe('Small Face')
    expect(out.tokens.fonts.mono).toBeNull()
  })

  it('lets a single family serve display and body', () => {
    const out = kitFromFigma(
      input({
        texts: [
          { name: 'Heading', family: 'Inter', weight: 700, size: 32, uses: 3, source: 'style' },
          { name: 'Paragraph', family: 'Inter', weight: 400, size: 16, uses: 9, source: 'style' },
        ],
      }),
    )
    expect(out.tokens.fonts.display?.family).toBe('Inter')
    expect(out.tokens.fonts.display?.weights).toEqual([700])
    expect(out.tokens.fonts.body?.family).toBe('Inter')
    expect(out.tokens.fonts.body?.weights).toEqual([400])
  })

  it('maps a lone body style to both display and body, and nothing without text', () => {
    const lone = kitFromFigma(
      input({
        texts: [{ name: 'Body', family: 'Inter', weight: 400, size: 16, uses: 1, source: 'style' }],
      }),
    )
    expect(lone.tokens.fonts.display?.family).toBe('Inter')
    expect(lone.tokens.fonts.body?.family).toBe('Inter')
    const none = kitFromFigma(input({ texts: [] }))
    expect(none.tokens.fonts).toMatchObject({ display: null, body: null, mono: null })
    expect(none.report.mapped.some((m) => m.kind === 'font')).toBe(false)
  })

  it('clamps odd weights into the kit range', () => {
    const out = kitFromFigma(
      input({
        texts: [
          { name: 'Body', family: 'Var Font', weight: 1000, size: 16, uses: 1, source: 'style' },
        ],
      }),
    )
    expect(out.tokens.fonts.body?.weights).toEqual([900])
  })

  it('classifies families', () => {
    expect(figmaFontCategory('Playfair Display')).toBe('serif')
    expect(figmaFontCategory('Noto Sans')).toBe('sans')
    expect(figmaFontCategory('IBM Plex Mono')).toBe('mono')
  })
})

describe('kitFromFigma report', () => {
  it('always produces valid tokens, with provenance notes', () => {
    const { tokens } = kitFromFigma(input())
    expect(kitTokensSchema.safeParse(tokens).success).toBe(true)
    expect(tokens.notes[0]).toBe(
      'Imported from Figma file “Acme Brand” (AbCdEfGhIjKlMnOpQrStUv), last modified 2026-03-04.',
    )
    expect(tokens.summary).toContain('Acme Brand')
  })

  it('reports variables access honestly', () => {
    expect(
      kitFromFigma(input({ variables: 'forbidden' })).report.skipped.map((s) => s.label),
    ).toContain('Variables')
    expect(
      kitFromFigma(input({ variables: 'used' })).report.skipped.map((s) => s.label),
    ).not.toContain('Variables')
    expect(kitFromFigma(input({ variables: 'unavailable' })).report.variables).toBe('unavailable')
  })

  it('handles an empty file', () => {
    const out = kitFromFigma(input({ colours: [], texts: [], skipped: [] }))
    expect(out.tokens.palette).toEqual([])
    expect(kitTokensSchema.safeParse(out.tokens).success).toBe(true)
  })
})

describe('mergeFigmaIntoKit', () => {
  const existing = kitTokensSchema.parse({
    summary: 'Quiet utility.',
    palette: [{ role: 'old', hex: '#000000' }],
    fonts: {
      display: { family: 'Aktiv Grotesk', url: '/api/files/aktiv.woff2', weights: [700] },
      body: { family: 'Old Body' },
      mono: null,
      feel: 'Grotesk and mono.',
    },
    logos: [{ name: 'Logo', url: '/api/files/logo.png' }],
    voice: { tone: ['Plain.'], dos: [], donts: ['No puns.'], examples: [] },
    imagery: { rules: ['Warm light.'], references: [] },
    notes: ['Prefers lowercase.', 'Imported from Figma file “Old” (x).'],
  })
  const imported = kitFromFigma(input()).tokens
  const merged = mergeFigmaIntoKit(existing, imported)

  it('takes palette and fonts from Figma, keeps the rest', () => {
    expect(merged.palette.map((p) => p.hex)).toEqual(imported.palette.map((p) => p.hex))
    expect(merged.fonts.body?.family).toBe('Source Serif')
    expect(merged.logos).toEqual(existing.logos)
    expect(merged.voice).toEqual(existing.voice)
    expect(merged.imagery).toEqual(existing.imagery)
    expect(merged.summary).toBe('Quiet utility.')
    expect(merged.fonts.feel).toBe('Grotesk and mono.')
  })

  it('keeps an uploaded font file when the family is unchanged', () => {
    expect(merged.fonts.display?.url).toBe('/api/files/aktiv.woff2')
    expect(merged.fonts.display?.weights).toEqual([500, 700])
  })

  it('replaces the earlier import note and keeps hand-written ones', () => {
    expect(merged.notes).toContain('Prefers lowercase.')
    expect(merged.notes.filter((n) => n.startsWith('Imported from Figma'))).toHaveLength(1)
    expect(merged.notes.join(' ')).not.toContain('“Old”')
  })

  it('keeps an existing palette when the file has none', () => {
    const none = mergeFigmaIntoKit(existing, kitFromFigma(input({ colours: [], texts: [] })).tokens)
    expect(none.palette).toEqual(existing.palette)
    expect(none.fonts.body?.family).toBe('Old Body')
  })

  it('works on an empty kit', () => {
    expect(mergeFigmaIntoKit(emptyKitTokens(), imported).palette).toHaveLength(4)
  })
})
