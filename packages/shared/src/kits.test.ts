import { describe, expect, it } from 'vitest'
import { kitToCss, kitSlug, readableInk } from './kitCss'
import { emptyKitTokens, isSafeKitUrl, kitFromBrief, kitTokensSchema, type KitTokens } from './kits'
import type { SynthesisBrief } from './types'

function brief(overrides: Partial<SynthesisBrief> = {}): SynthesisBrief {
  return {
    throughline: 'Quiet utility, loud colour.',
    throughlineSource: 'Art Director',
    positioning: { model: 'Studio', niche: 'Tools', category: '' },
    palette: [
      { hex: '#1f2a44', role: 'foundation', note: 'ink navy' },
      { hex: '#F2C14E', role: 'accent', note: 'sticky yellow' },
      { hex: '#fff', role: 'paper', note: 'warm ground' },
      { hex: 'not-a-colour', role: 'broken', note: '' },
      { hex: '#1F2A44', role: 'duplicate', note: 'same as foundation' },
    ],
    typography: { feel: 'Grotesk headlines, mono labels.' },
    fonts: [
      { name: 'Aktiv Grotesk', category: 'sans-serif', role: 'Headlines', sample: 'Aa' },
      { name: 'Source Serif', category: 'serif', role: 'Body copy', sample: '' },
      { name: 'JetBrains Mono', category: 'monospace', role: 'Labels', sample: '' },
      { name: 'Extra Face', category: 'sans', role: 'Headline alt', sample: '' },
    ],
    logo: [
      { url: '/api/files/logo.png', reason: 'Primary mark' },
      { url: 'javascript:alert(1)', reason: 'nope' },
      { url: 'https://cdn.example.com/dark.svg', reason: 'On dark' },
    ],
    references: ['Dieter Rams'],
    tensions: ['Playful colour, strict grid'],
    audiences: [],
    channels: [],
    hooks: ['Made for one.'],
    bodyCopy: 'Everything you need.',
    statements: ['Fewer, better things.'],
    watchFors: ['Do not overuse yellow.'],
    notes: ['Prefers lowercase.'],
    video: { hooks: [], transitions: [], pacing: '' },
    ...overrides,
  }
}

describe('kitFromBrief', () => {
  const tokens = kitFromBrief(brief())

  it('maps the palette, normalising and dropping bad or duplicate colours', () => {
    expect(tokens.palette).toEqual([
      { role: 'foundation', hex: '#1F2A44', usage: 'ink navy' },
      { role: 'accent', hex: '#F2C14E', usage: 'sticky yellow' },
      { role: 'paper', hex: '#FFFFFF', usage: 'warm ground' },
    ])
  })

  it('assigns fonts to slots by role and category', () => {
    expect(tokens.fonts.display?.family).toBe('Aktiv Grotesk')
    expect(tokens.fonts.body?.family).toBe('Source Serif')
    expect(tokens.fonts.body?.category).toBe('serif')
    expect(tokens.fonts.mono?.family).toBe('JetBrains Mono')
    expect(tokens.fonts.feel).toBe('Grotesk headlines, mono labels.')
    expect(tokens.notes).toContain('Additional display font: Extra Face')
  })

  it('keeps an uploaded font file when the family matches', () => {
    const withFile = kitFromBrief(brief(), {
      uploadedFonts: [
        { family: 'aktiv grotesk', url: '/api/files/aktiv.woff2' },
        { family: 'Source Serif', url: 'javascript:bad' },
      ],
    })
    expect(withFile.fonts.display?.url).toBe('/api/files/aktiv.woff2')
    expect(withFile.fonts.body?.url).toBeNull()
  })

  it('keeps only safe logo urls', () => {
    expect(tokens.logos).toEqual([
      { name: 'Logo', url: '/api/files/logo.png', usage: 'Primary mark' },
      { name: 'Logo 3', url: 'https://cdn.example.com/dark.svg', usage: 'On dark' },
    ])
  })

  it('maps voice, imagery and notes', () => {
    expect(tokens.summary).toBe('Quiet utility, loud colour.')
    expect(tokens.voice.tone).toEqual(['Fewer, better things.'])
    expect(tokens.voice.donts).toEqual(['Do not overuse yellow.'])
    expect(tokens.voice.examples).toEqual(['Made for one.', 'Everything you need.'])
    expect(tokens.imagery.references).toEqual(['Dieter Rams'])
    expect(tokens.notes).toEqual(
      expect.arrayContaining([
        'Positioning: Studio · Tools',
        'Tension: Playful colour, strict grid',
        'Prefers lowercase.',
      ]),
    )
  })

  it('fills free slots with fonts whose role names none', () => {
    const t = kitFromBrief(
      brief({ fonts: [{ name: 'Mystery', category: 'sans', role: 'Brand voice', sample: '' }] }),
    )
    expect(t.fonts.display?.family).toBe('Mystery')
  })

  it('produces a valid kit from an empty brief', () => {
    const empty = kitFromBrief(
      brief({
        palette: [],
        fonts: [],
        logo: [],
        references: [],
        tensions: [],
        hooks: [],
        bodyCopy: '',
        statements: [],
        watchFors: [],
        notes: [],
        positioning: { model: '', niche: '', category: '' },
        throughline: '',
        typography: { feel: '' },
      }),
    )
    expect(empty).toEqual(emptyKitTokens())
  })
})

