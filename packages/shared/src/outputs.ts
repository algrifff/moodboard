import { z } from 'zod'
import { kitTokensSchema, type KitTokens } from './kits'
import { SLOT_NAME_RE, isSlotImageValue } from './slots'

// Phase 23 — templates and outputs. A template is style-agnostic HTML + CSS
// with `data-slot` markers that reads only `--kit-*` variables; an output is
// a template instantiated for a client with a kit and filled slots. Both are
// versioned text: every edit appends an immutable version.

export const OUTPUT_FORMATS = [
  'thumbnail',
  'social',
  'deck',
  'landing',
  'one-pager',
  'other',
] as const
export const outputFormatSchema = z.enum(OUTPUT_FORMATS)
export type OutputFormat = z.infer<typeof outputFormatSchema>

export const OUTPUT_FORMAT_LABELS: Record<OutputFormat, string> = {
  thumbnail: 'Thumbnail',
  social: 'Social post',
  deck: 'Deck',
  landing: 'Landing page',
  'one-pager': 'One-pager',
  other: 'Other',
}

// Fixed: the document is designed for exactly this viewport (previews fit
// it to the frame; Phase 25 renders frames at this size). Responsive: the
// document adapts to any width.
export const templateViewportSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fixed'),
    width: z.number().int().min(100).max(4096),
    height: z.number().int().min(100).max(8192),
  }),
  z.object({ kind: z.literal('responsive') }),
])
export type TemplateViewport = z.infer<typeof templateViewportSchema>

// What an output without a kit is skinned with: quiet, legible, neutral.
export const HOUSE_KIT_TOKENS: KitTokens = kitTokensSchema.parse({
  palette: [
    { role: 'background', hex: '#F6F4EF' },
    { role: 'surface', hex: '#FFFFFF' },
    { role: 'text', hex: '#17161C' },
    { role: 'primary', hex: '#23233A' },
    { role: 'accent', hex: '#FF5A36' },
  ],
})

// What a responsive document is previewed / carded at by default.
export const RESPONSIVE_PREVIEW = { width: 1440, height: 900 } as const

export function viewportSize(viewport: TemplateViewport): { width: number; height: number } {
  return viewport.kind === 'fixed'
    ? { width: viewport.width, height: viewport.height }
    : RESPONSIVE_PREVIEW
}

export const slotNameSchema = z.string().regex(SLOT_NAME_RE, 'Lowercase letters, digits and dashes')

export const templateSlotSchema = z.object({
  name: slotNameSchema,
  kind: z.enum(['text', 'image']),
  label: z.string().trim().min(1).max(60),
})
export type TemplateSlot = z.infer<typeof templateSlotSchema>

export const SLOT_TEXT_MAX = 2000
export const DOC_HTML_MAX = 400_000
export const DOC_CSS_MAX = 200_000

// Text slots are plain text (escaped on render); image slots are an asset
// from the library, referenced by its /api/files URL and inlined on render.
export const slotValueSchema = z.string().max(SLOT_TEXT_MAX)
export const slotValuesSchema = z.record(slotNameSchema, slotValueSchema)
export type SlotValues = z.infer<typeof slotValuesSchema>

export function invalidSlotValues(
  slots: { name: string; kind: 'text' | 'image' }[],
  values: Record<string, string | null>,
): string[] {
  const kinds = new Map(slots.map((s) => [s.name, s.kind]))
  return Object.entries(values).flatMap(([name, value]) => {
    if (value === null) return []
    const kind = kinds.get(name)
    if (!kind) return [`${name}: no such slot`]
    if (kind === 'image' && !isSlotImageValue(value)) {
      return [`${name}: an image slot takes an asset URL like /api/files/abc.png`]
    }
    return []
  })
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const templateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  format: outputFormatSchema,
  viewport: templateViewportSchema,
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  // Starter templates ship with the app and are kept in sync on boot.
  starter: z.boolean(),
  latestVersion: z.number().int(),
  slots: z.array(templateSlotSchema),
  updatedAt: z.string(),
})
export type TemplateSummary = z.infer<typeof templateSummarySchema>

export const versionMetaSchema = z.object({
  version: z.number().int(),
  note: z.string(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
})
export type VersionMeta = z.infer<typeof versionMetaSchema>

export const templateDetailSchema = z.object({
  template: templateSummarySchema,
  version: versionMetaSchema.extend({
    html: z.string(),
    css: z.string(),
    js: z.string(),
    slots: z.array(templateSlotSchema),
  }),
  versions: z.array(versionMetaSchema),
})
export type TemplateDetail = z.infer<typeof templateDetailSchema>

export const templatesResponseSchema = z.object({ templates: z.array(templateSummarySchema) })
export const templateResponseSchema = z.object({ template: templateSummarySchema })

export const TEMPLATE_NAME_MAX = 80
const templateNameSchema = z.string().trim().min(1).max(TEMPLATE_NAME_MAX)

// Save as template: every slot marker in the output, renamed (`to`), given a
// label, or dropped (`to: null` removes the marker; the content stays).
export const templateSlotEditSchema = z.object({
  from: slotNameSchema,
  to: slotNameSchema.nullable(),
  label: z.string().trim().max(60).optional(),
})
export type TemplateSlotEdit = z.infer<typeof templateSlotEditSchema>

export const createTemplateFromOutputRequestSchema = z.object({
  outputId: z.string().min(1),
  version: z.number().int().positive().optional(),
  name: templateNameSchema,
  format: outputFormatSchema.optional(),
  clientId: z.string().min(1).nullable().optional(),
  slots: z.array(templateSlotEditSchema).max(100).default([]),
})
export type CreateTemplateFromOutputRequest = z.infer<typeof createTemplateFromOutputRequestSchema>

export const updateTemplateRequestSchema = z
  .object({ name: templateNameSchema, clientId: z.string().min(1).nullable() })
  .partial()
export type UpdateTemplateRequest = z.infer<typeof updateTemplateRequestSchema>

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const outputSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  format: outputFormatSchema,
  viewport: templateViewportSchema,
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  boardId: z.string().nullable(),
  templateId: z.string().nullable(),
  templateName: z.string().nullable(),
  kitId: z.string().nullable(),
  kitName: z.string().nullable(),
  latestVersion: z.number().int(),
  createdByName: z.string().nullable(),
  updatedAt: z.string(),
})
export type OutputSummary = z.infer<typeof outputSummarySchema>

