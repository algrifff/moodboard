import { z } from 'zod'

export const imageDataSchema = z.object({
  url: z.string().url(),
  thumbnailUrl: z.string().url().optional(),
})

export const stickyDataSchema = z.object({
  text: z.string(),
  color: z.string(),
  // When true, the note renders without its background colour — just the
  // markdown text on the canvas. Toggleable per-note via the floating
  // toolbar that appears when the note is selected.
  transparent: z.boolean().optional(),
})

export const textDataSchema = z.object({
  text: z.string(),
  font: z.string(),
  fontSize: z.number(),
})

export const pdfDataSchema = z.object({
  url: z.string().url(),
  thumbnailUrl: z.string().url(),
  extractedText: z.string(),
  pageCount: z.number().optional(),
})

export const fontDataSchema = z.object({
  url: z.string().url(),
  family: z.string(),
  sampleText: z.string().optional(),
})

export const canvasObjectSchema = z.object({
  id: z.string(),
  type: z.enum(['image', 'sticky', 'text', 'pdf', 'font']),
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ width: z.number(), height: z.number() }),
  rotation: z.number(),
  zIndex: z.number(),
  data: z.union([imageDataSchema, stickyDataSchema, textDataSchema, pdfDataSchema, fontDataSchema]),
})

export const aiAnalysisSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  mood: z.string(),
  tone: z.string(),
  palette: z.array(z.string()),
  adjectives: z.array(z.string()),
  emotions: z.array(z.string()),
  typographicVoice: z.array(z.string()),
  themes: z.array(z.string()),
  references: z.array(z.string()),
  tensions: z.array(z.string()),
  risks: z.array(z.string()),
  hooks: z.array(z.string()),
  statements: z.array(z.string()),
  tropes: z.array(z.string()),
  logo: z.object({
    url: z.string(),
    reason: z.string(),
  }),
  fonts: z.array(
    z.object({
      name: z.string(),
      category: z.string(),
      role: z.string(),
      sample: z.string(),
    }),
  ),
})

export const sectionedParagraphsSchema = z.object({
  sections: z
    .array(
      z.object({
        heading: z.string(),
        body: z.string(),
      }),
    )
    .min(1)
    .max(10),
})

// The synthesiser's structured brief. Every field is present (Anthropic's
// json_schema mode requires it); empty arrays / empty strings signal "no
// content for this block" and the renderer skips them.
export const synthesisBriefSchema = z.object({
  throughline: z.string(),
  throughlineSource: z.string(),
  positioning: z.object({
    model: z.string(),
    niche: z.string(),
    category: z.string(),
  }),
  palette: z.array(
    z.object({
      hex: z.string(),
      role: z.string(),
      note: z.string(),
    }),
  ),
  typography: z.object({
    feel: z.string(),
  }),
  fonts: z.array(
    z.object({
      name: z.string(),
      category: z.string(),
      role: z.string(),
      sample: z.string(),
    }),
  ),
  logo: z.object({
    url: z.string(),
    reason: z.string(),
  }),
  references: z.array(z.string()),
  tensions: z.array(z.string()),
  audiences: z.array(z.object({ label: z.string(), insight: z.string() })),
  channels: z.array(z.object({ name: z.string(), play: z.string() })),
  hooks: z.array(z.string()),
  bodyCopy: z.string(),
  statements: z.array(z.string()),
  watchFors: z.array(z.string()),
  notes: z.array(z.string()),
})

export const agentIdSchema = z.enum([
  'art-director',
  'business-analyst',
  'audience-profiler',
  'channel-strategist',
  'copywriter',
])
export type AgentIdInput = z.infer<typeof agentIdSchema>

export const analyzeRequestSchema = z.object({
  objectIds: z.array(z.string()).min(1).max(50),
  agentId: agentIdSchema.default('art-director'),
  force: z.boolean().optional(),
  depth: z.enum(['fast', 'deep']).optional(),
})
export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>

