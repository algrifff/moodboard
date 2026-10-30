import { serve } from '@hono/node-server'
import { RENDER_VIDEO_KIND, type HealthResponse } from '@moodboard/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { auth, type AuthSession, type AuthUser } from './auth'
import { db } from './db'
import { runMigrations } from './db/migrate'
import { closeBrowser } from './lib/browser'
import { startJobWorker } from './lib/jobRunner'
import { startMaintenance } from './lib/maintenance'
import { renderVideoHandler } from './lib/outputVideo'
import { rateLimit } from './lib/rateLimit'
import { syncStarterTemplates } from './lib/starterTemplates'
import { ensureDataDirs } from './lib/storage'
import { defaultModelClient } from './lib/orchestrator'
import { agentRoutes } from './routes/agent'
import { analyze } from './routes/analyze'
import { apiKeys } from './routes/apiKeys'
import { boardGroups } from './routes/boardGroups'
import { boards } from './routes/boards'
import { clients } from './routes/clients'
import { connections } from './routes/connections'
import { designRuns } from './routes/designRuns'
import { external } from './routes/external'
import { figma } from './routes/figma'
import { files } from './routes/files'
import { kits } from './routes/kits'
import { library } from './routes/library'
import { linear } from './routes/linear'
import { mcp } from './routes/mcp'
import { outputShares, outputs, templates } from './routes/outputs'
import { renderJobs } from './routes/renderJobs'
import { boardShare, shares } from './routes/shares'
import { voice } from './routes/voice'

type AppVariables = {
  user: AuthUser | null
  session: AuthSession | null
}

const app = new Hono<{ Variables: AppVariables }>()

// Custom logger that masks the path-based MCP token (`/api/mcp/<token>`)
// so plaintext tokens never land in stdout / Railway logs. Bearer-header
// auth is naturally fine since Authorization isn't in the request line.
app.use(
  '*',
  logger((msg, ...rest) => console.log(maskMcpToken(msg), ...rest)),
)

function maskMcpToken(line: string): string {
  return line.replace(/(\/api\/mcp\/)[^\s?]+/g, '$1<token>')
}
// Allowed dev origins for browser-driven requests. We accept all four
// localhost-class origins:
//   - http://localhost:5173  — plain dev
//   - https://localhost:5173 — local TLS via mkcert (apps/web/vite.config.ts)
//   - http://127.0.0.1:5173  — required by Spotify's redirect-URI policy
//                              (they reject https://localhost since their
//                              validator can't verify a locally-signed cert)
//   - http://localhost:3001  — direct api hits (curl / health checks)
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'https://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3001',
])
app.use(
  '*',
  cors({
    origin: (origin) => (ALLOWED_ORIGINS.has(origin) ? origin : null),
    credentials: true,
  }),
)

// Tighten the auth handler against credential stuffing. The bucket size lets a
// legitimate user retype once or twice without hitting the wall. Only POSTs
// (sign-in, sign-up, …) count — session reads happen on every page load.
const authRateLimit = rateLimit({ scope: 'auth', limit: 10, windowMs: 60_000 })
app.post('/api/auth/*', authRateLimit)
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

// Owner-side share endpoints — auth-gated upsert / get / delete for the
// share belonging to a given board. Registered BEFORE the boards router
// so the more specific path matches first. Public viewer + PDF endpoints
// mount separately under /shares (no global auth).
api.route('/boards/:boardId/share', boardShare)
api.route('/boards/:boardId/groups', boardGroups)
api.route('/boards/:boardId/agent', agentRoutes(defaultModelClient()))
api.route('/shares', shares)
api.route('/boards', boards)
// Phase 19 — MCP server. Bearer-auth via its own middleware (not the
// cookie session). /api/keys is the cookie-auth dashboard surface for
// minting + revoking the Bearer tokens that /api/mcp accepts.
api.route('/keys', apiKeys)
api.route('/mcp', mcp)
api.route('/connections', connections)
api.route('/clients', clients)
api.route('/kits', kits)
api.route('/library', library)
api.route('/templates', templates)
api.route('/outputs', outputs)
api.route('/output-shares', outputShares)
api.route('/design-runs', designRuns)
api.route('/render-jobs', renderJobs)
api.route('/linear', linear)
api.route('/figma', figma)
api.route('/external', external)
api.route('/voice', voice)
api.route('/', analyze)
api.route('/', files)

app.route('/api', api)

const port = Number(process.env.PORT ?? 3001)

await runMigrations(process.env.DATABASE_URL!)
await ensureDataDirs()
await syncStarterTemplates()
startMaintenance()
// Background jobs (MP4 renders). JOB_WORKER=0 makes an instance API-only.
const jobWorker =
  process.env.JOB_WORKER === '0'
    ? null
    : startJobWorker({
        handlers: { [RENDER_VIDEO_KIND]: renderVideoHandler },
        concurrency: Math.max(1, Number(process.env.JOB_CONCURRENCY) || 1),
      })

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`)
})

// The shared headless Chromium (PDFs, output frames) is a child process;
// close it with the server rather than leaving it to the OS.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close()
    // Running jobs go back on the queue for another instance to take.
    void (jobWorker?.stop() ?? Promise.resolve())
      .then(() => closeBrowser())
      .finally(() => process.exit(0))
  })
}
