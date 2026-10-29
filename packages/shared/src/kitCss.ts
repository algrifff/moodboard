import { isSafeKitUrl, type KitFont, type KitTokens } from './kits'

// kitToCss — compiles kit tokens to the stylesheet every Phase 23+ template
// skins itself with. THE VARIABLE NAMES BELOW ARE A CONTRACT: templates read
// them, so they only ever grow; a rename is a breaking change to every
// template.
//
// Always emitted (templates may rely on these existing, whatever the kit):
//   --kit-color-background   page ground
//   --kit-color-surface      cards / panels on the ground
//   --kit-color-text         body text on the ground
//   --kit-color-primary      the brand's anchor colour
//   --kit-color-accent       the sparing, attention-getting colour
//   --kit-color-on-primary   readable text on primary (#0F172A or #F8FAFC)
//   --kit-color-on-accent    readable text on accent
//   --kit-font-display       full font stack for headlines
//   --kit-font-body          full font stack for running text
//   --kit-font-mono          full font stack for labels / code
//   --kit-font-display-weight / --kit-font-body-weight / --kit-font-mono-weight
//   --kit-logo               url("…") of the first logo, or `none`
//
// Emitted per token (names are slugs of the token's name, see kitSlug):
//   --kit-color-<role>       every palette entry, e.g. --kit-color-heat
//   --kit-logo-<name>        every logo variant, e.g. --kit-logo-wordmark-dark
//
// Voice, imagery and notes are text for agents (get_style_kit returns them);
// they have no CSS form.
//
// Uploaded fonts get an @font-face whose family is the kit's family name, so
// `font-family: var(--kit-font-display)` just works. A slot with several
// weights is declared as a weight range (one variable font file).

const DARK_INK = '#0F172A'
const LIGHT_INK = '#F8FAFC'

export function kitSlug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'unnamed'
  )
}

function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return 0.299 * r + 0.587 * g + 0.114 * b
}

export function readableInk(hex: string): string {
  return luminance(hex) > 0.55 ? DARK_INK : LIGHT_INK
}

type Semantic = 'background' | 'surface' | 'text' | 'primary' | 'accent'

// Role words that mean each semantic colour. An exact slug match beats a
// substring match; earlier words beat later ones.
const SYNONYMS: Record<Semantic, string[]> = {
  background: ['background', 'bg', 'paper', 'canvas', 'ground', 'base', 'page'],
  text: ['text', 'foreground', 'fg', 'ink', 'copy', 'body', 'type'],
  primary: ['primary', 'brand', 'main', 'foundation', 'core', 'key'],
  accent: ['accent', 'highlight', 'secondary', 'pop', 'heat', 'cta'],
  surface: ['surface', 'card', 'panel', 'elevated'],
}
// Order matters: earlier semantics claim colours first.
const RESOLVE_ORDER: Semantic[] = ['background', 'text', 'primary', 'accent', 'surface']

type Entry = { slug: string; hex: string }

function resolveSemantics(palette: Entry[]): Record<Semantic, string> {
  const claimed = new Set<number>()
  const found: Partial<Record<Semantic, number>> = {}
  for (const sem of RESOLVE_ORDER) {
    const words = SYNONYMS[sem]
    let idx = -1
    for (const w of words) {
      idx = palette.findIndex((p, i) => !claimed.has(i) && p.slug === w)
      if (idx !== -1) break
    }
    if (idx === -1) {
      for (const w of words) {
        idx = palette.findIndex((p, i) => !claimed.has(i) && p.slug.split('-').includes(w))
        if (idx !== -1) break
      }
    }
    if (idx !== -1) {
      claimed.add(idx)
      found[sem] = idx
    }
  }

  const hexOf = (sem: Semantic): string | undefined =>
    found[sem] === undefined ? undefined : palette[found[sem]!]!.hex
  const unclaimed = () => palette.map((p, i) => ({ ...p, i })).filter((p) => !claimed.has(p.i))
  const take = (
    pick: (rest: ReturnType<typeof unclaimed>) => { hex: string; i: number } | undefined,
  ) => {
    const hit = pick(unclaimed())
    if (!hit) return undefined
    claimed.add(hit.i)
    return hit.hex
  }
  const byLuma = (dir: 1 | -1) => (rest: ReturnType<typeof unclaimed>) =>
    [...rest].sort((a, b) => dir * (luminance(b.hex) - luminance(a.hex)))[0]

  const background = hexOf('background') ?? take(byLuma(1)) ?? '#FFFFFF'
  const text =
    hexOf('text') ?? take(byLuma(-1)) ?? (luminance(background) > 0.55 ? '#111111' : '#F5F5F5')
  const primary = hexOf('primary') ?? take((rest) => rest[0]) ?? text
  const accent = hexOf('accent') ?? take((rest) => rest[0]) ?? primary
  const surface = hexOf('surface') ?? background
  return { background, surface, text, primary, accent }
}