// Response payload is a discriminated union by agentId. Each agent's
// `data` validates against its own schema.
export const analyzeResponseSchema = z.object({
  agentId: agentIdSchema,
  data: z.unknown(),
  cached: z.boolean(),
  groupKey: z.string(),
})
export type AnalyzeResponse = z.infer<typeof analyzeResponseSchema>

// Synthesise multiple agent outputs into a single unified read.
export const synthesizeRequestSchema = z.object({
  objectIds: z.array(z.string()).min(1).max(50),
  agentIds: z.array(agentIdSchema).min(2).max(5),
  force: z.boolean().optional(),
  depth: z.enum(['fast', 'deep']).optional(),
})
export type SynthesizeRequest = z.infer<typeof synthesizeRequestSchema>

export const synthesizeResponseSchema = z.object({
  agentIds: z.array(agentIdSchema),
  data: synthesisBriefSchema,
  cached: z.boolean(),
  groupKey: z.string(),
})
export type SynthesizeResponse = z.infer<typeof synthesizeResponseSchema>

export const groupSchema = z.object({
  id: z.string(),
  objectIds: z.array(z.string()),
  boundingBox: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }),
  analysis: aiAnalysisSchema.optional(),
  analysisHash: z.string().optional(),
})

export const boardSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  name: z.string(),
  objects: z.array(canvasObjectSchema),
  groups: z.array(groupSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  time: z.string(),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>

export const uploadResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  url: z.string(),
  size: z.number(),
  mimeType: z.string(),
  // PDF-specific (omitted on image uploads)
  thumbnailUrl: z.string().optional(),
  extractedText: z.string().optional(),
  pageCount: z.number().optional(),
  // Font-specific. Server derives from the original filename so the client
  // doesn't have to parse the font binary.
  fontFamily: z.string().optional(),
})

export type UploadResponse = z.infer<typeof uploadResponseSchema>

// Lightweight projection of a single canvas object — enough for a dashboard
// thumbnail (position, size, type, and visual hint like a sticky colour or
// image thumbnail URL) without shipping the full ImageData / TextData
// payloads. Text content is intentionally omitted to avoid leaking
// user-written content into the dashboard.
export const boardPreviewObjectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  type: z.enum(['image', 'sticky', 'text', 'pdf', 'font']),
  color: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  // For font specimens — family + url so the dashboard can register the
  // FontFace and render the "Aa" badge in the actual uploaded typeface.
  family: z.string().optional(),
  url: z.string().optional(),
})
export type BoardPreviewObject = z.infer<typeof boardPreviewObjectSchema>

// What the dashboard renders as a board's thumbnail. `bounds` is `null`
// for empty boards (no objects yet) — the renderer falls back to the
// placeholder swatch in that case. `objects` is capped server-side to
// the largest N by area so a 200-image board doesn't dump 200 SVG
// elements per card.
export const boardPreviewSchema = z.object({
  bounds: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  objects: z.array(boardPreviewObjectSchema),
})
export type BoardPreview = z.infer<typeof boardPreviewSchema>

export const boardSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  preview: boardPreviewSchema.optional(),
})
export type BoardSummary = z.infer<typeof boardSummarySchema>

export const boardSummariesResponseSchema = z.object({
  boards: z.array(boardSummarySchema),
})
export type BoardSummariesResponse = z.infer<typeof boardSummariesResponseSchema>

// `data` is the canvas state blob; opaque to the API, parsed by the frontend.
export const fullBoardSchema = z.object({
  id: z.string(),
  name: z.string(),
  data: z.unknown(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type FullBoard = z.infer<typeof fullBoardSchema>

export const boardResponseSchema = z.object({ board: fullBoardSchema })
export type BoardResponse = z.infer<typeof boardResponseSchema>

export const createBoardRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
})
export type CreateBoardRequest = z.infer<typeof createBoardRequestSchema>

export const updateBoardRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  data: z.unknown().optional(),
})
export type UpdateBoardRequest = z.infer<typeof updateBoardRequestSchema>
