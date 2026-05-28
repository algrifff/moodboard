import type { Context, Next } from 'hono'

type Bucket = { tokens: number; lastRefill: number }

const buckets = new Map<string, Bucket>()

// Periodically purge stale buckets so the map doesn't grow forever.
setInterval(
  () => {
    const now = Date.now()
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastRefill > 60 * 60 * 1000) buckets.delete(key)
    }
  },
  5 * 60 * 1000,
).unref?.()

type Options = {
  limit: number
  windowMs: number
  keyFn?: (c: Context) => string
  scope: string
}

function defaultKey(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded ?? 'anon'
}

export function rateLimit({ limit, windowMs, keyFn = defaultKey, scope }: Options) {
  return async (c: Context, next: Next) => {
    const key = `${scope}:${keyFn(c)}`
    const now = Date.now()
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { tokens: limit, lastRefill: now }
      buckets.set(key, bucket)
    } else {
      const elapsed = now - bucket.lastRefill
      const refill = Math.floor((elapsed / windowMs) * limit)
      if (refill > 0) {
        bucket.tokens = Math.min(limit, bucket.tokens + refill)
        bucket.lastRefill = now
      }
    }
    if (bucket.tokens <= 0) {
      const retryAfter = Math.ceil(windowMs / limit / 1000)
      return c.json({ error: 'Too many requests' }, 429, { 'Retry-After': String(retryAfter) })
    }
    bucket.tokens -= 1
    await next()
  }
}
