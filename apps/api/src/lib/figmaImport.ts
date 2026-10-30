import {
  figmaNodeUrl,
  figmaRenderScale,
  isFigmaNodeId,
  type FigmaFileTree,
  type FigmaFrameData,
  type FigmaFrameSummary,
  type FigmaRef,
} from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, schema } from '../db'
import { recordAsset } from './assetLibrary'
import {
  downloadRender,
  FigmaApiError,
  type FigmaApi,
  type FigmaNode,
  type FetchLike,
} from './figma'
import { structureText, summariseFigmaNode } from './figmaStructure'
import { saveUpload } from './storage'
import { resolveAndCheckHost } from './upload-validation'

// Figma frames in and out of the asset library: browse a file's frames,
// render the ones picked to PNG, save each as a library asset and describe it
// as a card that remembers where it came from. Read-only against Figma.

// A frame link, or a file link with the frames picked from it.
export class FigmaImportError extends Error {
  constructor(
    public code: 'BAD_LINK' | 'NO_FRAME' | 'NOT_RENDERABLE' | 'NOT_FOUND' | 'RENDER_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'FigmaImportError'
  }
}

// Node kinds that can be rendered as a standalone picture. A page (CANVAS)
// or the document itself is not "a frame".
const RENDERABLE_TYPES = new Set([
  'FRAME',
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
  'SECTION',
  'GROUP',
  'RECTANGLE',
  'TEXT',
  'VECTOR',
  'ELLIPSE',
  'BOOLEAN_OPERATION',
  'LINE',
  'STAR',
  'POLYGON',
  'SLICE',
  'SHAPE_WITH_TEXT',
  'STICKY',
  'CONNECTOR',
])
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION'])
const STRUCTURE_DEPTH = 8
const TREE_DEPTH = 3
const FRAMES_PER_PAGE = 200

// ---------------------------------------------------------------------------
// Browsing a file
// ---------------------------------------------------------------------------

function frameSummary(n: FigmaNode, prefix = ''): FigmaFrameSummary {
  return {
    id: n.id,
    name: `${prefix}${n.name ?? 'Untitled'}`,
    type: n.type ?? 'FRAME',
    width: Math.round(n.absoluteBoundingBox?.width ?? 0),
    height: Math.round(n.absoluteBoundingBox?.height ?? 0),
  }
}

/** A file's pages and the frames on them (frames inside sections are listed as "Section / Frame"). */
export async function readFileTree(api: FigmaApi, ref: FigmaRef): Promise<FigmaFileTree> {
  const file = await api.file(ref.fileKey, { depth: TREE_DEPTH })
  const pages = (file.document.children ?? [])
    .filter((p) => p.type === 'CANVAS')
    .map((page) => {
      const frames: FigmaFrameSummary[] = []
      for (const n of page.children ?? []) {
        if (n.visible === false) continue
        if (n.type === 'SECTION') {
          const inner = (n.children ?? []).filter(
            (c) => c.visible !== false && FRAME_TYPES.has(c.type ?? ''),
          )
          if (inner.length === 0) frames.push(frameSummary(n))
          for (const c of inner) frames.push(frameSummary(c, `${n.name ?? 'Section'} / `))
        } else if (FRAME_TYPES.has(n.type ?? '')) {
          frames.push(frameSummary(n))
        }
      }
      return { id: page.id, name: page.name ?? 'Page', frames: frames.slice(0, FRAMES_PER_PAGE) }
    })
  return { fileKey: ref.fileKey, name: file.name, lastModified: file.lastModified, pages }
}

// ---------------------------------------------------------------------------
// Rendering frames
// ---------------------------------------------------------------------------

// A PNG's width and height, from its IHDR chunk.
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function tagFor(fileName: string): string | null {
  const tag = fileName
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return tag.length > 0 ? tag : null
}

type RenderDeps = {
  fetchImpl?: FetchLike
}

async function renderNode(
  api: FigmaApi,
  args: {
    userId: string
    clientId: string | null
    fileKey: string
    fileName: string
    lastModified: string
    node: FigmaNode
  },
  deps: RenderDeps,
): Promise<FigmaFrameData> {
  const { node, fileKey, fileName } = args
  const box = node.absoluteBoundingBox
  const scale = figmaRenderScale(box?.width ?? 1024, box?.height ?? 768)
  const images = await api.images(fileKey, [node.id], { scale })
  const link = images[node.id]
  if (!link) {
    throw new FigmaImportError(
      'RENDER_FAILED',
      `Figma couldn’t render “${node.name ?? node.id}” — it may be empty or too large.`,
    )
  }
  const bytes = await downloadRender(link, {
    fetchImpl: deps.fetchImpl,
    checkHost: resolveAndCheckHost,
  })
  const png = pngSize(bytes)
  const width = Math.round(box?.width ?? (png ? png.width / scale : 1024))
  const height = Math.round(box?.height ?? (png ? png.height / scale : 768))

  const saved = await saveUpload(bytes, nanoid(), 'png', 'image/png')
  const tags = ['figma', tagFor(fileName)].filter((t): t is string => t !== null)
  await recordAsset(args.userId, saved.filename, saved.mimeType, saved.size, 'upload', {
    originalName: `${fileName} — ${node.name ?? node.id}`,
    clientId: args.clientId,
    tags,
  })

  return {
    url: `/api/files/${saved.filename}`,
    fileKey,
    nodeId: node.id,
    name: node.name ?? 'Untitled',
    fileName,
    figmaUrl: figmaNodeUrl(fileKey, node.id, fileName),
    width: Math.max(1, width),
    height: Math.max(1, height),
    lastModified: args.lastModified,
    fetchedAt: new Date().toISOString(),
    structure: structureText(summariseFigmaNode(node)),
  }
}

