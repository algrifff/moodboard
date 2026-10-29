import { putGroupStateRequestSchema } from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import type { Context, Next } from 'hono'
import { Hono } from 'hono'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { listGroupStates, putGroupState } from '../lib/groupState'

type Variables = { user: AuthUser | null; session: AuthSession | null }

// Team-shared analysis-panel state per group. Mounted at
// /api/boards/:boardId/groups.
export const boardGroups = new Hono<{ Variables: Variables }>()

async function requireBoard(c: Context<{ Variables: Variables }>, next: Next) {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401)
  const boardId = c.req.param('boardId') as string
  const [row] = await db
    .select({ id: schema.board.id })
    .from(schema.board)
    .where(eq(schema.board.id, boardId))
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  await next()
}

boardGroups.use('*', requireBoard)

boardGroups.get('/', async (c) => {
  const boardId = c.req.param('boardId') as string
  return c.json({ groups: await listGroupStates(boardId) })
})

boardGroups.put('/:groupKey', async (c) => {
  const boardId = c.req.param('boardId') as string
  const groupKey = c.req.param('groupKey')
  const body = await c.req.json().catch(() => null)
  const parsed = putGroupStateRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  }
  if (parsed.data.display && !parsed.data.agentIds) {
    return c.json({ error: 'display requires agentIds' }, 400)
  }
  await putGroupState(boardId, groupKey, parsed.data)
  return c.json({ ok: true })
})
