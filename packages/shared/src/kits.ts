import { z } from 'zod'
import type { SynthesisBrief } from './types'

// Phase 22 — style kits. A kit is a group's SynthesisBrief distilled into
// rigid, versioned tokens. `kitToCss` (kitCss.ts) compiles them to the
// `--kit-*` stylesheet Phase 23 templates read.

const HEX_RE = /^#[0-9a-fA-F]{6}$/

export const kitHexSchema = z.string().regex(HEX_RE, 'Expected a #RRGGBB colour')

// Anything that ends up inside a CSS url("…") must not be able to close it.
// Kit assets live on our own file route or are absolute http(s) URLs.
export function isSafeKitUrl(url: string): boolean {
  if (url.length === 0 || url.length > 500) return false
  if (/[\s"'()\\<>{};]/.test(url)) return false
  return url.startsWith('/api/files/') || /^https?:\/\/[^/]/.test(url)
}
export const kitUrlSchema = z
  .string()
  .refine(isSafeKitUrl, 'Expected an /api/files/… or http(s) URL')

export const KIT_FONT_SLOTS = ['display', 'body', 'mono'] as const
export type KitFontSlot = (typeof KIT_FONT_SLOTS)[number]

export const kitFontSchema = z.object({
  family: z.string().trim().min(1).max(100),
  category: z.enum(['sans', 'serif', 'mono']).default('sans'),
  // Uploaded font file; absent for fonts the machine already has or a web
  // font the template loads itself.
  url: kitUrlSchema.nullable().default(null),
  weights: z.array(z.number().int().min(100).max(900)).max(9).default([]),
  usage: z.string().max(300).default(''),
})
export type KitFont = z.infer<typeof kitFontSchema>

export const kitPaletteColorSchema = z.object({
  role: z.string().trim().min(1).max(40),
  hex: kitHexSchema,
  usage: z.string().max(300).default(''),
})
export type KitPaletteColor = z.infer<typeof kitPaletteColorSchema>

export const kitLogoSchema = z.object({
  name: z.string().trim().min(1).max(60),
  url: kitUrlSchema,
  usage: z.string().max(300).default(''),
})
export type KitLogo = z.infer<typeof kitLogoSchema>

const line = z.string().trim().min(1).max(400)

export const kitTokensSchema = z.object({
  // One line: what the brand is. The brief's throughline.
  summary: z.string().max(400).default(''),
  palette: z.array(kitPaletteColorSchema).max(24).default([]),
  fonts: z
    .object({
      display: kitFontSchema.nullable().default(null),
      body: kitFontSchema.nullable().default(null),
      mono: kitFontSchema.nullable().default(null),
      feel: z.string().max(400).default(''),
    })
    .default({}),
  logos: z.array(kitLogoSchema).max(12).default([]),
  voice: z
    .object({
      tone: z.array(line).max(20).default([]),
      dos: z.array(line).max(20).default([]),
      donts: z.array(line).max(20).default([]),
      examples: z.array(line).max(20).default([]),
    })
    .default({}),
  imagery: z
    .object({
      rules: z.array(line).max(20).default([]),
      references: z.array(line).max(20).default([]),
    })
    .default({}),
  notes: z.array(line).max(30).default([]),
})
export type KitTokens = z.infer<typeof kitTokensSchema>

export function emptyKitTokens(): KitTokens {
  return kitTokensSchema.parse({})
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export const kitSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  clientSlug: z.string(),
  latestVersion: z.number().int(),
  updatedAt: z.string(),
  preview: z.object({
    palette: z.array(z.string()),
    display: z.string().nullable(),
    body: z.string().nullable(),
  }),
})
export type KitSummary = z.infer<typeof kitSummarySchema>

export const kitVersionMetaSchema = z.object({
  version: z.number().int(),
  note: z.string(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
})
export type KitVersionMeta = z.infer<typeof kitVersionMetaSchema>

export const kitsResponseSchema = z.object({ kits: z.array(kitSummarySchema) })
export const kitResponseSchema = z.object({ kit: kitSummarySchema })

export const kitDetailSchema = z.object({
  kit: kitSummarySchema,
  version: kitVersionMetaSchema.extend({ tokens: kitTokensSchema }),
  versions: z.array(kitVersionMetaSchema),
})
export type KitDetail = z.infer<typeof kitDetailSchema>

export const KIT_NAME_MAX = 80
const kitNameSchema = z.string().trim().min(1).max(KIT_NAME_MAX)
const kitNoteSchema = z.string().trim().max(200)

export const createKitRequestSchema = z.object({
  clientId: z.string().min(1),
  name: kitNameSchema,
  tokens: kitTokensSchema.optional(),
  note: kitNoteSchema.optional(),
})
export type CreateKitRequest = z.infer<typeof createKitRequestSchema>

// `baseVersion` is the version the editor started from; when the kit has
// moved on the server answers 409 so a teammate's save isn't buried.
export const createKitVersionRequestSchema = z.object({
  tokens: kitTokensSchema,
  note: kitNoteSchema.optional(),
  baseVersion: z.number().int().optional(),
})
export type CreateKitVersionRequest = z.infer<typeof createKitVersionRequestSchema>

export const updateKitRequestSchema = z
  .object({ name: kitNameSchema, clientId: z.string().min(1) })
  .partial()
export type UpdateKitRequest = z.infer<typeof updateKitRequestSchema>

// ---------------------------------------------------------------------------
// SynthesisBrief → kit tokens ("Save as Style Kit")
// ---------------------------------------------------------------------------

function normaliseHex(raw: string): string | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw.trim())
  if (!m) return null
  const h = m[1]!
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  return `#${full.toUpperCase()}`
}

