import type { Context, Next } from 'hono'
import { sql } from 'drizzle-orm'
import { db, schema } from '../db'

type Options = {
  limit: number
  windowMs: number
  keyFn?: (c: Context) => string
  scope: string
}

// Railway's edge appends the connecting address to X-Forwarded-For, so the
// right-most entry is the one a client can't forge.
export function clientKey(forwardedFor: string | undefined): string {
  const last = forwardedFor?.split(',').pop()?.trim()
  return last || 'anon'
}

function defaultKey(c: Context): string {
  return clientKey(c.req.header('x-forwarded-for'))
}

// Fixed-window counter in Postgres so limits hold across API instances.
// One upsert per request: the row's window resets in place once it expires.
async function hit(key: string, windowMs: number): Promise<{ count: number; resetAt: Date }> {
  const now = Date.now()
  const windowStart = new Date(now - (now % windowMs))
  const t = schema.rateLimit
  const [row] = await db
    .insert(t)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: t.key,
      set: {
        count: sql`CASE WHEN ${t.windowStart} = excluded.window_start THEN ${t.count} + 1 ELSE 1 END`,
        windowStart: sql`excluded.window_start`,
      },
    })
    .returning({ count: t.count })
  return { count: row?.count ?? 1, resetAt: new Date(windowStart.getTime() + windowMs) }
}

export function rateLimit({ limit, windowMs, keyFn = defaultKey, scope }: Options) {
  return async (c: Context, next: Next) => {
    let result: { count: number; resetAt: Date }
    try {
      result = await hit(`${scope}:${keyFn(c)}`, windowMs)
    } catch (e) {
      // A limiter outage shouldn't take the API down with it.
      console.warn('[rateLimit] check failed, allowing request', e)
      return next()
    }
    if (result.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000))
      return c.json({ error: 'Too many requests' }, 429, { 'Retry-After': String(retryAfter) })
    }
    await next()
  }
}
