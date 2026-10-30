import { z } from 'zod'
import {
  kitSummarySchema,
  kitTokensSchema,
  kitVersionMetaSchema,
  type KitFont,
  type KitFontSlot,
  type KitPaletteColor,
  type KitTokens,
} from './kits'

// Phase 26 — a Figma file's styles and variables → style-kit tokens. The API
// reads the file and normalises Figma's REST shapes into FigmaKitInput
// (apps/api/src/lib/figmaStyles.ts); everything from there is pure, so the
// mapping is tested without Figma. Like kitFromBrief it always produces valid
// tokens, and it says what it used and what it left behind.

export type FigmaColourInput = {
  // The style or variable name as designers wrote it, e.g. "Brand/Primary".
  name: string
  hex: string
  alpha: number
  source: 'variable' | 'style' | 'observed'
}

export type FigmaTextInput = {
  name: string
  family: string
  weight: number
  size: number
  // How many layers use the style (0 when unknown).
  uses: number
  source: 'variable' | 'style' | 'observed'
}

export type FigmaKitInput = {
  fileKey: string
  fileName: string
  lastModified: string
  // In priority order: variables, then colour styles, then the most-used
  // plain fills (only consulted when there is nothing named).
  colours: FigmaColourInput[]
  texts: FigmaTextInput[]
  // Left behind while reading the file (gradient fills, effect styles, …),
  // passed through to the report.
  skipped: { label: string; reason: string }[]
  // Whether the variables endpoint answered: 'forbidden' is a plan or scope
  // without variables access, 'unavailable' any other failure.
  variables: 'used' | 'forbidden' | 'unavailable'
}

export const figmaKitReportSchema = z.object({
  mapped: z.array(
    z.object({
      kind: z.enum(['colour', 'font']),
      label: z.string(),
      detail: z.string(),
      swatch: z.string().optional(),
    }),
  ),
  skipped: z.array(z.object({ label: z.string(), reason: z.string() })),
  variables: z.enum(['used', 'forbidden', 'unavailable']),
})
export type FigmaKitReport = z.infer<typeof figmaKitReportSchema>

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const toByte = (v: number) =>
  Math.max(0, Math.min(255, Math.round(v * 255)))
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()

/** Figma's 0–1 float channels → "#RRGGBB". */
export function figmaRgbToHex(c: { r: number; g: number; b: number }): string {
  return `#${toByte(c.r)}${toByte(c.g)}${toByte(c.b)}`
}

const GENERIC_ROLE_SEGMENTS = /^(colou?rs?|palette|fills?|tokens?|styles?|primitives?|global|ref)$/i
const ROLE_MAX = 40
const OPAQUE_ALPHA = 0.99

// "Colors/Brand/Primary" → "Brand Primary"; a lone generic segment is kept.
export function figmaRoleName(name: string, fallback: string): string {
  let segments = name
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
  while (segments.length > 1 && GENERIC_ROLE_SEGMENTS.test(segments[0]!))
    segments = segments.slice(1)
  let joined = segments.join(' ').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || fallback
  // Variable paths are usually lowercase ("color/brand/primary").
  if (joined === joined.toLowerCase()) joined = joined.replace(/\b[a-z]/g, (c) => c.toUpperCase())
  if (joined.length <= ROLE_MAX) return joined
  const cut = joined.slice(0, ROLE_MAX)
  const space = cut.lastIndexOf(' ')
  return (space > ROLE_MAX * 0.6 ? cut.slice(0, space) : cut).trim()
}

const PALETTE_MAX = 24

