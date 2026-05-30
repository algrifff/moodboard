import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db, schema } from '../db'

const AUTH_SECRET = process.env.AUTH_SECRET
if (!AUTH_SECRET) {
  throw new Error('AUTH_SECRET is required')
}

const trustedOrigins = [
  process.env.BETTER_AUTH_URL ?? 'http://localhost:3001',
  'http://localhost:5173',
]

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  secret: AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3001',
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh once per day of activity
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  // better-auth's built-in rate limiter defaults to 100 requests / 10s per
  // IP across *every* path when NODE_ENV=production. That fires on
  // /api/files/* image loads (a brand-page import spawns 1–3 logo image
  // nodes which the browser pulls in parallel alongside any existing
  // canvas images), and the client sees 429s. We already apply per-scope
  // rate limits in lib/rateLimit.ts where they matter (auth, upload,
  // proxy, external-search/import, analyze), so disable the global one.
  rateLimit: {
    enabled: false,
  },
  advanced: {
    crossSubDomainCookies: { enabled: false },
    defaultCookieAttributes: {
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
    },
  },
})

export type AuthUser = (typeof auth.$Infer.Session)['user']
export type AuthSession = (typeof auth.$Infer.Session)['session']
