import { describe, expect, it } from 'vitest'

// clientKey is pure, but rateLimit.ts imports the db module, which throws
// at import without DATABASE_URL — so the import is lazy and the suite
// only runs where a database is configured.
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('rateLimit', () => {
  it('keys on the right-most X-Forwarded-For entry', async () => {
    const { clientKey } = await import('./rateLimit')
    expect(clientKey('6.6.6.6, 10.0.0.1, 203.0.113.9')).toBe('203.0.113.9')
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9')
    expect(clientKey(undefined)).toBe('anon')
    expect(clientKey('')).toBe('anon')
  })

  it('allows up to the limit per window, then 429s with Retry-After', async () => {
    const { Hono } = await import('hono')
    const { rateLimit } = await import('./rateLimit')
    const app = new Hono()
    const scope = `test-${Date.now()}-${Math.random()}`
    app.get('/', rateLimit({ scope, limit: 2, windowMs: 60_000 }), (c) => c.text('ok'))
    const call = () => app.request('/', { headers: { 'x-forwarded-for': '198.51.100.7' } })
    expect((await call()).status).toBe(200)
    expect((await call()).status).toBe(200)
    const limited = await call()
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    // A different client has its own budget.
    const other = await app.request('/', { headers: { 'x-forwarded-for': '198.51.100.8' } })
    expect(other.status).toBe(200)
  })
})