function mapColours(
  input: FigmaKitInput,
  mapped: FigmaKitReport['mapped'],
  skipped: FigmaKitReport['skipped'],
): KitPaletteColor[] {
  const named = input.colours.filter((c) => c.source !== 'observed')
  const candidates = named.length > 0 ? named : input.colours
  if (named.length === 0 && candidates.length > 0) {
    skipped.push({
      label: 'Colour styles and variables',
      reason: 'None found, so the most-used fills were taken instead; rename the roles in the kit.',
    })
  }

  const palette: KitPaletteColor[] = []
  const byHex = new Map<string, string>()
  const roles = new Set<string>()
  for (const c of candidates) {
    const hex = /^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex.toUpperCase() : null
    if (!hex) {
      skipped.push({ label: c.name, reason: 'Not a plain RGB colour.' })
      continue
    }
    if (c.alpha < OPAQUE_ALPHA) {
      skipped.push({ label: c.name, reason: `Semi-transparent (${Math.round(c.alpha * 100)}%).` })
      continue
    }
    const twin = byHex.get(hex)
    if (twin) {
      skipped.push({ label: c.name, reason: `Same colour as “${twin}”.` })
      continue
    }
    if (palette.length >= PALETTE_MAX) {
      skipped.push({ label: c.name, reason: `Past the kit’s ${PALETTE_MAX}-colour limit.` })
      continue
    }
    let role = figmaRoleName(c.name, `Colour ${palette.length + 1}`)
    for (let n = 2; roles.has(role.toLowerCase()); n++) {
      role = `${figmaRoleName(c.name, 'Colour').slice(0, ROLE_MAX - 3)} ${n}`
    }
    roles.add(role.toLowerCase())
    byHex.set(hex, c.name)
    const origin =
      c.source === 'variable' ? 'variable' : c.source === 'style' ? 'colour style' : 'fill'
    palette.push({ role, hex, usage: `Figma ${origin} “${c.name}”`.slice(0, 300) })
    mapped.push({ kind: 'colour', label: role, detail: `${hex} · ${origin}`, swatch: hex })
  }
  return palette
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

type Slot = KitFontSlot

const MONO_FAMILY_RE = /mono|code|courier|consolas|menlo|typewriter/i
const MONO_NAME_RE = /\b(mono|monospace|code)\b/i
const DISPLAY_NAME_RE = /display|heading|headline|title|hero|jumbo|\bh[1-3]\b|large/i
const BODY_NAME_RE = /body|paragraph|\btext\b|copy|caption|label|small|\bp\b|base|default|\bui\b/i
const SERIF_FAMILY_RE =
  /georgia|times|garamond|playfair|merriweather|lora|baskerville|caslon|bodoni|didot|cormorant|crimson|fraunces|spectral|\bserif\b/i

function classify(t: FigmaTextInput): Slot | null {
  if (MONO_FAMILY_RE.test(t.family) || MONO_NAME_RE.test(t.name)) return 'mono'
  if (DISPLAY_NAME_RE.test(t.name)) return 'display'
  if (BODY_NAME_RE.test(t.name)) return 'body'
  return null
}

export function figmaFontCategory(family: string): KitFont['category'] {
  if (MONO_FAMILY_RE.test(family)) return 'mono'
  if (SERIF_FAMILY_RE.test(family) && !/sans/i.test(family)) return 'serif'
  return 'sans'
}

type Family = {
  family: string
  styles: (FigmaTextInput & { slot: Slot | null })[]
  uses: number
  maxSize: number
}

const weightOf = (w: number) => Math.max(100, Math.min(900, Math.round(w || 400)))

function buildFont(group: Family, slot: Slot): KitFont {
  const specific = group.styles.filter((s) => s.slot === slot)
  const pool = specific.length > 0 ? specific : group.styles
  const weights = [...new Set(pool.map((s) => weightOf(s.weight)))].sort((a, b) => a - b)
  const sample = [...pool].sort((a, b) => b.size - a.size).slice(0, 3)
  const usage = sample
    .map((s) => (s.size > 0 ? `${s.name} (${Math.round(s.size)}px ${weightOf(s.weight)})` : s.name))
    .join(', ')
  return {
    family: group.family.slice(0, 100),
    category: figmaFontCategory(group.family),
    url: null,
    weights: weights.slice(0, 9),
    usage: `Figma text styles: ${usage}`.slice(0, 300),
  }
}

function mapFonts(
  input: FigmaKitInput,
  mapped: FigmaKitReport['mapped'],
  skipped: FigmaKitReport['skipped'],
  notes: string[],
): Record<Slot, KitFont | null> {
  const slots: Record<Slot, KitFont | null> = { display: null, body: null, mono: null }
  const texts = input.texts.filter((t) => t.family.trim().length > 0)
  const named = texts.filter((t) => t.source !== 'observed')
  const pool = named.length > 0 ? named : texts
  if (pool.length === 0) return slots

  const groups = new Map<string, Family>()
  for (const t of pool) {
    const key = t.family.trim().toLowerCase()
    const g = groups.get(key) ?? { family: t.family.trim(), styles: [], uses: 0, maxSize: 0 }
    g.styles.push({ ...t, slot: classify(t) })
    g.uses += Math.max(1, t.uses)
    g.maxSize = Math.max(g.maxSize, t.size)
    groups.set(key, g)
  }
  const families = [...groups.values()]
  const proportional = families.filter((g) => !g.styles.every((s) => s.slot === 'mono'))
  const withSlot = (g: Family, slot: Slot) => g.styles.some((s) => s.slot === slot)
  const sizeIn = (g: Family, slot: Slot) =>
    Math.max(...g.styles.filter((s) => s.slot === slot).map((s) => s.size), 0)

  const mono = families.filter((g) => withSlot(g, 'mono')).sort((a, b) => b.uses - a.uses)[0]
  const display =
    proportional
      .filter((g) => withSlot(g, 'display'))
      .sort((a, b) => sizeIn(b, 'display') - sizeIn(a, 'display'))[0] ?? undefined
  const body =
    proportional
      .filter((g) => withSlot(g, 'body') && g !== display)
      .sort((a, b) => b.uses - a.uses)[0] ??
    proportional.filter((g) => withSlot(g, 'body')).sort((a, b) => b.uses - a.uses)[0] ??
    undefined

  const chosen = new Map<Slot, Family>()
  if (mono) chosen.set('mono', mono)
  if (display) chosen.set('display', display)
  if (body) chosen.set('body', body)

  // Nothing said which is which: the biggest type is the display face, the
  // most used the body face, and a lone family does both jobs.
  if (!chosen.has('display')) {
    const rest = proportional.filter((g) => g !== chosen.get('body'))
    const pick = [...rest].sort((a, b) => b.maxSize - a.maxSize)[0] ?? chosen.get('body')
    if (pick) chosen.set('display', pick)
  }
  if (!chosen.has('body')) {
    const pick =
      proportional.filter((g) => g !== chosen.get('display')).sort((a, b) => b.uses - a.uses)[0] ??
      chosen.get('display')
    if (pick) chosen.set('body', pick)
  }

  for (const slot of ['display', 'body', 'mono'] as const) {
    const g = chosen.get(slot)
    if (!g) continue
    const font = buildFont(g, slot)
    slots[slot] = font
    mapped.push({
      kind: 'font',
      label: `${slot[0]!.toUpperCase()}${slot.slice(1)} font`,
      detail: `${font.family}${font.weights.length > 0 ? ` · ${font.weights.join(', ')}` : ''}`,
    })
  }

  const used = new Set(chosen.values())
  for (const g of families.filter((f) => !used.has(f))) {
    skipped.push({
      label: `Font “${g.family}”`,
      reason: 'A kit holds three fonts (display, body, mono); this one is listed in the notes.',
    })
    notes.push(`Additional font: ${g.family}`)
  }
  if (chosen.size > 0) {
    skipped.push({
      label: 'Font files',
      reason: 'Figma has no font files; upload them on the kit.',
    })
  }
  return slots
}

// ---------------------------------------------------------------------------
// The whole kit
// ---------------------------------------------------------------------------

export const FIGMA_NOTE_PREFIX = 'Imported from Figma'

export function kitFromFigma(input: FigmaKitInput): { tokens: KitTokens; report: FigmaKitReport } {
  const mapped: FigmaKitReport['mapped'] = []
  const skipped: FigmaKitReport['skipped'] = []
  const notes: string[] = []

  const palette = mapColours(input, mapped, skipped)
  const fonts = mapFonts(input, mapped, skipped, notes)
  skipped.push(...input.skipped)
  if (input.variables === 'forbidden') {
    skipped.push({
      label: 'Variables',
      reason: 'Not available to this token (Figma gives variables to Enterprise plans only).',
    })
  } else if (input.variables === 'unavailable') {
    skipped.push({ label: 'Variables', reason: 'Figma didn’t return them.' })
  }
  skipped.push({
    label: 'Logos, voice and imagery rules',
    reason: 'Figma styles don’t carry them; add them on the kit.',
  })

  const modified = input.lastModified ? `, last modified ${input.lastModified.slice(0, 10)}` : ''
  const tokens = kitTokensSchema.parse({
    summary: `Tokens imported from the Figma file “${input.fileName}”.`.slice(0, 400),
    palette,
    fonts: { ...fonts, feel: '' },
    notes: [
      `${FIGMA_NOTE_PREFIX} file “${input.fileName}” (${input.fileKey})${modified}.`,
      ...notes,
    ]
      .map((n) => n.slice(0, 400))
      .slice(0, 30),
  })
  return { tokens, report: { mapped, skipped, variables: input.variables } }
}

/**
 * A new version of an existing kit from a Figma import: the palette and fonts
 * come from Figma; logos, voice, imagery rules and hand-written notes stay.
 * A font that keeps its family keeps its uploaded file.
 */
export function mergeFigmaIntoKit(existing: KitTokens, imported: KitTokens): KitTokens {
  const fonts = (['display', 'body', 'mono'] as const).reduce(
    (acc, slot) => {
      const fresh = imported.fonts[slot]
      const old = existing.fonts[slot]
      acc[slot] =
        fresh && old && old.family.toLowerCase() === fresh.family.toLowerCase()
          ? { ...fresh, url: old.url }
          : (fresh ?? old)
      return acc
    },
    {} as Record<KitFontSlot, KitFont | null>,
  )
  return kitTokensSchema.parse({
    ...existing,
    summary: existing.summary || imported.summary,
    palette: imported.palette.length > 0 ? imported.palette : existing.palette,
    fonts: { ...fonts, feel: existing.fonts.feel },
    notes: [
      ...existing.notes.filter((n) => !n.startsWith(FIGMA_NOTE_PREFIX)),
      ...imported.notes,
    ].slice(-30),
  })
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

// `preview: true` reads the file and returns the mapping without saving.
// `kitId` makes a new version of that kit (its client is kept); otherwise a
// new kit is created for `clientId`.
export const figmaKitRequestSchema = z.object({
  url: z.string().min(1).max(2000),
  clientId: z.string().min(1).optional(),
  kitId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  preview: z.boolean().optional(),
  baseVersion: z.number().int().optional(),
})
export type FigmaKitRequest = z.infer<typeof figmaKitRequestSchema>

export const figmaKitResponseSchema = z.object({
  saved: z.boolean(),
  fileName: z.string(),
  tokens: kitTokensSchema,
  report: figmaKitReportSchema,
  kit: kitSummarySchema.nullable(),
  version: kitVersionMetaSchema.pick({ version: true }).nullable(),
})
export type FigmaKitResponse = z.infer<typeof figmaKitResponseSchema>
