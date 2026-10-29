import type { WebPageData } from '@moodboard/shared'
import { Hono } from 'hono'
import type { AuthSession, AuthUser } from '../auth'
import { loadBoardObject } from '../lib/boardObjects'
import { importDriveFile } from '../lib/importers/drive'
import { TokenDecryptError } from '../lib/importers/errors'
import { importSpotifyRef, type SpotifyRef } from '../lib/importers/spotify'
import { rateLimit } from '../lib/rateLimit'
import { SpotifyApiError } from '../lib/spotify'
import { extractVideoClip, VideoExtractError } from '../lib/video'
import { extractWebPage, WebExtractError } from '../lib/web'
import { loadConnection } from './connections'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const external = new Hono<{ Variables: Variables }>()

// Import + refresh both hit upstream provider APIs. 20/min/user gives
// generous headroom for adding a handful of items at once without hitting
// provider rate caps.
const externalImportLimit = rateLimit({ scope: 'external-import', limit: 20, windowMs: 60_000 })

external.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

// ---------------------------------------------------------------------------
// POST /api/external/drive/import
//
// Body: connectionId + fileId. The response is a
// discriminated union by `kind`:
//   - 'file'   → DriveFileData (Doc, Sheet, Slides, or other-uncovered mime)
//   - 'folder' → DriveFolderData
//   - 'pdf'    → PDFData (saved to PDF_DIR, mounts as PDFNode)
//   - 'image'  → ImageData (saved to UPLOADS_DIR, mounts as ImageNode)
//
// PDFs and images route through the existing storage helpers so they end
// up indistinguishable from manually uploaded files. The DriveFileNode is
// only for Google-native types and arbitrary non-routable mimes.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// POST /api/external/web/import
//
// Public-URL importer. No connection required — the server fetches the
// page directly with SSRF guards (scheme allowlist + private-IP block +
// response cap). Returns the page card data plus 0–3 logo image objects;
// the client mounts the card at the cursor and stacks the logos adjacent.
// ---------------------------------------------------------------------------
external.post('/web/import', externalImportLimit, async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => ({}))) as { url?: unknown }
  const url = typeof body.url === 'string' ? body.url : null
  if (!url) {
    return c.json({ error: 'url is required' }, 400)
  }
  try {
    const result = await extractWebPage(url, user.id)
    return c.json({ page: result.page, logoImages: result.logoImages })
  } catch (e) {
    if (e instanceof WebExtractError) {
      const status =
        e.code === 'BAD_URL' || e.code === 'PRIVATE_HOST'
          ? 400
          : e.code === 'TIMEOUT'
            ? 504
            : e.code === 'TOO_LARGE'
              ? 413
              : e.code === 'NOT_HTML'
                ? 415
                : 502
      return c.json({ error: e.message, code: e.code }, status)
    }
    throw e
  }
})

// ---------------------------------------------------------------------------
// POST /api/external/video/import
//
// Public-URL video importer (YouTube / TikTok / Instagram / X / Vimeo). No
// connection — yt-dlp handles public-content access. Pulls metadata + the
// platform thumbnail, and (if OPENAI_API_KEY is set) the audio → a Whisper
// transcript. Returns a single VideoClipData the client mounts as a
// VideoClipNode.
// ---------------------------------------------------------------------------
external.post('/video/import', externalImportLimit, async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => ({}))) as { url?: unknown }
  const url = typeof body.url === 'string' ? body.url : null
  if (!url) {
    return c.json({ error: 'url is required' }, 400)
  }
  try {
    const result = await extractVideoClip(url, user.id)
    return c.json({ data: result.data })
  } catch (e) {
    if (e instanceof VideoExtractError) {
      const status =
        e.code === 'BAD_URL' || e.code === 'PRIVATE_HOST'
          ? 400
          : e.code === 'TIMEOUT'
            ? 504
            : e.code === 'YTDLP_MISSING'
              ? 501
              : 502
      return c.json({ error: e.message, code: e.code }, status)
    }
    throw e
  }
})

