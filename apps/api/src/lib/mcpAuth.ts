import { eq } from 'drizzle-orm'
import type { Context, Next } from 'hono'
import { db, schema } from '../db'
import type { AuthUser } from '../auth'
import { bumpLastUsedAt, resolveApiKey } from './apiKey'

// Bearer-token middleware for /api/mcp. Replaces the cookie-based
// session check the rest of the API uses. On success, sets `c.var.user`
// to the same `AuthUser` shape so downstream tool handlers don't have
// to special-case auth mode.

export type McpVariables = {
  user: AuthUser | null
}

type McpContext = Context<{ Variables: McpVariables }>

function unauthorized(c: McpContext) {
  // Don't volunteer the token format — keep the 401 generic.
  return c.json({ error: 'Unauthorized' }, 401)
}

export async function mcpAuth(c: McpContext, next: Next) {
  const header = c.req.header('Authorization') ?? c.req.header('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) return unauthorized(c)
  const plaintext = match[1]?.trim() ?? ''
  if (!plaintext) return unauthorized(c)

  const resolved = await resolveApiKey(plaintext)
  if (!resolved) return unauthorized(c)

  // Pull the user row so tools downstream get the full AuthUser shape
  // (the resolveApiKey result only has the FK userId).
  const [userRow] = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.id, resolved.userId))
    .limit(1)
  if (!userRow) return unauthorized(c)

  c.set('user', userRow as unknown as AuthUser)
  bumpLastUsedAt(resolved.keyId)
  await next()
}
