import { matchNamed, parseFigmaUrl, type FigmaRef } from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import { db, schema } from '../db'
import {
  boardFigmaFrames,
  placeFigmaFrame,
  updateFigmaFrameOnBoard,
  type BoardFigmaFrame,
} from './figmaBoard'
import type { ToolContext, ToolImage, ToolOutcome } from './canvasTools'
import { listClients } from './clients'
import { FigmaApiError } from './figma'
import { figmaForUser, FigmaUnavailableError } from './figmaConnection'
import {
  describeFrames,
  FigmaImportError,
  importFigmaFrames,
  nodeIdsFor,
  readFileTree,
  refreshFigmaFrame,
} from './figmaImport'
import { figmaKitFromFile } from './figmaKitImport'
import { listKits } from './kits'
import { pngForModel } from './modelImage'
import { isSafeFilename, uploadPath } from './storage'

// Bodies of import_figma_frame, get_figma_frame and figma_kit_from_file.
// Registered in canvasTools.ts (CANVAS_TOOLS) so the MCP server and the
// sidebar get them together; the designer and video agents read board frames
// through resolveFigmaReferences / loadReferenceImage below.

type Fail = Extract<ToolOutcome, { ok: false }>
const fail = (error: string): Fail => ({ ok: false, error })

// What a design agent is given about a frame: enough to find and describe it;
// the picture and structure are read on demand.
export type FigmaReference = {
  objectId: string
  name: string
  fileName: string
  fileKey: string
  nodeId: string
  figmaUrl: string
  width: number
  height: number
  url: string
  lastModified: string
  structure: string | null
}

// Part of an agent cache key: the frame and the version of the file it was rendered from.
export function figmaReferenceKey(ref: FigmaReference): string {
  return `${ref.fileKey}:${ref.nodeId}@${ref.lastModified}`
}

export function toReference(frame: BoardFigmaFrame): FigmaReference {
  const d = frame.data
  return {
    objectId: frame.object.id,
    name: d.name,
    fileName: d.fileName,
    fileKey: d.fileKey,
    nodeId: d.nodeId,
    figmaUrl: d.figmaUrl,
    width: d.width,
    height: d.height,
    url: d.url,
    lastModified: d.lastModified,
    structure: d.structure ?? null,
  }
}

function listFrames(frames: BoardFigmaFrame[]): string {
  return frames.length > 0
    ? frames.map((f) => `“${f.data.name}” (${f.data.fileName})`).join(', ')
    : 'none yet — import one with import_figma_frame'
}

/** Board frames named by id, name or Figma link; a failure is the question to put to the person. */
export async function resolveFigmaReferences(
  boardId: string,
  queries: string[],
): Promise<{ ok: true; frames: FigmaReference[] } | Fail> {
  const frames = await boardFigmaFrames(boardId)
  const found: BoardFigmaFrame[] = []
  for (const query of queries) {
    const ref = parseFigmaUrl(query)
    let hit: BoardFigmaFrame | undefined
    if (ref) {
      hit = frames.find(
        (f) =>
          f.data.fileKey === ref.fileKey && (ref.nodeId === null || f.data.nodeId === ref.nodeId),
      )
    } else {
      const items = frames.map((f) => ({ id: f.object.id, name: f.data.name, frame: f }))
      const m = matchNamed(items, query)
      if (m.kind === 'ambiguous') {
        return fail(
          `“${query}” matches more than one Figma frame on the board: ${m.candidates.map((c) => c.name).join(', ')}. Use the exact name.`,
        )
      }
      hit = m.kind === 'found' ? m.item.frame : undefined
    }
    if (!hit) {
      return fail(
        `No Figma frame on this board matches “${query}”. Frames on the board: ${listFrames(frames)}.`,
      )
    }
    if (!found.includes(hit)) found.push(hit)
  }
  return { ok: true, frames: found.map(toReference) }
}

/** The frame's stored render, sized for a vision call. */
export async function loadReferenceImage(
  ref: Pick<FigmaReference, 'url'>,
): Promise<{ png: Buffer; width: number; height: number } | null> {
  const filename = ref.url.split('/').pop() ?? ''
  if (!isSafeFilename(filename)) return null
  try {
    return await pngForModel(await readFile(uploadPath(filename)))
  } catch {
    return null
  }
}

