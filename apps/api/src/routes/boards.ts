import type { BoardPreview, BoardPreviewObject } from '@moodboard/shared'
import { createBoardRequestSchema, updateBoardRequestSchema } from '@moodboard/shared'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const boards = new Hono<{ Variables: Variables }>()

// Cap the per-board preview at the largest N by area. Beyond this the
// thumbnail is just visual noise; the bounding box still uses every object
// so the framing is correct even if some are dropped from the render list.
const PREVIEW_OBJECT_CAP = 12

// Type guard for a canvas object in stored board data. Loose on purpose —
// historical board snapshots may have minor shape drift, and the dashboard
// preview shouldn't fall over on a missing field.
type StoredObject = {
  type: 'image' | 'sticky' | 'text' | 'pdf'
  position: { x: number; y: number }
  size: { width: number; height: number }
  data?: Record<string, unknown>
}
function isStoredObject(o: unknown): o is StoredObject {
  if (!o || typeof o !== 'object') return false
  const obj = o as Record<string, unknown>
  if (typeof obj.type !== 'string') return false
  if (!['image', 'sticky', 'text', 'pdf'].includes(obj.type as string)) return false
  const pos = obj.position as Record<string, unknown> | undefined
  const size = obj.size as Record<string, unknown> | undefined
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return false
  if (!size || typeof size.width !== 'number' || typeof size.height !== 'number') return false
  return true
}

/** Project a stored board's `data` blob into a small render hint for the dashboard. */
function buildPreview(data: unknown): BoardPreview {
  if (!data || typeof data !== 'object') return { bounds: null, objects: [] }
  const objs = (data as { objects?: unknown[] }).objects
  if (!Array.isArray(objs)) return { bounds: null, objects: [] }
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

boards.get('/', async (c) => {
  const user = c.get('user')!
  const rows = await db
    .select({
      id: schema.board.id,
      name: schema.board.name,
      createdAt: schema.board.createdAt,
      updatedAt: schema.board.updatedAt,
      data: schema.board.data,
    })
    .from(schema.board)
    .where(eq(schema.board.userId, user.id))
    .orderBy(desc(schema.board.updatedAt))
  return c.json({
    boards: rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      preview: buildPreview(r.data),
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
  const [row] = await db
    .insert(schema.board)
    .values({
      id: nanoid(),
      userId: user.id,
      name: parsed.data.name ?? 'Untitled board',
      data: {},
    })
    .returning()
  if (!row) return c.json({ error: 'Insert failed' }, 500)
  return c.json({
    board: {
      id: row.id,
      name: row.name,
      data: row.data,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
  })
})

boards.get('/:id', async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id')
  const [row] = await db
    .select()
    .from(schema.board)
    .where(and(eq(schema.board.id, id), eq(schema.board.userId, user.id)))
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({
    board: {
      id: row.id,
      name: row.name,
      data: row.data,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
  })
})

boards.patch('/:id', async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const parsed = updateBoardRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  }
  if (parsed.data.name === undefined && parsed.data.data === undefined) {
    return c.json({ error: 'Nothing to update' }, 400)
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (parsed.data.name !== undefined) updates.name = parsed.data.name
  if (parsed.data.data !== undefined) updates.data = parsed.data.data

  const [row] = await db
    .update(schema.board)
    .set(updates)
    .where(and(eq(schema.board.id, id), eq(schema.board.userId, user.id)))
    .returning()
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({
    board: {
      id: row.id,
      name: row.name,
      data: row.data,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
  })
})

boards.delete('/:id', async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id')
  const [row] = await db
    .delete(schema.board)
    .where(and(eq(schema.board.id, id), eq(schema.board.userId, user.id)))
    .returning({ id: schema.board.id })
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})