// Characters that could end a CSS string or declaration are dropped from
// family names rather than escaped: no real family name needs them.
function cssFamily(family: string): string {
  return family.replace(/["'\;{}<>\n\r]/g, '').trim()
}

const GENERIC: Record<KitFont['category'], string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
}

function fontStack(font: KitFont | null): string | null {
  if (!font) return null
  const family = cssFamily(font.family)
  if (!family) return null
  return `"${family}", ${GENERIC[font.category]}`
}

function closestWeight(weights: number[], target: number): number {
  if (weights.length === 0) return target
  return weights.reduce((best, w) => (Math.abs(w - target) < Math.abs(best - target) ? w : best))
}

function fontFace(font: KitFont): string | null {
  const family = cssFamily(font.family)
  if (!font.url || !family || !isSafeKitUrl(font.url)) return null
  const lo = font.weights.length > 0 ? Math.min(...font.weights) : 400
  const hi = font.weights.length > 0 ? Math.max(...font.weights) : 400
  return [
    '@font-face {',
    `  font-family: "${family}";`,
    `  src: url("${font.url}");`,
    `  font-weight: ${lo === hi ? lo : `${lo} ${hi}`};`,
    '  font-display: swap;',
    '}',
  ].join('\n')
}

const RESERVED_COLOR_SLUGS = new Set([
  'background',
  'surface',
  'text',
  'primary',
  'accent',
  'on-primary',
  'on-accent',
])

export function kitToCss(tokens: KitTokens): string {
  const entries: Entry[] = tokens.palette.map((p) => ({ slug: kitSlug(p.role), hex: p.hex }))
  const sem = resolveSemantics(entries)

  const vars: string[] = [
    `--kit-color-background: ${sem.background};`,
    `--kit-color-surface: ${sem.surface};`,
    `--kit-color-text: ${sem.text};`,
    `--kit-color-primary: ${sem.primary};`,
    `--kit-color-accent: ${sem.accent};`,
    `--kit-color-on-primary: ${readableInk(sem.primary)};`,
    `--kit-color-on-accent: ${readableInk(sem.accent)};`,
  ]

  const usedColor = new Set<string>()
  for (const e of entries) {
    if (RESERVED_COLOR_SLUGS.has(e.slug)) continue
    let name = e.slug
    for (let n = 2; usedColor.has(name); n++) name = `${e.slug}-${n}`
    usedColor.add(name)
    vars.push(`--kit-color-${name}: ${e.hex};`)
  }

  const { display, body, mono } = tokens.fonts
  const bodyStack = fontStack(body) ?? GENERIC.sans
  vars.push(
    `--kit-font-display: ${fontStack(display) ?? bodyStack};`,
    `--kit-font-body: ${bodyStack};`,
    `--kit-font-mono: ${fontStack(mono) ?? GENERIC.mono};`,
    `--kit-font-display-weight: ${closestWeight(display?.weights ?? [], 700)};`,
    `--kit-font-body-weight: ${closestWeight(body?.weights ?? [], 400)};`,
    `--kit-font-mono-weight: ${closestWeight(mono?.weights ?? [], 400)};`,
  )

  const logos = tokens.logos.filter((l) => isSafeKitUrl(l.url))
  vars.push(`--kit-logo: ${logos[0] ? `url("${logos[0].url}")` : 'none'};`)
  const usedLogo = new Set<string>()
  for (const l of logos) {
    const base = kitSlug(l.name)
    let name = base
    for (let n = 2; usedLogo.has(name); n++) name = `${base}-${n}`
    usedLogo.add(name)
    vars.push(`--kit-logo-${name}: url("${l.url}");`)
  }

  const faces = [...new Set([display, body, mono].flatMap((f) => (f ? [fontFace(f)] : [])))].filter(
    (f): f is string => f !== null,
  )
  const root = `:root {\n${vars.map((v) => `  ${v}`).join('\n')}\n}`
  return [...faces, root].join('\n\n') + '\n'
}