export function referenceText(ref: FigmaReference): string {
  return JSON.stringify({
    frame: ref.name,
    file: ref.fileName,
    size: `${ref.width}×${ref.height}`,
    figma: ref.figmaUrl,
    lastModified: ref.lastModified,
    structure:
      ref.structure ?? '(no structure stored for this frame — refresh the card to read its layers)',
  })
}

async function boardClientId(boardId: string): Promise<string | null> {
  const [row] = await db
    .select({ clientId: schema.board.clientId })
    .from(schema.board)
    .where(eq(schema.board.id, boardId))
    .limit(1)
  return row?.clientId ?? null
}

// Figma problems the model can act on become tool errors; anything else is a bug.
function figmaFailure(e: unknown): Fail {
  if (e instanceof FigmaUnavailableError) return fail(e.message)
  if (e instanceof FigmaImportError) return fail(e.message)
  if (e instanceof FigmaApiError) return fail(e.message)
  throw e
}

function linkRef(url: string): FigmaRef | Fail {
  const ref = parseFigmaUrl(url)
  if (!ref) return fail('That isn’t a Figma file or frame link.')
  if (ref.kind === 'make') {
    return fail('Figma Make files can’t be imported — use a Design or FigJam link.')
  }
  return ref
}

export async function importFigmaFrameTool(
  ctx: ToolContext,
  input: { url: string; frame?: string; client?: string },
): Promise<ToolOutcome> {
  const ref = linkRef(input.url)
  if ('ok' in ref) return ref

  let clientId = await boardClientId(ctx.boardId)
  if (input.client) {
    const m = matchNamed(await listClients(), input.client)
    if (m.kind !== 'found') return fail(`No client matches “${input.client}”.`)
    clientId = m.item.id
  }

  try {
    const api = await figmaForUser(ctx.userId)
    let nodeIds = nodeIdsFor(ref)
    if (nodeIds.length === 0) {
      // A file link: take the frame asked for, the only frame, or say what to pick from.
      const tree = await readFileTree(api, ref)
      const all = tree.pages.flatMap((p) => p.frames)
      if (input.frame) {
        const m = matchNamed(all, input.frame)
        if (m.kind === 'ambiguous') {
          return fail(
            `“${input.frame}” matches more than one frame: ${m.candidates.map((c) => c.name).join(', ')}. Use the exact name or a frame link.`,
          )
        }
        if (m.kind === 'none')
          return fail(`No frame matches “${input.frame}”.\n${describeFrames(tree)}`)
        nodeIds = [m.item.id]
      } else if (all.length === 1) {
        nodeIds = [all[0]!.id]
      } else {
        return fail(
          `That link is a whole file. Pass a frame link (or frame: its name).\n${describeFrames(tree)}`,
        )
      }
    }

    const onBoard = (await boardFigmaFrames(ctx.boardId)).find(
      (f) => f.data.fileKey === ref.fileKey && f.data.nodeId === nodeIds[0],
    )
    if (onBoard) {
      const refreshed = await refreshFigmaFrame(api, { userId: ctx.userId, data: onBoard.data })
      if (!refreshed.changed) {
        return {
          ok: true,
          payload: {
            summary: `“${onBoard.data.name}” is already on the board and up to date`,
            objectIds: [onBoard.object.id],
            alreadyOnBoard: true,
            changed: false,
          },
        }
      }
      const written = await updateFigmaFrameOnBoard({
        boardId: ctx.boardId,
        userId: ctx.userId,
        frame: onBoard,
        data: refreshed.data,
      })
      if (!written) {
        return fail('Someone edited that card meanwhile; their version was kept. Try again.')
      }
      return {
        ok: true,
        payload: {
          summary: `Refreshed “${refreshed.data.name}” from Figma`,
          objectIds: [onBoard.object.id],
          alreadyOnBoard: true,
          changed: true,
        },
        effects: { objects: [written] },
      }
    }

    const [data] = await importFigmaFrames(api, {
      userId: ctx.userId,
      clientId,
      fileKey: ref.fileKey,
      nodeIds: nodeIds.slice(0, 1),
    })
    const added = await placeFigmaFrame({ boardId: ctx.boardId, userId: ctx.userId, data: data! })
    return {
      ok: true,
      payload: {
        summary: `Imported “${data!.name}” from “${data!.fileName}”`,
        objectIds: [added.object.id],
        frame: {
          name: data!.name,
          file: data!.fileName,
          size: `${data!.width}×${data!.height}`,
          figmaUrl: data!.figmaUrl,
          imageUrl: data!.url,
        },
        note: 'The frame is in the asset library and on the board. Pass its name as figmaFrames to design_output / design_video to design from it.',
      },
      effects: { objects: [added] },
    }
  } catch (e) {
    return figmaFailure(e)
  }
}

