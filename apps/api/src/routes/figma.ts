import {
  figmaImportRequestSchema,
  figmaKitRequestSchema,
  figmaRefreshRequestSchema,
  figmaFrameDataSchema,
  parseFigmaUrl,
  type FigmaRef,
  type FigmaStatus,
} from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { loadBoardObject } from '../lib/boardObjects'
import { clientExists } from '../lib/clients'
import { FigmaApiError, figmaEnv } from '../lib/figma'
import { figmaForUser, FigmaUnavailableError, getFigmaConnection } from '../lib/figmaConnection'
import {
  FigmaImportError,
  importFigmaFrames,
  nodeIdsFor,
  readFileTree,
  refreshFigmaFrame,
} from '../lib/figmaImport'
import { figmaKitFromFile } from '../lib/figmaKitImport'
import { rateLimit } from '../lib/rateLimit'

type Variables = { user: AuthUser | null; session: AuthSession | null }

// Figma as a source: browse a file's frames, import frames as library
// images, refresh a card, and map a file's styles to a kit. Everything acts
// as the signed-in user's own Figma connection, read-only.
export const figma = new Hono<{ Variables: Variables }>()

figma.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

const figmaLimit = rateLimit({ scope: 'figma', limit: 30, windowMs: 60_000 })

// 409 for "set up / reconnect Figma first" (the UI shows a prompt, not an
// error); Figma's own failures keep their meaning where the person can act.
export function figmaErrorResponse(c: Context, e: unknown) {
  if (e instanceof FigmaUnavailableError) return c.json({ error: e.message, code: e.code }, 409)
  if (e instanceof FigmaImportError) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'RENDER_FAILED' ? 502 : 400
    return c.json({ error: e.message, code: e.code }, status)
  }
  if (e instanceof FigmaApiError) {
    console.warn('[figma] api error', e.status, e.message)
    const status = e.status === 404 ? 404 : e.status === 429 ? 429 : e.status === 403 ? 403 : 502
    return c.json({ error: e.message }, status)
  }
  throw e
}

function refFrom(c: Context, url: string): FigmaRef | Response {
  const ref = parseFigmaUrl(url)
  if (!ref) return c.json({ error: 'That isn’t a Figma file or frame link.' }, 400)
  if (ref.kind === 'make') {
    return c.json(
      { error: 'Figma Make files can’t be imported — paste a Design or FigJam link.' },
      400,
    )
  }
  return ref
}

async function boardClientId(boardId: string | undefined): Promise<string | null> {
  if (!boardId) return null
  const [row] = await db
    .select({ clientId: schema.board.clientId })
    .from(schema.board)
    .where(eq(schema.board.id, boardId))
    .limit(1)
  return row?.clientId ?? null
}

figma.get('/status', async (c) => {
  const row = await getFigmaConnection(c.get('user')!.id)
  const status: FigmaStatus = {
    configured: figmaEnv() !== null,
    connection: row
      ? { id: row.id, accountEmail: row.accountEmail, handle: row.workspaceName }
      : null,
  }
  return c.json(status)
})

// A file link → its pages and frames, for the picker.
figma.get('/file', figmaLimit, async (c) => {
  const ref = refFrom(c, c.req.query('url') ?? '')
  if (ref instanceof Response) return ref
  try {
    const api = await figmaForUser(c.get('user')!.id)
    return c.json({ file: await readFileTree(api, ref) })
  } catch (e) {
    return figmaErrorResponse(c, e)
  }
})

figma.post('/import', figmaLimit, async (c) => {
  const parsed = figmaImportRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const ref = refFrom(c, parsed.data.url)
  if (ref instanceof Response) return ref
  const nodeIds = nodeIdsFor(ref, parsed.data.nodeIds)
  if (nodeIds.length === 0) {
    return c.json(
      {
        error: 'That link is a whole file — pick the frames to import from it.',
        code: 'NEEDS_FRAME',
      },
      400,
    )
  }
  if (parsed.data.clientId && !(await clientExists(parsed.data.clientId))) {
    return c.json({ error: 'Client not found' }, 404)
  }
  const user = c.get('user')!
  const clientId = parsed.data.clientId ?? (await boardClientId(parsed.data.boardId))
  try {
    const api = await figmaForUser(user.id)
    const frames = await importFigmaFrames(api, {
      userId: user.id,
      clientId,
      fileKey: ref.fileKey,
      nodeIds,
    })
    return c.json({ frames })
  } catch (e) {
    return figmaErrorResponse(c, e)
  }
})

// Like the other external refreshes it is a read: the client folds the new
// data into the card and the autosave stores it.
figma.post('/refresh', figmaLimit, async (c) => {
  const parsed = figmaRefreshRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const stored = await loadBoardObject(parsed.data.boardId, parsed.data.objectId)
  if (!stored || stored.object.type !== 'figma-frame') {
    return c.json({ error: 'That isn’t a Figma frame on this board.' }, 404)
  }
  const data = figmaFrameDataSchema.safeParse(stored.object.data)
  if (!data.success) return c.json({ error: 'This card has no Figma origin to refresh.' }, 400)
  const user = c.get('user')!
  try {
    const api = await figmaForUser(user.id)
    return c.json(
      await refreshFigmaFrame(api, { userId: user.id, data: data.data, force: parsed.data.force }),
    )
  } catch (e) {
    return figmaErrorResponse(c, e)
  }
})

figma.post('/kit', figmaLimit, async (c) => {
  const parsed = figmaKitRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const ref = refFrom(c, parsed.data.url)
  if (ref instanceof Response) return ref
  if (parsed.data.clientId && !(await clientExists(parsed.data.clientId))) {
    return c.json({ error: 'Client not found' }, 404)
  }
  const user = c.get('user')!
  try {
    const api = await figmaForUser(user.id)
    const outcome = await figmaKitFromFile(api, {
      fileKey: ref.fileKey,
      userId: user.id,
      clientId: parsed.data.clientId,
      kitId: parsed.data.kitId,
      name: parsed.data.name,
      preview: parsed.data.preview,
      baseVersion: parsed.data.baseVersion,
    })
    if (!outcome.ok) {
      return c.json({ error: outcome.error, latest: outcome.latest }, outcome.status)
    }
    return c.json(outcome.result)
  } catch (e) {
    return figmaErrorResponse(c, e)
  }
})
