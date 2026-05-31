import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { mintApiKey } from '../lib/apiKey'
import { rateLimit } from '../lib/rateLimit'

type Variables = { user: AuthUser | null; session: AuthSession | null }

// Owner-side CRUD for API keys. The MCP server reads keys from a
// different surface (Bearer header → resolveApiKey); this router only
// powers the dashboard "API keys" card.
export const apiKeys = new Hono<{ Variables: Variables }>()

apiKeys.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

// Per-IP cap. Minting is rare in normal use but a hostile user
// shouldn't be able to fill the table.
const mintRateLimit = rateLimit({ scope: 'api-key-mint', limit: 12, windowMs: 60_000 })

const createKeyRequest = z.object({
  name: z.string().trim().min(1).max(60),
})

apiKeys.get('/', async (c) => {
  const user = c.get('user')!
  const rows = await db
    .select({
      id: schema.apiKey.id,
      name: schema.apiKey.name,
      prefix: schema.apiKey.prefix,
      lastUsedAt: schema.apiKey.lastUsedAt,
      createdAt: schema.apiKey.createdAt,
    })
    .from(schema.apiKey)
    .where(eq(schema.apiKey.userId, user.id))
    .orderBy(desc(schema.apiKey.createdAt))
  return c.json({
    keys: rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
  })
})

apiKeys.post('/', mintRateLimit, async (c) => {
  const user = c.get('user')!
  const body = await c.req.json().catch(() => null)
  const parsed = createKeyRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  }
  const minted = await mintApiKey({ userId: user.id, name: parsed.data.name })
  // Plaintext returned exactly once. Dashboard surfaces the modal that
  // makes the user copy it now.
  return c.json({
    key: {
      id: minted.id,
      name: parsed.data.name,
      prefix: minted.prefix,
      plaintext: minted.plaintext,
    },
  })
})

apiKeys.delete('/:id', async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id') as string
  const [row] = await db
    .delete(schema.apiKey)
    .where(and(eq(schema.apiKey.id, id), eq(schema.apiKey.userId, user.id)))
    .returning({ id: schema.apiKey.id })
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})
