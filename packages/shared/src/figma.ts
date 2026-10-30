import { z } from 'zod'
import { aabbIntersect, type Rect } from './aabb'
import { figmaFrameDataSchema } from './schemas'

// Phase 26 — Figma import. Read-only: frames come in as image cards that
// remember where they came from, and a file's styles map to kit tokens. HTML
// stays the output; nothing is ever written back to Figma.
//
// This file is the pure side: URL recognition, sizing, and wire shapes. The
// REST client is apps/api/src/lib/figma.ts; the styles → kit mapping is in
// figmaKit.ts.

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export const FIGMA_URL_KINDS = ['design', 'file', 'proto', 'board', 'slides', 'make'] as const
export type FigmaUrlKind = (typeof FIGMA_URL_KINDS)[number]

export type FigmaRef = {
  // The file to read. For a branch link this is the branch's own key, which
  // is what the REST API wants.
  fileKey: string
  // "12:34", or null for a link to the whole file.
  nodeId: string | null
  kind: FigmaUrlKind
  // The slug in the link, de-hyphenated — a label until the API gives the real name.
  fileName: string | null
}

const FIGMA_HOST_RE = /^(?:www\.|embed\.)?figma\.com$/i
const FILE_KEY_RE = /^[A-Za-z0-9]{8,64}$/

