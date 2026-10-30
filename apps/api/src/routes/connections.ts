import type { PickerTile } from '@moodboard/shared'
import { and, desc, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { nanoid } from 'nanoid'
import { randomBytes } from 'node:crypto'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { encryptToken } from '../lib/cryptoTokens'
import {
  exchangeCode as driveExchangeCode,
  getValidToken,
  listFolderChildren as driveListFolderChildren,
  searchFiles as driveSearchFiles,
} from '../lib/drive'
import {
  exchangeLinearCode,
  LINEAR_AUTHORIZE_URL,
  LINEAR_SCOPES,
  linearApi,
  linearEnv,
} from '../lib/linear'
import { rateLimit } from '../lib/rateLimit'
import {
  exchangeCode as spotifyExchangeCode,
  getValidToken as spotifyValidToken,
  listMyPlaylists,
  searchTracks,
  SpotifyApiError,
} from '../lib/spotify'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const connections = new Hono<{ Variables: Variables }>()

// Picker / recents are read-heavy; cap to keep provider APIs happy under a
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

function googleEnv(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Google OAuth env vars are not configured')
  }
  return { clientId, clientSecret, redirectUri }
}

function spotifyEnv(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Spotify OAuth env vars are not configured')
  }
  return { clientId, clientSecret, redirectUri }
}

// Spotify scopes — enough to read public + private playlists, individual
// tracks/albums, and the connected user's email (for the connection label).
const SPOTIFY_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-email',
].join(' ')

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

// Upsert a connection by (userId, provider, accountEmail). If the user
// has already connected this provider with the same account email, we
// rotate the stored tokens in-place rather than inserting a duplicate.
// Spotify especially needs this — double-clicking Connect Spotify used
// to create two identical rows because the callback handler had no
// dedup. Multiple accounts with the same email would never legitimately
// exist, so dedup is universally safe.
//
// Returns the connection id (whether existing or freshly inserted).
async function upsertConnection(args: {
  userId: string
  provider: 'drive' | 'spotify' | 'linear'
  accountEmail: string
  accessTokenEnc: string
  refreshTokenEnc: string | null
  expiresAt: Date | null
  scopes: string
  workspaceId?: string | null
  workspaceName?: string | null
}): Promise<string> {
  const [existing] = await db
    .select({ id: schema.connection.id })
    .from(schema.connection)
    .where(
      and(
        eq(schema.connection.userId, args.userId),
        eq(schema.connection.provider, args.provider),
        eq(schema.connection.accountEmail, args.accountEmail),
      ),
    )
    .limit(1)
  if (existing) {
    const updateFields: {
      accessTokenEnc: string
      refreshTokenEnc: string | null
      expiresAt: Date | null
      scopes: string
      lastUsedAt: Date
      workspaceId?: string | null
      workspaceName?: string | null
    } = {
      accessTokenEnc: args.accessTokenEnc,
      refreshTokenEnc: args.refreshTokenEnc,
      expiresAt: args.expiresAt,
      scopes: args.scopes,
      lastUsedAt: new Date(),
    }
    if (args.workspaceId !== undefined) updateFields.workspaceId = args.workspaceId
    if (args.workspaceName !== undefined) updateFields.workspaceName = args.workspaceName
    await db
      .update(schema.connection)
      .set(updateFields)
      .where(eq(schema.connection.id, existing.id))
    return existing.id
  }
  const id = nanoid()
  await db.insert(schema.connection).values({
    id,
    userId: args.userId,
    provider: args.provider,
    accountEmail: args.accountEmail,
    accessTokenEnc: args.accessTokenEnc,
    refreshTokenEnc: args.refreshTokenEnc,
    expiresAt: args.expiresAt,
    scopes: args.scopes,
    workspaceId: args.workspaceId ?? null,
    workspaceName: args.workspaceName ?? null,
  })
  return id
}

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
// required for the user-facing disconnect to succeed.
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
// GET /api/connections/drive/start
//
// Same CSRF cookie pattern as the Spotify start route. Google needs `access_type=offline&prompt=consent` to issue a
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
// State-cookie CSRF check + code exchange. Stores email
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
    const id = await upsertConnection({
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

// ---------------------------------------------------------------------------
// GET /api/connections/spotify/start
//
// Mirrors the drive start route. Spotify uses standard PKCE-less
// authorization-code grant; client_secret lives server-side. `show_dialog=true`
// forces re-consent for users who've previously authorised the app — useful
// if scopes have changed.
// ---------------------------------------------------------------------------
connections.get('/spotify/start', async (c) => {
  const { clientId, redirectUri } = spotifyEnv()
  const state = randomBytes(24).toString('hex')
  setCookie(c, STATE_COOKIE('spotify'), state, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: OAUTH_STATE_TTL_SECONDS,
  })
  const url = new URL('https://accounts.spotify.com/authorize')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SPOTIFY_SCOPES)
  url.searchParams.set('state', state)
  return c.redirect(url.toString())
})