export const outputVersionMetaSchema = versionMetaSchema.extend({
  kitId: z.string().nullable(),
  kitVersion: z.number().int().nullable(),
})
export type OutputVersionMeta = z.infer<typeof outputVersionMetaSchema>

// A slot as the output view shows it: what the document declares, the value
// the output sets (null = the template's default), and that default.
export const outputSlotSchema = z.object({
  name: z.string(),
  kind: z.enum(['text', 'image']),
  label: z.string(),
  value: z.string().nullable(),
  defaultValue: z.string(),
})
export type OutputSlot = z.infer<typeof outputSlotSchema>

export const outputShareSchema = z.object({
  token: z.string(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type OutputShare = z.infer<typeof outputShareSchema>

export const outputDetailSchema = z.object({
  output: outputSummarySchema,
  version: outputVersionMetaSchema.extend({
    templateVersion: z.number().int().nullable(),
    slotValues: slotValuesSchema,
    html: z.string(),
    css: z.string(),
    slots: z.array(outputSlotSchema),
    // The pinned kit's newest version, so the view can offer an update.
    kitLatestVersion: z.number().int().nullable(),
  }),
  versions: z.array(outputVersionMetaSchema),
  share: outputShareSchema.nullable(),
})
export type OutputDetail = z.infer<typeof outputDetailSchema>

export const outputsResponseSchema = z.object({ outputs: z.array(outputSummarySchema) })
export const outputResponseSchema = z.object({ output: outputSummarySchema })

export const OUTPUT_NAME_MAX = 120
const outputNameSchema = z.string().trim().min(1).max(OUTPUT_NAME_MAX)

export const createOutputRequestSchema = z.object({
  templateId: z.string().min(1),
  clientId: z.string().min(1).nullable().optional(),
  kitId: z.string().min(1).nullable().optional(),
  name: outputNameSchema.optional(),
  slotValues: slotValuesSchema.optional(),
  boardId: z.string().min(1).optional(),
})
export type CreateOutputRequest = z.infer<typeof createOutputRequestSchema>

// A new version from the latest: slot values are merged (null resets a slot
// to the template default), the kit is switched, or the HTML/CSS replaced.
// `restoreVersion` copies an older version forward instead. `baseVersion` is
// the version the editor started from; a newer one on the server is a 409.
export const createOutputVersionRequestSchema = z.object({
  baseVersion: z.number().int().positive(),
  slotValues: z.record(slotNameSchema, slotValueSchema.nullable()).optional(),
  kitId: z.string().min(1).nullable().optional(),
  html: z.string().max(DOC_HTML_MAX).optional(),
  css: z.string().max(DOC_CSS_MAX).optional(),
  restoreVersion: z.number().int().positive().optional(),
  note: z.string().trim().max(200).optional(),
})
export type CreateOutputVersionRequest = z.infer<typeof createOutputVersionRequestSchema>

export const updateOutputRequestSchema = z
  .object({ name: outputNameSchema, clientId: z.string().min(1).nullable() })
  .partial()
export type UpdateOutputRequest = z.infer<typeof updateOutputRequestSchema>

export const placeOutputRequestSchema = z.object({
  boardId: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
})

export const outputShareResponseSchema = z.object({ share: outputShareSchema })

// Public: GET /api/output-shares/:token. No ids beyond the token.
export const outputShareViewSchema = z.object({
  token: z.string(),
  name: z.string(),
  format: outputFormatSchema,
  viewport: templateViewportSchema,
  version: z.number().int(),
  updatedAt: z.string(),
})
export type OutputShareView = z.infer<typeof outputShareViewSchema>
export const outputShareViewResponseSchema = z.object({ share: outputShareViewSchema })

export const proposedSlotsResponseSchema = z.object({ slots: z.array(templateSlotSchema) })

// Paths the app serves a composed document from. Shared so the web preview,
// board cards and agent tools build the same URLs.
export function outputRenderPath(
  id: string,
  opts: { version?: number; edit?: boolean; download?: boolean } = {},
): string {
  const q = new URLSearchParams()
  if (opts.version) q.set('version', String(opts.version))
  if (opts.edit) q.set('edit', '1')
  if (opts.download) q.set('download', '1')
  const qs = q.toString()
  return `/api/outputs/${id}/render${qs ? `?${qs}` : ''}`
}

// postMessage protocol between the edit-mode preview and the output view.
export const SLOT_EDIT_MESSAGE = 'moodboard:slot-edit'
export const SLOT_FOCUS_MESSAGE = 'moodboard:slot-focus'