function parseUrl(s: string): URL | null {
  try {
    return new URL(s.trim())
  } catch {
    return null
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// URLs write "12:34" as "12-34"; instance ids ("I12:34;5:6") the same way.
export function normaliseFigmaNodeId(raw: string): string | null {
  const id = safeDecode(raw).trim().replace(/-/g, ':')
  if (!/^[A-Za-z0-9:;_]+$/.test(id) || !id.includes(':') || !/\d/.test(id)) return null
  return id
}

export function isFigmaNodeId(id: string): boolean {
  return /^[A-Za-z0-9:;_]+$/.test(id) && id.includes(':') && /\d/.test(id) && id.length <= 120
}

/**
 * Recognise a Figma file or frame link: `/design/…`, the older `/file/…`,
 * `/proto/…`, FigJam `/board/…`, `/slides/…`, `/make/…`, branch links and the
 * `/embed?url=…` wrapper. Returns null for anything else.
 */
export function parseFigmaUrl(input: string, depth = 0): FigmaRef | null {
  const url = parseUrl(input)
  if (!url) return null
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!FIGMA_HOST_RE.test(url.hostname)) return null

  if (url.pathname.replace(/\/+$/, '') === '/embed') {
    const inner = url.searchParams.get('url')
    return inner && depth === 0 ? parseFigmaUrl(inner, 1) : null
  }

  const segments = url.pathname.split('/').filter(Boolean).map(safeDecode)
  const kind = segments[0] as FigmaUrlKind | undefined
  if (!kind || !FIGMA_URL_KINDS.includes(kind)) return null

  let fileKey = segments[1]
  let slug = segments[2]
  if (segments[2] === 'branch' && segments[3]) {
    fileKey = segments[3]
    slug = segments[4]
  }
  if (!fileKey || !FILE_KEY_RE.test(fileKey)) return null

  const nodeParam = url.searchParams.get('node-id')
  return {
    fileKey,
    nodeId: nodeParam ? normaliseFigmaNodeId(nodeParam) : null,
    kind,
    fileName: slug ? slug.replace(/-+/g, ' ').trim() || null : null,
  }
}

/** A link a person can open: `https://www.figma.com/design/<key>/<slug>?node-id=12-34`. */
export function figmaNodeUrl(fileKey: string, nodeId: string | null, fileName?: string): string {
  const slug =
    (fileName ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'file'
  const base = `https://www.figma.com/design/${fileKey}/${slug}`
  return nodeId ? `${base}?node-id=${nodeId.replace(/:/g, '-')}` : base
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

// A render is capped on its long edge (Figma itself downscales anything past
// ~32 megapixels), and a board card is fitted into a box.
export const FIGMA_RENDER_MAX_EDGE = 2048
export const FIGMA_RENDER_MAX_SCALE = 2
export const FIGMA_CARD_MAX_EDGE = 420
export const FIGMA_CARD_MIN_EDGE = 120
// The strip under the picture with the frame's name and its Figma chip.
export const FIGMA_CARD_FOOTER_PX = 34
// Frames per import (a file link's picker selection, or one tool call).
export const FIGMA_IMPORT_MAX_FRAMES = 8

/** The `scale` to ask Figma's images API for so the PNG's long edge stays within the cap. */
export function figmaRenderScale(width: number, height: number): number {
  const longest = Math.max(width, height)
  if (!(longest > 0)) return 1
  const scale = Math.min(FIGMA_RENDER_MAX_SCALE, FIGMA_RENDER_MAX_EDGE / longest)
  return Math.max(0.01, Math.round(scale * 100) / 100)
}

/** The size of a board card for a frame: the picture keeps its aspect, its long edge fitted to the card box, plus the footer. */
export function figmaCardSize(width: number, height: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 320, height: 240 + FIGMA_CARD_FOOTER_PX }
  const fit = FIGMA_CARD_MAX_EDGE / Math.max(width, height)
  const w = Math.max(FIGMA_CARD_MIN_EDGE, Math.round(width * fit))
  const h = Math.max(FIGMA_CARD_MIN_EDGE, Math.round(height * fit))
  return { width: w, height: h + FIGMA_CARD_FOOTER_PX }
}

// Frames imported together sit side by side, with a gap well past the 48px
// grouping proximity so a handful from one file don't fuse into a group on
// their own; a row keeps CLEARANCE from anything already on the board.
export const FIGMA_ROW_GAP = 96
export const FIGMA_ROW_CLEARANCE = 80

/**
 * Where to put a row of new cards: centred on `center`, or — when that spot is
 * taken — to the right of everything on the board. Returns each card's
 * top-left corner.
 */
export function layoutFigmaRow(
  sizes: { width: number; height: number }[],
  center: { x: number; y: number },
  existing: Rect[],
): { positions: { x: number; y: number }[]; moved: boolean } {
  if (sizes.length === 0) return { positions: [], moved: false }
  const total = sizes.reduce((w, s) => w + s.width, 0) + FIGMA_ROW_GAP * (sizes.length - 1)
  const height = Math.max(...sizes.map((s) => s.height))
  const row: Rect = {
    left: center.x - total / 2,
    top: center.y - height / 2,
    right: center.x + total / 2,
    bottom: center.y + height / 2,
  }
  const padded: Rect = {
    left: row.left - FIGMA_ROW_CLEARANCE,
    top: row.top - FIGMA_ROW_CLEARANCE,
    right: row.right + FIGMA_ROW_CLEARANCE,
    bottom: row.bottom + FIGMA_ROW_CLEARANCE,
  }
  const moved = existing.some((r) => aabbIntersect(padded, r))
  const shift = moved
    ? Math.max(...existing.map((r) => r.right)) + FIGMA_ROW_CLEARANCE * 1.5 - row.left
    : 0
  let x = row.left + shift
  const positions = sizes.map((s) => {
    const at = { x, y: center.y - s.height / 2 }
    x += s.width + FIGMA_ROW_GAP
    return at
  })
  return { positions, moved }
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export const figmaStatusSchema = z.object({
  // False when the server has no FIGMA_CLIENT_ID/SECRET/REDIRECT_URI.
  configured: z.boolean(),
  connection: z
    .object({ id: z.string(), accountEmail: z.string(), handle: z.string().nullable() })
    .nullable(),
})
export type FigmaStatus = z.infer<typeof figmaStatusSchema>

export const figmaFrameSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  width: z.number(),
  height: z.number(),
})
export type FigmaFrameSummary = z.infer<typeof figmaFrameSummarySchema>

export const figmaPageSchema = z.object({
  id: z.string(),
  name: z.string(),
  frames: z.array(figmaFrameSummarySchema),
})
export type FigmaPage = z.infer<typeof figmaPageSchema>

// A file's pages and their top-level frames: what the picker browses.
export const figmaFileTreeSchema = z.object({
  fileKey: z.string(),
  name: z.string(),
  lastModified: z.string(),
  pages: z.array(figmaPageSchema),
})
export type FigmaFileTree = z.infer<typeof figmaFileTreeSchema>
export const figmaFileResponseSchema = z.object({ file: figmaFileTreeSchema })

export const figmaImportRequestSchema = z.object({
  url: z.string().min(1).max(2000),
  // Frames to import from a file link (the picker's selection). A frame link
  // imports its own node.
  nodeIds: z.array(z.string().min(1).max(120)).max(FIGMA_IMPORT_MAX_FRAMES).optional(),
  // The board the frames are for: its client files the renders in the library.
  boardId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
})
export type FigmaImportRequest = z.infer<typeof figmaImportRequestSchema>

export const figmaImportResponseSchema = z.object({
  frames: z.array(figmaFrameDataSchema),
})
export type FigmaImportResponse = z.infer<typeof figmaImportResponseSchema>

export const figmaRefreshRequestSchema = z.object({
  boardId: z.string().min(1),
  objectId: z.string().min(1),
  // Render again even when the file hasn't changed since the last import.
  force: z.boolean().optional(),
})
export type FigmaRefreshRequest = z.infer<typeof figmaRefreshRequestSchema>

export const figmaRefreshResponseSchema = z.object({
  data: figmaFrameDataSchema,
  // False when the file hasn't changed since the card was made.
  changed: z.boolean(),
})
export type FigmaRefreshResponse = z.infer<typeof figmaRefreshResponseSchema>
