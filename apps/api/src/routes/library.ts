import {
  addAssetToBoardRequestSchema,
  libraryQuerySchema,
  updateAssetRequestSchema,
} from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { getLibraryAsset, searchAssets, updateAsset } from '../lib/assetLibrary'
import { clientExists } from '../lib/clients'
import { addAssetToBoard } from '../lib/libraryBoard'
import { rateLimit } from '../lib/rateLimit'

type Variables = { user: AuthUser | null; session: AuthSession | null }

// The asset library over every upload and import. Team-visible. Uploading
// goes through POST /api/upload (optionally with a clientId field); this
// router is browse, search, edit and place-on-board.
export const library = new Hono<{ Variables: Variables }>()

library.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

const searchLimit = rateLimit({ scope: 'library-search', limit: 60, windowMs: 60_000 })

library.get('/', searchLimit, async (c) => {
  const parsed = libraryQuerySchema.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: 'Invalid query', issues: parsed.error.issues }, 400)
  return c.json(await searchAssets(parsed.data))
})

library.get('/:id', async (c) => {
  const asset = await getLibraryAsset(c.req.param('id'))
  if (!asset) return c.json({ error: 'Not found' }, 404)
  return c.json({ asset })
})

library.patch('/:id', async (c) => {
  const parsed = updateAssetRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  if (parsed.data.clientId && !(await clientExists(parsed.data.clientId))) {
    return c.json({ error: 'Client not found' }, 404)
  }
  const asset = await updateAsset(c.req.param('id'), parsed.data)
  if (!asset) return c.json({ error: 'Not found' }, 404)
  return c.json({ asset })
})

// Server-side so PDFs and fonts arrive with the same data they'd have had
// on upload. The open canvas folds the returned object in (see the sources
// drawer); a board nobody has open picks it up on load.
library.post('/:id/add-to-board', async (c) => {
  const parsed = addAssetToBoardRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const [board] = await db
    .select({ id: schema.board.id })
    .from(schema.board)
    .where(eq(schema.board.id, parsed.data.boardId))
    .limit(1)
  if (!board) return c.json({ error: 'Board not found' }, 404)
  const result = await addAssetToBoard(c.req.param('id'), board.id, c.get('user')!.id)
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json(result.added)
})