external.post('/drive/import', externalImportLimit, async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => ({}))) as {
    connectionId?: unknown
    fileId?: unknown
  }
  const connectionId = typeof body.connectionId === 'string' ? body.connectionId : null
  const fileId = typeof body.fileId === 'string' ? body.fileId : null
  if (!connectionId || !fileId) {
    return c.json({ error: 'connectionId and fileId are required' }, 400)
  }

  const connectionRow = await loadConnection(user.id, connectionId)
  if (!connectionRow || connectionRow.provider !== 'drive') {
    return c.json({ error: 'Connection not found' }, 404)
  }

  try {
    const result = await importDriveFile({ userId: user.id, connectionRow, fileId })
    return c.json(result)
  } catch (e) {
    if (e instanceof TokenDecryptError) {
      return c.json({ error: 'Connection unavailable' }, 503)
    }
    throw e
  }
})

// ---------------------------------------------------------------------------
// POST /api/external/spotify/import
//
// Pulls a Spotify playlist / track / album by ref. `ref.kind` discriminates
// what to fetch; the response is shaped per kind. Audio-features are
// aggregated at import time so the canvas object stores ready-to-read
// tonal signal — see lib/spotify.ts:aggregateAudioFeatures.
// ---------------------------------------------------------------------------
external.post('/spotify/import', externalImportLimit, async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => ({}))) as {
    connectionId?: unknown
    ref?: unknown
  }
  const connectionId = typeof body.connectionId === 'string' ? body.connectionId : null
  const ref = isSpotifyRef(body.ref) ? body.ref : null
  if (!connectionId || !ref) {
    console.warn('[spotify/import] bad request body', { connectionId, refValid: ref !== null })
    return c.json({ error: 'connectionId and ref { kind, id } are required' }, 400)
  }

  const connectionRow = await loadConnection(user.id, connectionId)
  if (!connectionRow || connectionRow.provider !== 'spotify') {
    console.warn('[spotify/import] connection not found', {
      connectionId,
      rowExists: connectionRow != null,
      provider: connectionRow?.provider,
    })
    return c.json({ error: 'Connection not found' }, 404)
  }

  try {
    const result = await importSpotifyRef({ userId: user.id, connectionRow, ref })
    return c.json(result)
  } catch (e) {
    if (e instanceof TokenDecryptError) {
      return c.json({ error: 'Connection unavailable' }, 503)
    }
    if (e instanceof SpotifyApiError) {
      console.warn('[spotify/import] spotify api error', {
        status: e.status,
        message: e.message,
        ref,
      })
      // 401/403 from Spotify usually means the user revoked our app in
      // the Spotify dashboard. Surface as 409 so the client can flag the
      // connection as needing reconnect.
      if (e.status === 401 || e.status === 403) {
        return c.json({ error: 'Spotify connection no longer authorised' }, 409)
      }
      if (e.status === 404) {
        return c.json({ error: 'Spotify resource not found' }, 404)
      }
      return c.json({ error: e.message }, 502)
    }
    // Anything else — surface the message so the client toast is useful
    // instead of an opaque "Internal Server Error". Also dump to stderr
    // so we can find it in the API logs.
    console.error('[spotify/import] unexpected error', {
      ref,
      connectionId,
      error: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
    })
    const msg = e instanceof Error ? e.message : 'unknown error'
    return c.json({ error: `Import failed: ${msg}` }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /api/external/refresh
//
// Pull a fresh snapshot for an existing canvas object. The client passes the
// object's id + the board id; we look the object up in the stored board
// data, grab its provider + externalId + connectionId, and re-import. We
// don't mutate the board state on the server — that's the client's job via
// the existing autosave on canvas store mutation, which keeps refresh as a
// pure read.
// ---------------------------------------------------------------------------
external.post('/refresh', externalImportLimit, async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => ({}))) as {
    boardId?: unknown
    objectId?: unknown
  }
  const boardId = typeof body.boardId === 'string' ? body.boardId : null
  const objectId = typeof body.objectId === 'string' ? body.objectId : null
  if (!boardId || !objectId) {
    return c.json({ error: 'boardId and objectId are required' }, 400)
  }

  const stored = await loadBoardObject(boardId, objectId)
  if (!stored) return c.json({ error: 'Object not found on board' }, 404)
  const { object } = stored

  if (object.type === 'drive-file' || object.type === 'drive-folder') {
    const d = object.data as { connectionId?: string; fileId?: string; folderId?: string }
    const fileId = d.fileId ?? d.folderId
    if (!d.connectionId || !fileId) {
      return c.json({ error: 'Object has no connection metadata' }, 400)
    }
    const connectionRow = await loadConnection(user.id, d.connectionId)
    if (!connectionRow || connectionRow.provider !== 'drive') {
      return c.json({ error: 'Connection no longer available' }, 409)
    }
    try {
      const result = await importDriveFile({ userId: user.id, connectionRow, fileId })
      // Refresh returns the same discriminated shape so the client knows
      // whether the swapped data is still the same kind. A doc that turned
      // into a folder shouldn't auto-mutate the canvas object type, but
      // surfacing the kind here lets us add that check later.
      return c.json(result)
    } catch (e) {
      if (e instanceof TokenDecryptError) {
        return c.json({ error: 'Connection unavailable' }, 503)
      }
      throw e
    }
  }

  if (object.type === 'web-page') {
    const d = object.data as Partial<WebPageData>
    if (!d.url) {
      return c.json({ error: 'Object has no source URL' }, 400)
    }
    try {
      const result = await extractWebPage(d.url, user.id)
      // The logo images on a refresh are returned for completeness, but
      // the client only swaps the card data — the original logo image
      // objects on the canvas keep their identity. A user who wants the
      // fresh logos can delete + re-paste.
      return c.json({ kind: 'web-page', data: result.page, logoImages: result.logoImages })
    } catch (e) {
      if (e instanceof WebExtractError) {
        return c.json({ error: e.message, code: e.code }, 502)
      }
      throw e
    }
  }

  if (
    object.type === 'spotify-playlist' ||
    object.type === 'spotify-track' ||
    object.type === 'spotify-album'
  ) {
    const d = object.data as {
      connectionId?: string
      playlistId?: string
      trackId?: string
      albumId?: string
    }
    const ref = spotifyRefFromCanvasObject(object.type, d)
    if (!d.connectionId || !ref) {
      return c.json({ error: 'Object has no Spotify ref' }, 400)
    }
    const connectionRow = await loadConnection(user.id, d.connectionId)
    if (!connectionRow || connectionRow.provider !== 'spotify') {
      return c.json({ error: 'Connection no longer available' }, 409)
    }
    try {
      const result = await importSpotifyRef({ userId: user.id, connectionRow, ref })
      return c.json(result)
    } catch (e) {
      if (e instanceof TokenDecryptError) {
        return c.json({ error: 'Connection unavailable' }, 503)
      }
      if (e instanceof SpotifyApiError) {
        if (e.status === 401 || e.status === 403) {
          return c.json({ error: 'Spotify connection no longer authorised' }, 409)
        }
        return c.json({ error: e.message }, 502)
      }
      throw e
    }
  }

  if (object.type === 'video-clip') {
    const d = object.data as { url?: string }
    if (!d.url) {
      return c.json({ error: 'Object has no source URL' }, 400)
    }
    try {
      const result = await extractVideoClip(d.url, user.id)
      return c.json({ kind: 'video-clip', data: result.data })
    } catch (e) {
      if (e instanceof VideoExtractError) {
        return c.json({ error: e.message, code: e.code }, 502)
      }
      throw e
    }
  }

  return c.json({ error: 'Unsupported object type for refresh' }, 400)
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isSpotifyRef(v: unknown): v is SpotifyRef {
  if (!v || typeof v !== 'object') return false
  const r = v as { kind?: unknown; id?: unknown }
  return (
    (r.kind === 'playlist' || r.kind === 'track' || r.kind === 'album') &&
    typeof r.id === 'string' &&
    r.id.length > 0
  )
}

// Reconstruct a SpotifyRef from a canvas object's stored data — used by
// the refresh path. Playlists carry `playlistId`, tracks `trackId`, albums
// `albumId`. Returns null when the field is missing (caller surfaces 400).
function spotifyRefFromCanvasObject(
  type: 'spotify-playlist' | 'spotify-track' | 'spotify-album',
  d: { playlistId?: string; trackId?: string; albumId?: string },
): SpotifyRef | null {
  if (type === 'spotify-playlist' && d.playlistId) return { kind: 'playlist', id: d.playlistId }
  if (type === 'spotify-track' && d.trackId) return { kind: 'track', id: d.trackId }
  if (type === 'spotify-album' && d.albumId) return { kind: 'album', id: d.albumId }
  return null
}
