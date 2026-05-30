import { and, desc, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { nanoid } from 'nanoid'
import { randomBytes } from 'node:crypto'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { decryptToken, encryptToken } from '../lib/cryptoTokens'
import {
  exchangeCode as driveExchangeCode,
  getValidToken,
  listFolderChildren as driveListFolderChildren,
  searchFiles as driveSearchFiles,
} from '../lib/drive'
import { exchangeCode, getChildPages, searchPages } from '../lib/notion'
import { rateLimit } from '../lib/rateLimit'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const connections = new Hono<{ Variables: Variables }>()

// Picker / recents are read-heavy; cap to keep the Notion API happy under a
// jittery typing user.
const externalSearchLimit = rateLimit({ scope: 'external-search', limit: 30, windowMs: 60_000 })

// State cookie lifetime — long enough for slow OAuth dances, short enough
// that an abandoned popup can't replay later.
const OAUTH_STATE_TTL_SECONDS = 10 * 60
const STATE_COOKIE = (provider: string) => `mb_oauth_state_${provider}`

// Web origin the popup will postMessage back to. Validated at start so a
// misconfigured deploy fails loudly, not silently.
function webOrigin(): string {
  const origin = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
  if (!/^https?:\/\//.test(origin)) {
    throw new Error('WEB_ORIGIN must be an http(s) origin')
  }
  return origin
}

function notionEnv(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.NOTION_CLIENT_ID
  const clientSecret = process.env.NOTION_CLIENT_SECRET
  const redirectUri = process.env.NOTION_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Notion OAuth env vars are not configured')
  }
  return { clientId, clientSecret, redirectUri }
}

function googleEnv(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Google OAuth env vars are not configured')
  }
  return { clientId, clientSecret, redirectUri }
}

// Drive scopes — readonly is enough for the picker + import. userinfo.email
// + openid give us the account's email for the connection label (returned
// via id_token, decoded server-side).
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
].join(' ')

// ---------------------------------------------------------------------------
// Auth gate. Mirrors apps/api/src/routes/boards.ts:94 — same pattern, kept
// inline rather than extracted so it's obvious which routes are gated.
// ---------------------------------------------------------------------------
connections.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

