import { z } from 'zod'

export const imageDataSchema = z.object({
  url: z.string().url(),
  thumbnailUrl: z.string().url().optional(),
})

export const stickyDataSchema = z.object({
  text: z.string(),
  color: z.string(),
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
})

export const canvasObjectSchema = z.object({
  id: z.string(),
  type: z.enum(['image', 'sticky', 'text', 'pdf']),
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ width: z.number(), height: z.number() }),
  rotation: z.number(),
  zIndex: z.number(),
  data: z.union([imageDataSchema, stickyDataSchema, textDataSchema, pdfDataSchema]),
})

export const aiAnalysisSchema = z.object({
  mood: z.string(),
  tone: z.string(),
  palette: z.array(z.string()),
  adjectives: z.array(z.string()),
  themes: z.array(z.string()),
  summary: z.string(),
})

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
})

export type UploadResponse = z.infer<typeof uploadResponseSchema>

export const boardSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
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
