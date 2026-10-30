import { z } from 'zod'
import { outputFormatSchema } from './outputs'

// Phase 24 — output agents. One "design run" is the designer agent asked for
// a format + brief: 1–3 variants, each a real output it built, rendered and
// critiqued. The person picks one; only then can it be posted back to the
// Linear issue the brief came from.

export const DESIGN_VARIANTS_MAX = 3
export const DESIGN_BRIEF_MAX = 4000

export const designStageSchema = z.enum([
  'queued',
  'outline',
  'template',
  'assets',
  'filling',
  'rendering',
  'critique',
  'revising',
  'done',
  'cached',
  'failed',
])
export type DesignStage = z.infer<typeof designStageSchema>

// Streamed while a run works (AgentStreamEvent `tool-progress`). Not stored:
// the finished variants are the tool result.
export const designProgressSchema = z.object({
  variant: z.number().int().min(1),
  of: z.number().int().min(1),
  stage: designStageSchema,
  detail: z.string().optional(),
  outputId: z.string().optional(),
  version: z.number().int().optional(),
})
export type DesignProgress = z.infer<typeof designProgressSchema>

export const designVariantSchema = z.object({
  // 1-based, in the order the variants were asked for.
  index: z.number().int().min(1),
  status: z.enum(['done', 'failed']),
  // Reused from an identical earlier run instead of re-running the model.
  cached: z.boolean(),
  outputId: z.string().nullable(),
  version: z.number().int().nullable(),
  name: z.string(),
  template: z.string().nullable(),
  angle: z.string(),
  // The designer's last word on its own render.
  critique: z.string(),
  renders: z.number().int(),
  steps: z.number().int(),
  error: z.string().nullable(),
})
export type DesignVariant = z.infer<typeof designVariantSchema>

export const designRunSchema = z.object({
  id: z.string(),
  boardId: z.string().nullable(),
  format: outputFormatSchema,
  brief: z.string(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  kitId: z.string().nullable(),
  kitName: z.string().nullable(),
  kitVersion: z.number().int().nullable(),
  variants: z.array(designVariantSchema),
  chosenOutputId: z.string().nullable(),
  // The Linear issue (identifier, e.g. LIN-123) the brief came from.
  linearIssue: z.string().nullable(),
  linearCommentUrl: z.string().nullable(),
  postedAt: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
})
export type DesignRun = z.infer<typeof designRunSchema>

export const designRunResponseSchema = z.object({ run: designRunSchema })

export const chooseDesignVariantRequestSchema = z.object({ outputId: z.string().min(1) })

// Posts the chosen variant (or `outputId`, which must be the chosen one).
export const postDesignToLinearRequestSchema = z.object({
  outputId: z.string().min(1).optional(),
})

export const postDesignToLinearResponseSchema = z.object({
  run: designRunSchema.nullable(),
  commentUrl: z.string(),
  shareUrl: z.string(),
  imageAttached: z.boolean(),
})

export function outputThumbnailPath(outputId: string, version?: number): string {
  return `/api/outputs/${outputId}/thumbnail${version ? `?version=${version}` : ''}`
}
