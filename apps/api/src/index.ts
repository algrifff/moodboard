import { serve } from '@hono/node-server'
import type { HealthResponse } from '@moodboard/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { auth, type AuthSession, type AuthUser } from './auth'
import { db } from './db'
import { rateLimit } from './lib/rateLimit'
import { ensureDataDirs } from './lib/storage'
import { analyze } from './routes/analyze'
import { boards } from './routes/boards'
import { connections } from './routes/connections'
import { external } from './routes/external'
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
      origin === 'http://localhost:5173' || origin === 'http://localhost:3001' ? origin : null,
    credentials: true,
  }),
)

// Tighten the auth handler against credential stuffing. The bucket size lets a
// legitimate user retype once or twice without hitting the wall.
const authRateLimit = rateLimit({ scope: 'auth', limit: 10, windowMs: 60_000 })
app.all('/api/auth/*', authRateLimit, (c) => auth.handler(c.req.raw))

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
    await db.execute(sql`select 1`)
    return c.json({ status: 'ok' })
  } catch (e) {
    console.error('db health failed', e)
    return c.json({ status: 'error' }, 500)
  }
})

api.get('/me', (c) => {
  const user = c.get('user')
  return c.json({ user })
})

// Bound JSON body size before drizzle/zod see it. Multipart upload routes
// declare their own larger limit; everything else (boards CRUD, auth JSON)
// caps at 1MB.
const jsonBodyLimit = bodyLimit({
  maxSize: 1024 * 1024,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
})

api.use('/boards', jsonBodyLimit)
api.use('/boards/*', jsonBodyLimit)

api.route('/boards', boards)
api.route('/connections', connections)
api.route('/external', external)
api.route('/', analyze)
api.route('/', files)

app.route('/api', api)

const port = Number(process.env.PORT ?? 3001)

await ensureDataDirs()

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`)
})