describe('isSafeKitUrl', () => {
  it('accepts file-route and http(s) urls and rejects anything that could break out of url()', () => {
    expect(isSafeKitUrl('/api/files/a.png')).toBe(true)
    expect(isSafeKitUrl('https://x.test/a.png')).toBe(true)
    expect(isSafeKitUrl('data:image/png;base64,AAA')).toBe(false)
    expect(isSafeKitUrl('/api/files/a.png")}body{background:red')).toBe(false)
    expect(isSafeKitUrl('https://x.test/a b.png')).toBe(false)
  })
})

describe('kitToCss', () => {
  const full: KitTokens = kitTokensSchema.parse({
    palette: [
      { role: 'Paper', hex: '#F4EFE6' },
      { role: 'Ink Navy', hex: '#1F2A44' },
      { role: 'Foundation', hex: '#223355' },
      { role: 'Heat', hex: '#E86A4A' },
      { role: 'Sticky yellow', hex: '#F2C14E' },
    ],
    fonts: {
      display: { family: 'Aktiv Grotesk', url: '/api/files/aktiv.woff2', weights: [500, 700, 900] },
      body: { family: 'Source Serif', category: 'serif', weights: [400, 600] },
    },
    logos: [
      { name: 'Wordmark', url: '/api/files/w.svg' },
      { name: 'Wordmark', url: '/api/files/w2.svg' },
    ],
  })
  const css = kitToCss(full)

  it('emits the fixed semantic colours resolved from role names', () => {
    expect(css).toContain('--kit-color-background: #F4EFE6;')
    expect(css).toContain('--kit-color-primary: #223355;')
    expect(css).toContain('--kit-color-accent: #E86A4A;')
    expect(css).toContain('--kit-color-surface: #F4EFE6;')
    expect(css).toContain('--kit-color-on-primary: #F8FAFC;')
    expect(css).toContain('--kit-color-on-accent: #F8FAFC;')
  })

  it('emits a variable for every palette role, slugged', () => {
    expect(css).toContain('--kit-color-ink-navy: #1F2A44;')
    expect(css).toContain('--kit-color-sticky-yellow: #F2C14E;')
    expect(css).toContain('--kit-color-heat: #E86A4A;')
  })

  it('does not redeclare a reserved name for a role that already is one', () => {
    expect(css.match(/--kit-color-background:/g)).toHaveLength(1)
  })

  it('emits font stacks with category fallbacks and picks weights near the target', () => {
    expect(css).toContain('--kit-font-display: "Aktiv Grotesk", system-ui')
    expect(css).toContain('--kit-font-body: "Source Serif", Georgia')
    expect(css).toContain('--kit-font-mono: ui-monospace')
    expect(css).toContain('--kit-font-display-weight: 700;')
    expect(css).toContain('--kit-font-body-weight: 400;')
  })

  it('emits @font-face only for uploaded fonts, with a weight range', () => {
    expect(css).toContain('@font-face {')
    expect(css).toContain('font-family: "Aktiv Grotesk";')
    expect(css).toContain('src: url("/api/files/aktiv.woff2");')
    expect(css).toContain('font-weight: 500 900;')
    expect(css.match(/@font-face/g)).toHaveLength(1)
  })

  it('emits logo variables, de-duplicating names', () => {
    expect(css).toContain('--kit-logo: url("/api/files/w.svg");')
    expect(css).toContain('--kit-logo-wordmark: url("/api/files/w.svg");')
    expect(css).toContain('--kit-logo-wordmark-2: url("/api/files/w2.svg");')
  })

  it('is deterministic', () => {
    expect(kitToCss(full)).toBe(css)
  })

  it('still emits every contract variable for an empty kit', () => {
    const empty = kitToCss(emptyKitTokens())
    for (const name of [
      'background',
      'surface',
      'text',
      'primary',
      'accent',
      'on-primary',
      'on-accent',
    ]) {
      expect(empty).toContain(`--kit-color-${name}:`)
    }
    for (const name of ['display', 'body', 'mono']) {
      expect(empty).toContain(`--kit-font-${name}:`)
      expect(empty).toContain(`--kit-font-${name}-weight:`)
    }
    expect(empty).toContain('--kit-logo: none;')
    expect(empty).not.toContain('@font-face')
  })

  it('falls back by luminance when roles carry no hints', () => {
    const css2 = kitToCss(
      kitTokensSchema.parse({
        palette: [
          { role: 'one', hex: '#101010' },
          { role: 'two', hex: '#FAFAFA' },
          { role: 'three', hex: '#2244AA' },
        ],
      }),
    )
    expect(css2).toContain('--kit-color-background: #FAFAFA;')
    expect(css2).toContain('--kit-color-text: #101010;')
    expect(css2).toContain('--kit-color-primary: #2244AA;')
    expect(css2).toContain('--kit-color-accent: #2244AA;')
  })

  it('strips characters that could break out of a declaration from family names', () => {
    const css3 = kitToCss(
      kitTokensSchema.parse({ fonts: { body: { family: 'Evil";}body{display:none' } } }),
    )
    expect(css3).not.toContain('";}')
    expect(css3).toContain('"Evilbodydisplay:none"')
  })
})

describe('kitSlug / readableInk', () => {
  it('slugs role names', () => {
    expect(kitSlug('Sticky Yellow!')).toBe('sticky-yellow')
    expect(kitSlug('***')).toBe('unnamed')
  })

  it('picks dark ink on light colours and light ink on dark', () => {
    expect(readableInk('#FFFFFF')).toBe('#0F172A')
    expect(readableInk('#000000')).toBe('#F8FAFC')
  })
})