/**
 * Import frames: fetch their metadata and structure, render each to PNG, save
 * the PNGs to the asset library and return the card data. One failed frame
 * fails the call with the reason — a partial import would be a silent gap.
 */
export async function importFigmaFrames(
  api: FigmaApi,
  args: {
    userId: string
    clientId?: string | null
    fileKey: string
    nodeIds: string[]
  },
  deps: RenderDeps = {},
): Promise<FigmaFrameData[]> {
  if (args.nodeIds.length === 0) {
    throw new FigmaImportError('NO_FRAME', 'Pick at least one frame to import.')
  }
  const bad = args.nodeIds.find((id) => !isFigmaNodeId(id))
  if (bad) throw new FigmaImportError('BAD_LINK', `“${bad}” isn’t a Figma node id.`)

  let nodes
  try {
    nodes = await api.nodes(args.fileKey, args.nodeIds, { depth: STRUCTURE_DEPTH })
  } catch (e) {
    if (e instanceof FigmaApiError && e.status === 400) {
      throw new FigmaImportError('BAD_LINK', 'Figma didn’t recognise that frame id.')
    }
    throw e
  }

  const frames: FigmaFrameData[] = []
  for (const id of args.nodeIds) {
    const entry = nodes.nodes[id]
    if (!entry) {
      throw new FigmaImportError(
        'NOT_FOUND',
        `Frame ${id} isn’t in that file (it may have been deleted).`,
      )
    }
    const type = entry.document.type ?? ''
    if (!RENDERABLE_TYPES.has(type)) {
      throw new FigmaImportError(
        'NOT_RENDERABLE',
        type === 'CANVAS'
          ? 'That link points at a whole page. Pick a frame on it, or paste the file link to browse its frames.'
          : `A ${type.toLowerCase() || 'this kind of'} node can’t be rendered as a picture.`,
      )
    }
    frames.push(
      await renderNode(
        api,
        {
          userId: args.userId,
          clientId: args.clientId ?? null,
          fileKey: args.fileKey,
          fileName: nodes.name,
          lastModified: nodes.lastModified,
          node: entry.document,
        },
        deps,
      ),
    )
  }
  return frames
}

// The client a card's earlier render was filed under, so a refresh keeps it.
async function clientOfRender(url: string): Promise<string | null> {
  const filename = url.split('/').pop() ?? ''
  const [row] = await db
    .select({ clientId: schema.asset.clientId })
    .from(schema.asset)
    .where(eq(schema.asset.filename, filename))
    .limit(1)
  return row?.clientId ?? null
}

/**
 * Re-render a card's frame when the file has changed since (or when forced).
 * The old render stays in the library; the card points at the new one.
 */
export async function refreshFigmaFrame(
  api: FigmaApi,
  args: { userId: string; data: FigmaFrameData; force?: boolean },
  deps: RenderDeps = {},
): Promise<{ data: FigmaFrameData; changed: boolean }> {
  const { data } = args
  const nodes = await api.nodes(data.fileKey, [data.nodeId], { depth: STRUCTURE_DEPTH })
  const entry = nodes.nodes[data.nodeId]
  if (!entry) {
    throw new FigmaImportError('NOT_FOUND', 'That frame is gone from the Figma file.')
  }
  if (!args.force && nodes.lastModified === data.lastModified) {
    return { data, changed: false }
  }
  const fresh = await renderNode(
    api,
    {
      userId: args.userId,
      clientId: await clientOfRender(data.url),
      fileKey: data.fileKey,
      fileName: nodes.name,
      lastModified: nodes.lastModified,
      node: entry.document,
    },
    deps,
  )
  return { data: { ...fresh, pageName: data.pageName }, changed: true }
}

// ---------------------------------------------------------------------------
// Picking the frame to import from a link
// ---------------------------------------------------------------------------

/** The node ids a link names: its own node, or `picked` from a file link. */
export function nodeIdsFor(ref: FigmaRef, picked?: string[]): string[] {
  if (picked && picked.length > 0) return [...new Set(picked)]
  return ref.nodeId ? [ref.nodeId] : []
}

/** The words for a file link with no frame in it: what to pick from. */
export function describeFrames(tree: FigmaFileTree, max = 12): string {
  const lines: string[] = []
  for (const page of tree.pages) {
    for (const f of page.frames) {
      if (lines.length >= max) break
      lines.push(
        `- ${page.name} / ${f.name}${f.width > 0 ? ` (${f.width}×${f.height})` : ''} — ${figmaNodeUrl(tree.fileKey, f.id, tree.name)}`,
      )
    }
  }
  const total = tree.pages.reduce((n, p) => n + p.frames.length, 0)
  if (lines.length === 0) return `“${tree.name}” has no frames.`
  return `“${tree.name}” has ${total} frame${total === 1 ? '' : 's'}:\n${lines.join('\n')}${total > lines.length ? `\n… and ${total - lines.length} more` : ''}`
}