export async function getFigmaFrameTool(
  ctx: ToolContext,
  input: { frame: string },
): Promise<ToolOutcome> {
  const resolved = await resolveFigmaReferences(ctx.boardId, [input.frame])
  if (!resolved.ok) return resolved
  const ref = resolved.frames[0]!
  const image = await loadReferenceImage(ref)
  const images: ToolImage[] = image ? [{ mediaType: 'image/png', data: image.png }] : []
  return {
    ok: true,
    payload: {
      summary: `Read Figma frame “${ref.name}”`,
      objectIds: [ref.objectId],
      frame: ref.name,
      file: ref.fileName,
      size: `${ref.width}×${ref.height}`,
      figmaUrl: ref.figmaUrl,
      lastModified: ref.lastModified,
      imageUrl: ref.url,
      structure:
        ref.structure ??
        '(no structure stored for this frame — refresh the card to read its layers)',
      note: image
        ? 'The frame’s picture is attached to this result for this turn only.'
        : 'The frame’s picture could not be read from the library.',
    },
    ...(images.length > 0 ? { images } : {}),
  }
}

export async function figmaKitFromFileTool(
  ctx: ToolContext,
  input: { url: string; client?: string; kit?: string; name?: string; dryRun?: boolean },
): Promise<ToolOutcome> {
  const ref = linkRef(input.url)
  if ('ok' in ref) return ref

  let clientId: string | undefined
  let kitId: string | undefined
  if (input.client) {
    const m = matchNamed(await listClients(), input.client)
    if (m.kind !== 'found') return fail(`No client matches “${input.client}”.`)
    clientId = m.item.id
  } else {
    clientId = (await boardClientId(ctx.boardId)) ?? undefined
  }
  if (input.kit) {
    const kits = await listKits(clientId ? { clientId } : {})
    const m = matchNamed(kits, input.kit)
    if (m.kind !== 'found') return fail(`No kit matches “${input.kit}”.`)
    kitId = m.item.id
  }
  if (!input.dryRun && !kitId && !clientId) {
    return fail('Which client is this kit for? This board has none — pass client.')
  }

  try {
    const api = await figmaForUser(ctx.userId)
    const outcome = await figmaKitFromFile(api, {
      fileKey: ref.fileKey,
      userId: ctx.userId,
      clientId,
      kitId,
      name: input.name,
      preview: input.dryRun,
    })
    if (!outcome.ok) return fail(outcome.error)
    const r = outcome.result
    return {
      ok: true,
      payload: {
        summary: r.saved
          ? kitId
            ? `Updated “${r.kit?.name}” from Figma (v${r.version?.version})`
            : `Created kit “${r.kit?.name}” from Figma`
          : `Previewed a kit from “${r.fileName}” (nothing saved)`,
        saved: r.saved,
        kit: r.kit ? { id: r.kit.id, name: r.kit.name, client: r.kit.clientName } : null,
        version: r.version?.version ?? null,
        mapped: r.report.mapped.map((m) => `${m.label}: ${m.detail}`),
        skipped: r.report.skipped.map((s) => `${s.label} — ${s.reason}`),
        variables: r.report.variables,
        palette: r.tokens.palette.map((p) => ({ role: p.role, hex: p.hex })),
        fonts: {
          display: r.tokens.fonts.display?.family ?? null,
          body: r.tokens.fonts.body?.family ?? null,
          mono: r.tokens.fonts.mono?.family ?? null,
        },
      },
    }
  } catch (e) {
    return figmaFailure(e)
  }
}
