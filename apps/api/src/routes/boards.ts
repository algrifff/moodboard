import { createBoardRequestSchema, updateBoardRequestSchema } from '@moodboard/shared'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const boards = new Hono<{ Variables: Variables }>()

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
