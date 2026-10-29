import type { BoardPreview, BoardPreviewObject, FullBoard } from '@moodboard/shared'
import {
  createBoardRequestSchema,
  saveBoardObjectsRequestSchema,
  updateBoardRequestSchema,
} from '@moodboard/shared'
import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { loadBoardObjects, loadObjectsByBoard, saveBoardObjects } from '../lib/boardObjects'
import { clientExists } from '../lib/clients'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const boards = new Hono<{ Variables: Variables }>()

// Cap the per-board preview at the largest N by area. Beyond this the
// thumbnail is just visual noise; the bounding box still uses every object
// so the framing is correct even if some are dropped from the render list.
const PREVIEW_OBJECT_CAP = 12

// Type guard for a stored canvas object. Loose on purpose — historical
// objects may have minor shape drift, and the dashboard preview shouldn't
// fall over on a missing field.
type StoredObject = {
  type: 'image' | 'sticky' | 'text' | 'pdf' | 'font' | 'drive-file' | 'drive-folder'
  position: { x: number; y: number }
  size: { width: number; height: number }
  data?: Record<string, unknown>
}
const STORED_TYPES = [
  'image',
  'sticky',
  'text',
  'pdf',
  'font',
  'drive-file',
  'drive-folder',
] as const
function isStoredObject(o: unknown): o is StoredObject {
  if (!o || typeof o !== 'object') return false
  const obj = o as Record<string, unknown>
  if (typeof obj.type !== 'string') return false
  if (!STORED_TYPES.includes(obj.type as (typeof STORED_TYPES)[number])) return false
  const pos = obj.position as Record<string, unknown> | undefined
  const size = obj.size as Record<string, unknown> | undefined
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return false
  if (!size || typeof size.width !== 'number' || typeof size.height !== 'number') return false
  return true
}

/** Project a board's objects into a small render hint for the dashboard. */
function buildPreview(objs: unknown[]): BoardPreview {
  const stored = objs.filter(isStoredObject)
  if (stored.length === 0) return { bounds: null, objects: [] }

  // Bounding box uses every object so framing matches what the user sees
  // on the real canvas, even when some objects are dropped from the render
  // list below.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const o of stored) {
    minX = Math.min(minX, o.position.x)
    minY = Math.min(minY, o.position.y)
    maxX = Math.max(maxX, o.position.x + o.size.width)
    maxY = Math.max(maxY, o.position.y + o.size.height)
  }

  // Top N by area. Sticky-note text content is never sent — only colour.
  const ranked = [...stored]
    .sort((a, b) => b.size.width * b.size.height - a.size.width * a.size.height)
    .slice(0, PREVIEW_OBJECT_CAP)

  const projected: BoardPreviewObject[] = ranked.map((o) => {
    const base: BoardPreviewObject = {
      x: o.position.x,
      y: o.position.y,
      w: o.size.width,
      h: o.size.height,
      type: o.type,
    }
    const d = o.data
    if (o.type === 'sticky' && d && typeof d.color === 'string') base.color = d.color
    if ((o.type === 'image' || o.type === 'pdf') && d) {
      const url =
        typeof d.thumbnailUrl === 'string' ? d.thumbnailUrl : (d.url as string | undefined)
      if (typeof url === 'string') base.thumbnailUrl = url
    }
    if (o.type === 'font' && d) {
      if (typeof d.family === 'string') base.family = d.family
      if (typeof d.url === 'string') base.url = d.url
    }
    if ((o.type === 'drive-file' || o.type === 'drive-folder') && d) {
      if (typeof d.name === 'string') base.title = d.name
      if (typeof d.mimeType === 'string') base.mimeType = d.mimeType
    }
    return base
  })

  return {
    bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    objects: projected,
  }
}

boards.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

async function fullBoard(row: typeof schema.board.$inferSelect): Promise<FullBoard> {
  const objects = await loadBoardObjects(row.id)
  return {
    id: row.id,
    name: row.name,
    objects: objects.map((o) => o.object),
    versions: Object.fromEntries(objects.map((o) => [o.object.id, o.version])),
    clientId: row.clientId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

boards.get('/', async (c) => {
  const rows = await db.select().from(schema.board).orderBy(desc(schema.board.updatedAt))
  const objectsByBoard = await loadObjectsByBoard(rows.map((r) => r.id))
  return c.json({
    boards: rows.map((r) => ({
      id: r.id,
      name: r.name,
      clientId: r.clientId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      preview: buildPreview(objectsByBoard.get(r.id) ?? []),
    })),
  })
})

boards.post('/', async (c) => {
  const user = c.get('user')!
  const body = await c.req.json().catch(() => ({}))
  const parsed = createBoardRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  }
  if (parsed.data.clientId && !(await clientExists(parsed.data.clientId))) {
    return c.json({ error: 'Client not found' }, 404)
  }
  const [row] = await db
    .insert(schema.board)
    .values({
      id: nanoid(),
      createdBy: user.id,
      name: parsed.data.name ?? 'Untitled board',
      clientId: parsed.data.clientId ?? null,
    })
    .returning()
  if (!row) return c.json({ error: 'Insert failed' }, 500)
  return c.json({ board: await fullBoard(row) })
})

boards.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(schema.board).where(eq(schema.board.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({ board: await fullBoard(row) })
})

boards.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const parsed = updateBoardRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  }
  if (parsed.data.clientId && !(await clientExists(parsed.data.clientId))) {
    return c.json({ error: 'Client not found' }, 404)
  }
  // Assigning a client isn't an edit to the canvas, so it leaves the
  // "edited" time alone.
  const [row] = await db
    .update(schema.board)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name, updatedAt: new Date() } : {}),
      ...(parsed.data.clientId !== undefined ? { clientId: parsed.data.clientId } : {}),
    })
    .where(eq(schema.board.id, id))
    .returning()
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({ board: await fullBoard(row) })
})

// Object-level autosave. Writes that lost a race with a teammate come back
// in `conflicts` with the server's copy; the client adopts it.
boards.post('/:id/objects', async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const parsed = saveBoardObjectsRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  }
  const [row] = await db
    .select({ id: schema.board.id })
    .from(schema.board)
    .where(eq(schema.board.id, id))
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(await saveBoardObjects(id, parsed.data, user.id))
})

boards.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const [row] = await db
    .delete(schema.board)
    .where(eq(schema.board.id, id))
    .returning({ id: schema.board.id })
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})
