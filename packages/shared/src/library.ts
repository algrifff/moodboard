import { z } from 'zod'

// Phase 22 — the asset library. Every recorded upload/import is an asset
// with library metadata: what it is, its colours and size, an optional AI
// caption, tags and an optional client. Search is Postgres full-text over
// name + caption + tags.

export const ASSET_MEDIA_KINDS = ['image', 'pdf', 'font', 'audio', 'other'] as const
export const assetMediaKindSchema = z.enum(ASSET_MEDIA_KINDS)
export type AssetMediaKind = (typeof ASSET_MEDIA_KINDS)[number]

export function mediaKindFromMime(mimeType: string): AssetMediaKind {
  const mime = mimeType.split(';')[0]!.trim().toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('audio/')) return 'audio'
  if (
    mime.startsWith('font/') ||
    /^application\/(x-)?font/.test(mime) ||
    mime === 'application/vnd.ms-fontobject'
  )
    return 'font'
  return 'other'
}

export const libraryAssetSchema = z.object({
  id: z.string(),
  url: z.string(),
  // First-page render for PDFs, the file itself for images.
  thumbnailUrl: z.string().nullable(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  kind: assetMediaKindSchema,
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  colors: z.array(z.string()),
  caption: z.string().nullable(),
  tags: z.array(z.string()),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
})
export type LibraryAsset = z.infer<typeof libraryAssetSchema>

export const libraryResponseSchema = z.object({
  assets: z.array(libraryAssetSchema),
  nextOffset: z.number().int().nullable(),
})
export const libraryAssetResponseSchema = z.object({ asset: libraryAssetSchema })

export const LIBRARY_PAGE_SIZE = 40

// `client` is a client id, or 'none' for assets with no client.
export const libraryQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  client: z.string().min(1).optional(),
  kind: assetMediaKindSchema.optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(LIBRARY_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
})
export type LibraryQuery = z.infer<typeof libraryQuerySchema>

export const TAG_MAX = 40
export const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(TAG_MAX)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u, 'Letters, numbers, spaces, - and _ only')

export const updateAssetRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    caption: z.string().trim().max(500).nullable(),
    tags: z.array(tagSchema).max(30),
    clientId: z.string().min(1).nullable(),
  })
  .partial()
export type UpdateAssetRequest = z.infer<typeof updateAssetRequestSchema>

export const addAssetToBoardRequestSchema = z.object({
  boardId: z.string().min(1),
  // World point to centre the new object on (a drop). Omitted: the next free spot.
  position: z.object({ x: z.number(), y: z.number() }).optional(),
})
export type AddAssetToBoardRequest = z.infer<typeof addAssetToBoardRequestSchema>