// ---------------------------------------------------------------------------
// GET /api/connections/spotify/callback
//
// Same state-cookie CSRF check + token exchange as the other providers.
// The connected user's email comes from the /me endpoint in spotify.ts's
// exchangeCode helper (uses the freshly-issued access token) so the
// connection card has a usable label.
// ---------------------------------------------------------------------------
connections.get('/spotify/callback', async (c) => {
  const user = c.get('user')!
  const code = c.req.query('code')
  const stateParam = c.req.query('state')
  const stateCookie = getCookie(c, STATE_COOKIE('spotify'))
  deleteCookie(c, STATE_COOKIE('spotify'), { path: '/' })

  if (!code) return callbackHtml(c, { kind: 'error', message: 'Missing code' })
  if (!stateParam || !stateCookie || stateParam !== stateCookie) {
    return callbackHtml(c, { kind: 'error', message: 'Invalid state' })
  }

  try {
    const { clientId, clientSecret, redirectUri } = spotifyEnv()
    const token = await spotifyExchangeCode({ code, clientId, clientSecret, redirectUri })

    const accountEmail = token.email ?? 'Spotify account'
    const id = await upsertConnection({
      userId: user.id,
      provider: 'spotify',
      accountEmail,
      accessTokenEnc: encryptToken(token.accessToken),
      refreshTokenEnc: token.refreshToken ? encryptToken(token.refreshToken) : null,
      expiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000) : null,
      scopes: token.scope ?? SPOTIFY_SCOPES,
    })

    return callbackHtml(c, { kind: 'done', id })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return callbackHtml(c, { kind: 'error', message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/connections/linear/start
//
// Same state-cookie CSRF pattern as the other providers. Unlike them, an
// unconfigured server answers with the popup's error page rather than a bare
// 500 — Linear is optional and the person should see why nothing happened.
// ---------------------------------------------------------------------------
connections.get('/linear/start', async (c) => {
  const env = linearEnv()
  if (!env) {
    return callbackHtml(c, {
      kind: 'error',
      message:
        'Linear isn’t configured on this server (LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET / LINEAR_REDIRECT_URI).',
    })
  }
  const state = randomBytes(24).toString('hex')
  setCookie(c, STATE_COOKIE('linear'), state, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: OAUTH_STATE_TTL_SECONDS,
  })
  const url = new URL(LINEAR_AUTHORIZE_URL)
  url.searchParams.set('client_id', env.clientId)
  url.searchParams.set('redirect_uri', env.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', LINEAR_SCOPES)
  url.searchParams.set('state', state)
  return c.redirect(url.toString())
})

connections.get('/linear/callback', async (c) => {
  const user = c.get('user')!
  const code = c.req.query('code')
  const stateParam = c.req.query('state')
  const stateCookie = getCookie(c, STATE_COOKIE('linear'))
  deleteCookie(c, STATE_COOKIE('linear'), { path: '/' })

  if (!code) {
    return callbackHtml(c, { kind: 'error', message: c.req.query('error') ?? 'Missing code' })
  }
  if (!stateParam || !stateCookie || stateParam !== stateCookie) {
    return callbackHtml(c, { kind: 'error', message: 'Invalid state' })
  }

  try {
    const env = linearEnv()
    if (!env) throw new Error('Linear OAuth env vars are not configured')
    const token = await exchangeLinearCode({ code, ...env })
    const viewer = await linearApi(token.accessToken).viewer()
    const id = await upsertConnection({
      userId: user.id,
      provider: 'linear',
      accountEmail: viewer.email,
      accessTokenEnc: encryptToken(token.accessToken),
      refreshTokenEnc: token.refreshToken ? encryptToken(token.refreshToken) : null,
      expiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000) : null,
      scopes: token.scope ?? LINEAR_SCOPES,
      workspaceId: viewer.workspace.id,
      workspaceName: viewer.workspace.name,
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
// (drive/import, spotify/*) live in external.ts.
// ---------------------------------------------------------------------------

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

  if (row.provider === 'spotify') {
    let token: string
    try {
      token = await spotifyValidToken(row)
    } catch {
      return c.json({ error: 'Connection unavailable' }, 503)
    }
    // Two modes:
    //   empty query → browse the user's own playlists (/me/playlists).
    //   query       → search the Spotify catalog for individual tracks
    //                 (/search?type=track) so the user can drop a single
    //                 song. This is the "search for specific songs" flow.
    try {
      if (query) {
        // `cursor` carries the numeric search offset for track search (the
        // catalog search API paginates by offset, not an opaque cursor).
        const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0
        const { tracks, nextOffset } = await searchTracks({ token, query, offset })
        const tiles: PickerTile[] = tracks.map((t) => {
          const tile: PickerTile = {
            id: t.id,
            connectionId: row.id,
            provider: 'spotify',
            kind: 'page',
            spotifyKind: 'track',
            title: t.name,
          }
          const sub = [t.artists, t.albumName].filter(Boolean).join(' · ')
          if (sub) tile.subtitle = sub
          if (t.coverUrl) tile.iconUrl = t.coverUrl
          return tile
        })
        return c.json({ tiles, nextCursor: nextOffset != null ? String(nextOffset) : undefined })
      }
      const playlistsArgs: { token: string; cursor?: string } = { token }
      if (cursor !== undefined) playlistsArgs.cursor = cursor
      const { playlists, nextCursor } = await listMyPlaylists(playlistsArgs)
      const tiles: PickerTile[] = playlists.map((p) => {
        const tile: PickerTile = {
          id: p.id,
          connectionId: row.id,
          provider: 'spotify',
          kind: 'page', // Reuse the page/file/folder union — Spotify tiles
          // are visually flat (no tree expansion); kind is
          // just for layout, the drawer's onImport handler
          // dispatches by spotifyKind.
          spotifyKind: 'playlist',
          title: p.name,
        }
        if (p.coverUrl) tile.iconUrl = p.coverUrl
        return tile
      })
      return c.json({ tiles, nextCursor: nextCursor ?? undefined })
    } catch (e) {
      if (e instanceof SpotifyApiError) {
        // 401/403 → the user revoked the app; tell the client to reconnect.
        if (e.status === 401 || e.status === 403) {
          return c.json({ error: 'Spotify connection no longer authorised' }, 409)
        }
        console.warn('[connections/search] spotify api error', e.status, e.message)
        return c.json({ error: e.message }, 502)
      }
      console.error('[connections/search] unexpected spotify error', e)
      return c.json({ error: e instanceof Error ? e.message : 'Search failed' }, 502)
    }
  }

  return c.json({ error: 'Unsupported provider' }, 400)
})

// ---------------------------------------------------------------------------
// POST /api/connections/:id/children
//
// Expand a Drive folder to its direct children. Drives the picker's tree
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

  // Spotify has no folder/tree concept; nothing to expand.
  if (row.provider === 'spotify') {
    return c.json({ tiles: [] })
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
      provider: row.provider as 'drive' | 'spotify',
      kind: r.kind as 'page' | 'file' | 'folder',
      title: r.title,
      lastEditedAt: r.lastUsedAt.toISOString(),
    }
    if (r.iconUrl) tile.iconUrl = r.iconUrl
    // Spotify recents stash their sub-kind in mimeType (playlist/track/album)
    // so re-importing dispatches to the right endpoint. Without it the import
    // would default to 'playlist' and a track/album id would 404.
    if (row.provider === 'spotify' && isSpotifySubKind(r.mimeType)) {
      tile.spotifyKind = r.mimeType
    }
    return tile
  })
  return c.json({ tiles })
})

function isSpotifySubKind(v: string | null): v is 'playlist' | 'track' | 'album' {
  return v === 'playlist' || v === 'track' || v === 'album'
}

// Shared helper for external.ts so the connection lookup + ownership check
// doesn't get duplicated across import / refresh handlers.
export { loadConnection }