// ---------------------------------------------------------------------------
// GET /api/connections
//
// List the current user's connections. Tokens stay server-side — clients
// only see metadata + the opaque id used in subsequent calls.
// ---------------------------------------------------------------------------
connections.get('/', async (c) => {
  const user = c.get('user')!
  const rows = await db
    .select({
      id: schema.connection.id,
      provider: schema.connection.provider,
      accountEmail: schema.connection.accountEmail,
      workspaceName: schema.connection.workspaceName,
      createdAt: schema.connection.createdAt,
      lastUsedAt: schema.connection.lastUsedAt,
    })
    .from(schema.connection)
    .where(eq(schema.connection.userId, user.id))
    .orderBy(desc(schema.connection.createdAt))
  return c.json({
    connections: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      accountEmail: r.accountEmail,
      workspaceName: r.workspaceName,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    })),
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/connections/:id
//
// Disconnect a connection. We delete the row (tokens go with it via cascade
// + the connection row itself); upstream revocation is best-effort and not
// required for the user-facing disconnect to succeed. Notion does not offer
// a programmatic revoke endpoint for public integrations — the user
// disconnects in their Notion workspace UI to fully revoke our access. We
// surface that in the disconnect confirmation copy on the frontend.
// ---------------------------------------------------------------------------
connections.delete('/:id', async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id')
  const [row] = await db
    .delete(schema.connection)
    .where(and(eq(schema.connection.id, id), eq(schema.connection.userId, user.id)))
    .returning({ id: schema.connection.id })
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// GET /api/connections/notion/start
//
// Generate a CSRF state nonce, drop it in a same-site httpOnly cookie, and
// 302 the user to Notion's OAuth consent screen. The callback validates the
// returned state matches the cookie before exchanging the code.
// ---------------------------------------------------------------------------
connections.get('/notion/start', async (c) => {
  const { clientId, redirectUri } = notionEnv()
  const state = randomBytes(24).toString('hex')
  setCookie(c, STATE_COOKIE('notion'), state, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: OAUTH_STATE_TTL_SECONDS,
  })
  const url = new URL('https://api.notion.com/v1/oauth/authorize')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('owner', 'user')
  url.searchParams.set('state', state)
  return c.redirect(url.toString())
})

// ---------------------------------------------------------------------------
// GET /api/connections/notion/callback
//
// 1. Validate state vs cookie (CSRF)
// 2. Exchange code → tokens via Notion's OAuth endpoint
// 3. Encrypt tokens, persist connection row
// 4. Return a tiny HTML page that postMessages back to window.opener and closes.
//
// On error: still return the same HTML shape with type=mb:connection:error.
// The popup is at the API origin; the parent is at WEB_ORIGIN. postMessage
// uses webOrigin() as the strict target so an attacker window that grabbed
// our popup ref can't receive the connection id.
// ---------------------------------------------------------------------------
connections.get('/notion/callback', async (c) => {
  const user = c.get('user')!
  const code = c.req.query('code')
  const stateParam = c.req.query('state')
  const stateCookie = getCookie(c, STATE_COOKIE('notion'))
  deleteCookie(c, STATE_COOKIE('notion'), { path: '/' })

  if (!code) return callbackHtml(c, { kind: 'error', message: 'Missing code' })
  if (!stateParam || !stateCookie || stateParam !== stateCookie) {
    return callbackHtml(c, { kind: 'error', message: 'Invalid state' })
  }

  try {
    const { clientId, clientSecret, redirectUri } = notionEnv()
    const token = await exchangeCode({ code, clientId, clientSecret, redirectUri })

    // Pull the user's email from the owner payload when present; fall back
    // to the workspace name so the connection card still has a label.
    const ownerEmail = token.owner?.user?.person?.email
    const accountEmail = ownerEmail ?? token.workspaceName ?? 'Notion workspace'

    const id = nanoid()
    await db.insert(schema.connection).values({
      id,
      userId: user.id,
      provider: 'notion',
      accountEmail,
      accessTokenEnc: encryptToken(token.accessToken),
      refreshTokenEnc: token.refreshToken ? encryptToken(token.refreshToken) : null,
      expiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000) : null,
      scopes: 'read_content,read_user',
      workspaceId: token.workspaceId,
      workspaceName: token.workspaceName,
    })

    return callbackHtml(c, { kind: 'done', id })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return callbackHtml(c, { kind: 'error', message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/connections/drive/start
//
// Mirrors the notion start route — same CSRF cookie pattern, different
// provider. Google needs `access_type=offline&prompt=consent` to issue a
// refresh token even for returning users; otherwise we'd be re-prompting
// every hour when the access token expires.
// ---------------------------------------------------------------------------
connections.get('/drive/start', async (c) => {
  const { clientId, redirectUri } = googleEnv()
  const state = randomBytes(24).toString('hex')
  setCookie(c, STATE_COOKIE('drive'), state, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: OAUTH_STATE_TTL_SECONDS,
  })
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GOOGLE_SCOPES)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)
  return c.redirect(url.toString())
})

// ---------------------------------------------------------------------------
// GET /api/connections/drive/callback
//
// Same state check + token exchange shape as notion/callback. Stores email
// (pulled from the id_token claim by exchangeCode) as the connection label.
// ---------------------------------------------------------------------------
connections.get('/drive/callback', async (c) => {
  const user = c.get('user')!
  const code = c.req.query('code')
  const stateParam = c.req.query('state')
  const stateCookie = getCookie(c, STATE_COOKIE('drive'))
  deleteCookie(c, STATE_COOKIE('drive'), { path: '/' })

  if (!code) return callbackHtml(c, { kind: 'error', message: 'Missing code' })
  if (!stateParam || !stateCookie || stateParam !== stateCookie) {
    return callbackHtml(c, { kind: 'error', message: 'Invalid state' })
  }

  try {
    const { clientId, clientSecret, redirectUri } = googleEnv()
    const token = await driveExchangeCode({ code, clientId, clientSecret, redirectUri })

    const accountEmail = token.email ?? 'Google account'
    const id = nanoid()
    await db.insert(schema.connection).values({
      id,
      userId: user.id,
      provider: 'drive',
      accountEmail,
      accessTokenEnc: encryptToken(token.accessToken),
      refreshTokenEnc: token.refreshToken ? encryptToken(token.refreshToken) : null,
      expiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000) : null,
      scopes: token.scope ?? GOOGLE_SCOPES,
    })

    return callbackHtml(c, { kind: 'done', id })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return callbackHtml(c, { kind: 'error', message })
  }
})

// Minimal HTML page that posts a message to its opener and closes. Inline
// content is HTML-escaped via JSON.stringify to keep the message body safe;
// the postMessage targetOrigin is hardcoded to WEB_ORIGIN.
function callbackHtml(
  c: Context,
  payload: { kind: 'done'; id: string } | { kind: 'error'; message: string },
) {
  const origin = webOrigin()
  const data =
    payload.kind === 'done'
      ? { type: 'mb:connection:done', id: payload.id }
      : { type: 'mb:connection:error', message: payload.message }
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Connecting…</title></head>
<body style="font-family:system-ui;color:#666;padding:24px;text-align:center">
<p>${payload.kind === 'done' ? 'Connected.' : 'Connection failed.'} You can close this window.</p>
<script>
(function() {
  var origin = ${JSON.stringify(origin)};
  var data = ${json};
  // Strip the OAuth code / state from the visible URL before anything
  // else — defence-in-depth against tab restoration / browser history
  // leaking the code to extensions or screen-share viewers.
  try { history.replaceState(null, '', location.pathname); } catch(e) {}
  try { if (window.opener) window.opener.postMessage(data, origin); } catch(e) {}
  setTimeout(function() { window.close(); }, 100);
})();
</script>
</body></html>`
  return c.html(html)
}

// ---------------------------------------------------------------------------
// POST /api/connections/:id/search
// GET  /api/connections/:id/recents
//
// Search / recents are per-connection — body carries no provider, the
// connection row determines which client to dispatch to. The frontend
// builds tiles uniformly across providers via the shared PickerTile shape.
//
// These live in this file (not external.ts) because they're scoped to a
// connection id and use the connection's stored tokens directly. Imports
// (notion/import, drive/import) live in external.ts.
// ---------------------------------------------------------------------------

type PickerTile = {
  id: string
  connectionId: string
  provider: 'notion' | 'drive'
  kind: 'page' | 'file' | 'folder'
  title: string
  iconUrl?: string
  iconEmoji?: string
  mimeType?: string
  lastEditedAt?: string
}

const MIME_FOLDER = 'application/vnd.google-apps.folder'

// Decrypt token + ensure the connection belongs to the caller. Throws 404
// (handled by caller) if missing.
async function loadConnection(userId: string, connectionId: string) {
  const [row] = await db
    .select()
    .from(schema.connection)
    .where(and(eq(schema.connection.id, connectionId), eq(schema.connection.userId, userId)))
    .limit(1)
  return row
}

connections.post('/:id/search', externalSearchLimit, async (c) => {
  const user = c.get('user')!
  // Route param is guaranteed by the matched path; hono types it as
  // `string | undefined` when middleware is chained, so cast back.
  const id = c.req.param('id') as string
  const row = await loadConnection(user.id, id)
  if (!row) return c.json({ error: 'Not found' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { query?: unknown; cursor?: unknown }
  const query = typeof body.query === 'string' ? body.query.slice(0, 200) : ''
  const cursor = typeof body.cursor === 'string' ? body.cursor : undefined

  if (row.provider === 'notion') {
    let token: string
    try {
      token = decryptToken(row.accessTokenEnc)
    } catch {
      // Wrong key / corrupted blob — connection is effectively dead.
      // 503 (not 500) so the client knows it's a transient state.
      return c.json({ error: 'Connection unavailable' }, 503)
    }
    const searchArgs: { token: string; query: string; startCursor?: string } = { token, query }
    if (cursor !== undefined) searchArgs.startCursor = cursor
    const { pages, nextCursor } = await searchPages(searchArgs)
    const tiles: PickerTile[] = pages.map((p) => {
      const tile: PickerTile = {
        id: p.id,
        connectionId: row.id,
        provider: 'notion',
        kind: 'page',
        title: p.title,
        lastEditedAt: p.lastEditedTime,
      }
      if (p.iconEmoji) tile.iconEmoji = p.iconEmoji
      if (p.iconUrl) tile.iconUrl = p.iconUrl
      return tile
    })
    return c.json({ tiles, nextCursor })
  }

  if (row.provider === 'drive') {
    let token: string
    try {
      token = await getValidToken(row)
    } catch {
      return c.json({ error: 'Connection unavailable' }, 503)
    }
    const searchArgs: { token: string; query: string; pageToken?: string } = { token, query }
    if (cursor !== undefined) searchArgs.pageToken = cursor
    const { files, nextPageToken } = await driveSearchFiles(searchArgs)
    const tiles: PickerTile[] = files.map((f) => {
      const tile: PickerTile = {
        id: f.id,
        connectionId: row.id,
        provider: 'drive',
        kind: f.mimeType === MIME_FOLDER ? 'folder' : 'file',
        title: f.name,
        mimeType: f.mimeType,
      }
      if (f.iconUrl) tile.iconUrl = f.iconUrl
      if (f.modifiedTime) tile.lastEditedAt = f.modifiedTime
      return tile
    })
    return c.json({ tiles, nextCursor: nextPageToken })
  }

  return c.json({ error: 'Unsupported provider' }, 400)
})

// ---------------------------------------------------------------------------
// POST /api/connections/:id/children
//
// Expand a Notion page to its direct sub-pages. Drives the picker's tree
// view — each tile is expandable; expansion fires this endpoint and the
// result is rendered indented underneath the parent.
// ---------------------------------------------------------------------------
connections.post('/:id/children', externalSearchLimit, async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id') as string
  const row = await loadConnection(user.id, id)
  if (!row) return c.json({ error: 'Not found' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { parentId?: unknown }
  const parentId = typeof body.parentId === 'string' ? body.parentId : null
  if (!parentId) return c.json({ error: 'parentId is required' }, 400)

  if (row.provider === 'notion') {
    let token: string
    try {
      token = decryptToken(row.accessTokenEnc)
    } catch {
      return c.json({ error: 'Connection unavailable' }, 503)
    }
    const children = await getChildPages({ token, parentId })
    const tiles: PickerTile[] = children.map((p) => ({
      id: p.id,
      connectionId: row.id,
      provider: 'notion',
      kind: 'page',
      title: p.title,
    }))
    return c.json({ tiles })
  }

  if (row.provider === 'drive') {
    let token: string
    try {
      token = await getValidToken(row)
    } catch {
      return c.json({ error: 'Connection unavailable' }, 503)
    }
    const children = await driveListFolderChildren({ token, folderId: parentId })
    const tiles: PickerTile[] = children.map((f) => {
      const tile: PickerTile = {
        id: f.id,
        connectionId: row.id,
        provider: 'drive',
        kind: f.mimeType === MIME_FOLDER ? 'folder' : 'file',
        title: f.name,
        mimeType: f.mimeType,
      }
      if (f.iconUrl) tile.iconUrl = f.iconUrl
      if (f.modifiedTime) tile.lastEditedAt = f.modifiedTime
      return tile
    })
    return c.json({ tiles })
  }

  return c.json({ error: 'Unsupported provider' }, 400)
})

connections.get('/:id/recents', async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id')
  const row = await loadConnection(user.id, id)
  if (!row) return c.json({ error: 'Not found' }, 404)

  const recents = await db
    .select({
      externalId: schema.recentExternal.externalId,
      kind: schema.recentExternal.kind,
      title: schema.recentExternal.title,
      iconUrl: schema.recentExternal.iconUrl,
      mimeType: schema.recentExternal.mimeType,
      lastUsedAt: schema.recentExternal.lastUsedAt,
    })
    .from(schema.recentExternal)
    .where(eq(schema.recentExternal.connectionId, row.id))
    .orderBy(desc(schema.recentExternal.lastUsedAt))
    .limit(20)

  const tiles: PickerTile[] = recents.map((r) => {
    const tile: PickerTile = {
      id: r.externalId,
      connectionId: row.id,
      provider: row.provider as 'notion' | 'drive',
      kind: r.kind as 'page' | 'file' | 'folder',
      title: r.title,
      lastEditedAt: r.lastUsedAt.toISOString(),
    }
    if (r.iconUrl) tile.iconUrl = r.iconUrl
    return tile
  })
  return c.json({ tiles })
})

// Shared helper for external.ts so the connection lookup + ownership check
// doesn't get duplicated across import / refresh handlers.
export { loadConnection }
