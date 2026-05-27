import { serve } from '@hono/node-server'
import type { HealthResponse } from '@moodboard/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { auth, type AuthSession, type AuthUser } from './auth'
import { db } from './db'
import { ensureDataDirs } from './lib/storage'
import { boards } from './routes/boards'
import { files } from './routes/files'

type AppVariables = {
  user: AuthUser | null
  session: AuthSession | null
}

const app = new Hono<{ Variables: AppVariables }>()

app.use('*', logger())
app.use(
  '*',
  cors({
    origin: (origin) =>
      origin === 'http://localhost:5173' || origin === 'http://localhost:3001'
        ? origin
        : null,
    credentials: true,
  }),
)

// Mount better-auth handler before the api routes so /api/auth/* is owned by it.
app.all('/api/auth/*', (c) => auth.handler(c.req.raw))

// Session middleware — populate c.var.user / c.var.session for downstream routes.
app.use('*', async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers })
  c.set('user', result?.user ?? null)
  c.set('session', result?.session ?? null)
  await next()
})

const api = new Hono<{ Variables: AppVariables }>()

api.get('/health', (c) => {
  const body: HealthResponse = {
    status: 'ok',
    service: 'moodboard-api',
    time: new Date().toISOString(),
  }
  return c.json(body)
})

api.get('/db/health', async (c) => {
  try {
    const result = await db.execute(sql`select 1 as ok`)
    return c.json({ status: 'ok', driver: 'postgres-js', result: result[0] })
  } catch (e) {
    return c.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

api.get('/me', (c) => {
  const user = c.get('user')
  return c.json({ user })
})

api.route('/boards', boards)
api.route('/', files)

app.route('/api', api)

const port = Number(process.env.PORT ?? 3001)

await ensureDataDirs()

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`)
})