function fontCategory(category: string): KitFont['category'] {
  const c = category.toLowerCase()
  if (/mono|code|typewriter/.test(c)) return 'mono'
  if (/serif/.test(c) && !/sans/.test(c)) return 'serif'
  return 'sans'
}

function fontSlot(role: string, category: KitFont['category']): KitFontSlot | null {
  if (category === 'mono') return 'mono'
  const r = role.toLowerCase()
  if (/head|display|title|hero|logo|wordmark/.test(r)) return 'display'
  if (/body|text|paragraph|copy|read/.test(r)) return 'body'
  return null
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const clean = (lines: string[], max = 400) =>
  lines.map((l) => clip(l.trim(), max)).filter((l) => l.length > 0)

// Fonts that were uploaded to the board come with a file URL; the brief only
// names them. Pass `uploadedFonts` so a matching family keeps its file.
export type KitFromBriefOptions = { uploadedFonts?: { family: string; url: string }[] }

export function kitFromBrief(brief: SynthesisBrief, options: KitFromBriefOptions = {}): KitTokens {
  const notes: string[] = []

  const seen = new Set<string>()
  const palette: KitPaletteColor[] = []
  brief.palette.forEach((p, i) => {
    const hex = normaliseHex(p.hex)
    if (!hex || seen.has(hex)) return
    seen.add(hex)
    palette.push({
      role: clip(p.role.trim() || `colour ${i + 1}`, 40),
      hex,
      usage: clip(p.note.trim(), 300),
    })
  })

  const uploaded = new Map(
    (options.uploadedFonts ?? [])
      .filter((f) => isSafeKitUrl(f.url))
      .map((f) => [f.family.trim().toLowerCase(), f.url]),
  )
  const slots: Record<KitFontSlot, KitFont | null> = { display: null, body: null, mono: null }
  const unplaced: { font: KitFont; slot: KitFontSlot | null }[] = []
  for (const f of brief.fonts) {
    const family = clip(f.name.trim(), 100)
    if (!family) continue
    const category = fontCategory(f.category)
    const font: KitFont = {
      family,
      category,
      url: uploaded.get(family.toLowerCase()) ?? null,
      weights: [],
      usage: clip(
        [f.role, f.sample]
          .map((s) => s.trim())
          .filter(Boolean)
          .join(' — '),
        300,
      ),
    }
    unplaced.push({ font, slot: fontSlot(f.role, category) })
  }
  // Named roles claim their slot first, then the rest fill what's left.
  for (const { font, slot } of unplaced) {
    if (slot && !slots[slot]) slots[slot] = font
    else if (slot) notes.push(`Additional ${slot} font: ${font.family}`)
  }
  for (const { font, slot } of unplaced) {
    if (slot) continue
    const free = (['display', 'body'] as const).find((s) => !slots[s])
    if (free) slots[free] = font
    else notes.push(`Additional font: ${font.family}`)
  }

  const logos: KitLogo[] = []
  brief.logo.forEach((l, i) => {
    if (!isSafeKitUrl(l.url)) return
    logos.push({
      name: i === 0 ? 'Logo' : `Logo ${i + 1}`,
      url: l.url,
      usage: clip(l.reason.trim(), 300),
    })
  })

  const { model, niche, category } = brief.positioning
  const positioning = [model, niche, category].map((s) => s.trim()).filter(Boolean)
  if (positioning.length > 0) notes.push(`Positioning: ${positioning.join(' · ')}`)
  notes.push(...brief.tensions.map((t) => `Tension: ${t}`))
  notes.push(...brief.notes)

  return kitTokensSchema.parse({
    summary: clip(brief.throughline.trim(), 400),
    palette: palette.slice(0, 24),
    fonts: { ...slots, feel: clip(brief.typography.feel.trim(), 400) },
    logos: logos.slice(0, 12),
    voice: {
      tone: clean(brief.statements).slice(0, 20),
      dos: [],
      donts: clean(brief.watchFors).slice(0, 20),
      examples: clean([...brief.hooks, brief.bodyCopy]).slice(0, 20),
    },
    imagery: { rules: [], references: clean(brief.references).slice(0, 20) },
    notes: clean(notes).slice(0, 30),
  })
}
