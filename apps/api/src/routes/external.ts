import type {
  DriveFileData,
  DriveFolderData,
  ImageData,
  NotionPageData,
  PDFData,
  SpotifyAlbumData,
  SpotifyPlaylistData,
  SpotifyTrackData,
  SpotifyTrackSummary,
  WebPageData,
} from '@moodboard/shared'
import { and, desc, eq, lt } from 'drizzle-orm'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { decryptToken } from '../lib/cryptoTokens'
import {
  extractFile as driveExtractFile,
  extractFolder as driveExtractFolder,
  getValidToken,
  MIME_FOLDER,
} from '../lib/drive'
import { blocksToMarkdown, getPage, getPageBlocks } from '../lib/notion'
import { processPdf } from '../lib/pdfProcessing'
import { rateLimit } from '../lib/rateLimit'
import {
  aggregateEra,
  aggregateGenres,
  type ArtistInfo,
  DISPLAY_TRACK_CAP,
  type ExtractedTrack,
  getAlbum,
  getArtistsBatch,
  getPlaylist,
  getTrack,
  getValidToken as spotifyValidToken,
  type RawAudioFeatures,
  SpotifyApiError,
  trackFeaturesWithAggregate,
} from '../lib/spotify'
import { savePdf, savePdfThumbnail, saveUpload } from '../lib/storage'
import { extractVideoClip, VideoExtractError } from '../lib/video'
import { extractWebPage, WebExtractError } from '../lib/web'
import { loadConnection } from './connections'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const external = new Hono<{ Variables: Variables }>()

// Import + refresh both hit upstream provider APIs and run the
// blocks-to-markdown converter. 20/min/user gives generous headroom for
// adding a handful of pages at once without hitting Notion's own rate cap.
const externalImportLimit = rateLimit({ scope: 'external-import', limit: 20, windowMs: 60_000 })

// Cap of recent items kept per user. Older rows pruned on insert.
const RECENT_PER_USER_CAP = 20

external.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

// ---------------------------------------------------------------------------
// POST /api/external/notion/import
//
// Fetch a page, convert its block tree to markdown, persist a recent_external
// row, and return the wire shape the canvas will mount as a NotionPageNode.
// The frontend takes this object and calls addObject() — the connectionId on
// the data is what powers the refresh endpoint later.
// ---------------------------------------------------------------------------
external.post('/notion/import', externalImportLimit, async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => ({}))) as {
    connectionId?: unknown
    pageId?: unknown
  }
  const connectionId = typeof body.connectionId === 'string' ? body.connectionId : null
  const pageId = typeof body.pageId === 'string' ? body.pageId : null
  if (!connectionId || !pageId) {
    return c.json({ error: 'connectionId and pageId are required' }, 400)
  }

  const connectionRow = await loadConnection(user.id, connectionId)
  if (!connectionRow || connectionRow.provider !== 'notion') {
    return c.json({ error: 'Connection not found' }, 404)
  }

  try {
    const data = await importNotionPage({ userId: user.id, connectionRow, pageId })
    return c.json({ data })
  } catch (e) {
    if (e instanceof TokenDecryptError) {
      return c.json({ error: 'Connection unavailable' }, 503)
    }
    throw e
  }
})

// ---------------------------------------------------------------------------
// POST /api/external/drive/import
//
// Same shape as notion/import — connectionId + fileId. The response is a
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

  const [boardRow] = await db
    .select({ data: schema.board.data })
    .from(schema.board)
    .where(and(eq(schema.board.id, boardId), eq(schema.board.userId, user.id)))
    .limit(1)
  if (!boardRow) return c.json({ error: 'Board not found' }, 404)

  const object = findObject(boardRow.data, objectId)
  if (!object) return c.json({ error: 'Object not found on board' }, 404)

  if (object.type === 'notion-page') {
    const d = object.data as Partial<NotionPageData>
    if (!d.connectionId || !d.pageId) {
      return c.json({ error: 'Object has no connection metadata' }, 400)
    }
    const connectionRow = await loadConnection(user.id, d.connectionId)
    if (!connectionRow || connectionRow.provider !== 'notion') {
      return c.json({ error: 'Connection no longer available' }, 409)
    }
    try {
      const data = await importNotionPage({
        userId: user.id,
        connectionRow,
        pageId: d.pageId,
      })
      return c.json({ data })
    } catch (e) {
      if (e instanceof TokenDecryptError) {
        return c.json({ error: 'Connection unavailable' }, 503)
      }
      throw e
    }
  }

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

// Thrown when a connection's stored token can't be decrypted (key rotated,
// row corrupted). The handler turns this into a 503 so the client can show
// a "connection no longer available" message rather than a 500.
class TokenDecryptError extends Error {
  constructor() {
    super('TokenDecryptError')
    this.name = 'TokenDecryptError'
  }
}

async function importNotionPage(args: {
  userId: string
  connectionRow: { id: string; accessTokenEnc: string; workspaceId: string | null }
  pageId: string
}): Promise<NotionPageData> {
  let token: string
  try {
    token = decryptToken(args.connectionRow.accessTokenEnc)
  } catch {
    throw new TokenDecryptError()
  }
  const [page, blocks] = await Promise.all([
    getPage({ token, pageId: args.pageId }),
    getPageBlocks({ token, pageId: args.pageId }),
  ])
  const markdown = blocksToMarkdown(blocks)
  const fetchedAt = new Date().toISOString()

  await db
    .update(schema.connection)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.connection.id, args.connectionRow.id))

  await upsertRecent({
    userId: args.userId,
    connectionId: args.connectionRow.id,
    externalId: args.pageId,
    kind: 'page',
    title: page.title,
    iconUrl: page.iconUrl,
  })

  const data: NotionPageData = {
    connectionId: args.connectionRow.id,
    pageId: page.id,
    workspaceId: args.connectionRow.workspaceId ?? '',
    title: page.title,
    url: page.url,
    markdown,
    fetchedAt,
  }
  if (page.iconEmoji) data.iconEmoji = page.iconEmoji
  if (page.iconUrl) data.iconUrl = page.iconUrl
  if (page.coverUrl) data.coverUrl = page.coverUrl
  if (page.lastEditedTime) data.lastEditedAt = page.lastEditedTime
  return data
}

type DriveImportResult =
  | { kind: 'file'; data: DriveFileData }
  | { kind: 'folder'; data: DriveFolderData }
  | { kind: 'pdf'; data: PDFData }
  | { kind: 'image'; data: ImageData }

/**
 * Import a Drive file by id. Dispatches by mime — Google-native types and
 * arbitrary files come back as DriveFileData; folders as DriveFolderData;
 * PDFs are saved to PDF_DIR + processed for thumbnail/text and come back as
 * PDFData; images are saved to UPLOADS_DIR and come back as ImageData. The
 * client uses `kind` to decide which factory to call.
 */
async function importDriveFile(args: {
  userId: string
  connectionRow: {
    id: string
    accessTokenEnc: string
    refreshTokenEnc: string | null
    expiresAt: Date | null
  }
  fileId: string
}): Promise<DriveImportResult> {
  let token: string
  try {
    token = await getValidToken(args.connectionRow)
  } catch {
    throw new TokenDecryptError()
  }

  // Probe mime once via the cheap lookup in extractFile / extractFolder. We
  // can't know it ahead of time without a getFile call, but extractFile
  // does that internally.
  // Folders need extractFolder rather than extractFile; we route by hitting
  // a metadata-only call first via extractFile (which dispatches to /export
  // for native types but for folders falls through to 'other' since folders
  // have no exportable content). To avoid the wasted attempt, we do a
  // dedicated getFile here.
  const { getFile: driveGetFile } = await import('../lib/drive')
  const summary = await driveGetFile({ token, fileId: args.fileId })
  const fetchedAt = new Date().toISOString()

  await db
    .update(schema.connection)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.connection.id, args.connectionRow.id))

  if (summary.mimeType === MIME_FOLDER) {
    const folder = await driveExtractFolder({ token, folderId: args.fileId })
    const data: DriveFolderData = {
      connectionId: args.connectionRow.id,
      folderId: folder.summary.id,
      name: folder.summary.name,
      webViewLink: folder.summary.webViewLink,
      childCount: folder.childCount,
      childPreview: folder.childPreview,
      fetchedAt,
    }
    if (folder.summary.modifiedTime) data.modifiedTime = folder.summary.modifiedTime
    await upsertRecent({
      userId: args.userId,
      connectionId: args.connectionRow.id,
      externalId: folder.summary.id,
      kind: 'folder',
      title: folder.summary.name,
      iconUrl: folder.summary.iconUrl,
      mimeType: folder.summary.mimeType,
    })
    return { kind: 'folder', data }
  }

  const extracted = await driveExtractFile({ token, fileId: args.fileId })
  await upsertRecent({
    userId: args.userId,
    connectionId: args.connectionRow.id,
    externalId: extracted.summary.id,
    kind: 'file',
    title: extracted.summary.name,
    iconUrl: extracted.summary.iconUrl,
    mimeType: extracted.summary.mimeType,
  })

  if (extracted.kind === 'pdf') {
    const id = nanoid()
    const savedPdf = await savePdf(extracted.bytes, id)
    await recordAsset(args.userId, savedPdf.filename, 'application/pdf', savedPdf.size, 'pdf')
    let pdfResult
    try {
      pdfResult = await processPdf(extracted.bytes)
    } catch {
      // PDF processing failed — surface the file anyway with no thumbnail
      // or extracted text. The user can still preview via PDFNode's lazy
      // pdfjs render.
      pdfResult = { text: '', thumbnailPng: null, pageCount: 0 }
    }
    let thumbnailUrl = ''
    if (pdfResult.thumbnailPng) {
      const savedThumb = await savePdfThumbnail(pdfResult.thumbnailPng, id)
      await recordAsset(
        args.userId,
        savedThumb.filename,
        'image/png',
        pdfResult.thumbnailPng.byteLength,
        'pdf-thumb',
      )
      thumbnailUrl = `/api/files/${savedThumb.filename}`
    }
    const data: PDFData = {
      url: `/api/files/${savedPdf.filename}`,
      thumbnailUrl,
      extractedText: pdfResult.text,
    }
    if (pdfResult.pageCount) data.pageCount = pdfResult.pageCount
    return { kind: 'pdf', data }
  }

  if (extracted.kind === 'image') {
    const id = nanoid()
    const saved = await saveUpload(extracted.bytes, id, extracted.ext, extracted.summary.mimeType)
    await recordAsset(args.userId, saved.filename, saved.mimeType, saved.size, 'upload')
    const data: ImageData = { url: `/api/files/${saved.filename}` }
    return { kind: 'image', data }
  }

  // Doc / Sheet / Slides / other — package as DriveFileData.
  const data: DriveFileData = {
    connectionId: args.connectionRow.id,
    fileId: extracted.summary.id,
    mimeType: extracted.summary.mimeType,
    name: extracted.summary.name,
    webViewLink: extracted.summary.webViewLink,
    excerpt: extracted.excerpt,
    fetchedAt,
  }
  if (extracted.summary.iconUrl) data.iconUrl = extracted.summary.iconUrl
  if (extracted.summary.modifiedTime) data.modifiedTime = extracted.summary.modifiedTime
  return { kind: 'file', data }
}

// ---------------------------------------------------------------------------
// Spotify import helpers
// ---------------------------------------------------------------------------

type SpotifyRef = { kind: 'playlist' | 'track' | 'album'; id: string }

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

type SpotifyImportResult =
  | { kind: 'playlist'; data: SpotifyPlaylistData }
  | { kind: 'track'; data: SpotifyTrackData }
  | { kind: 'album'; data: SpotifyAlbumData }

// Wrap an enrichment fetch so a failure (deprecated endpoint, missing scope,
// transient 5xx) degrades to the supplied fallback rather than killing the
// whole import. Spotify retired /v1/audio-features for apps registered after
// Nov 2024 — newly-created apps now 404 on that endpoint, so the playlist
// import would otherwise hard-fail for everyone with a fresh app id. We log
// the failure so the cause is visible in API logs but still return the card.
async function safeEnrich<T>(
  fn: () => Promise<T>,
  label: 'audio-features' | 'artists',
  fallback: T,
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[spotify/${label}] enrichment failed, continuing with fallback:`, msg)
    return fallback
  }
}

function emptyAudioFeaturesAgg(): SpotifyPlaylistData['audioFeatures'] {
  return {
    avgEnergy: 0,
    avgValence: 0,
    avgDanceability: 0,
    avgAcousticness: 0,
    avgInstrumentalness: 0,
    avgSpeechiness: 0,
    medianTempo: 0,
    trackCount: 0,
  }
}

// Build one stored display-track row from an extracted track + the audio-
// features lookup + the artist map. Genres come from the track's primary
// artist (genres live on the artist, not the track). Shared by the
// playlist + album import branches so the expandable detail view sees the
// same rich per-track shape for both.
function buildDisplayTrack(
  t: ExtractedTrack,
  perTrack: Map<string, RawAudioFeatures>,
  artists: Map<string, ArtistInfo>,
): SpotifyTrackSummary {
  const row: SpotifyTrackSummary = {
    id: t.id,
    name: t.name,
    artists: t.artists,
    durationMs: t.durationMs,
  }
  if (t.albumName) row.albumName = t.albumName
  if (t.albumReleaseDate) row.albumReleaseDate = t.albumReleaseDate
  if (typeof t.explicit === 'boolean') row.explicit = t.explicit
  if (typeof t.popularity === 'number') row.popularity = t.popularity
  if (t.previewUrl) row.previewUrl = t.previewUrl
  const primaryId = t.artistIds[0]
  const genres = primaryId ? artists.get(primaryId)?.genres : undefined
  if (genres && genres.length > 0) row.genres = genres
  const f = perTrack.get(t.id)
  if (f) {
    row.audioFeatures = {
      energy: f.energy,
      valence: f.valence,
      danceability: f.danceability,
      tempo: f.tempo,
    }
  }
  return row
}

async function importSpotifyRef(args: {
  userId: string
  connectionRow: {
    id: string
    accessTokenEnc: string
    refreshTokenEnc: string | null
    expiresAt: Date | null
  }
  ref: SpotifyRef
}): Promise<SpotifyImportResult> {
  let token: string
  try {
    token = await spotifyValidToken(args.connectionRow)
  } catch {
    throw new TokenDecryptError()
  }
  const fetchedAt = new Date().toISOString()

  await db
    .update(schema.connection)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.connection.id, args.connectionRow.id))

  if (args.ref.kind === 'playlist') {
    const p = await getPlaylist({ token, playlistId: args.ref.id })
    // Fan out the two enrichment calls in parallel. Each is wrapped in
    // safeEnrich so a deprecation / scope miss on one (e.g. audio-features
    // was retired for newly-registered Spotify apps in Nov 2024) doesn't
    // block the import — we degrade to the empty shape and the AD just
    // doesn't see that signal block.
    const primaryArtistIds = p.tracks
      .map((t) => t.artistIds[0])
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    const [featuresResult, artists] = await Promise.all([
      safeEnrich(
        () => trackFeaturesWithAggregate({ trackIds: p.tracks.map((t) => t.id) }),
        'audio-features',
        { aggregate: emptyAudioFeaturesAgg(), perTrack: new Map() },
      ),
      safeEnrich(
        () => getArtistsBatch({ token, artistIds: primaryArtistIds }),
        'artists',
        new Map(),
      ),
    ])
    const { aggregate, perTrack } = featuresResult
    const topGenres = aggregateGenres(p.tracks, artists)
    const era = aggregateEra(p.tracks)
    // Visibility into what Spotify actually returned — when something
    // looks empty on the canvas, this is the line in the API log that
    // says why (e.g. trackCount=0 + featuresCount=0 → editorial playlist
    // with post-Nov-2024 access lock).
    console.log('[spotify/import] playlist', {
      playlistId: p.playlistId,
      name: p.name,
      trackCount: p.trackCount,
      tracksExtracted: p.tracks.length,
      featuresCount: perTrack.size,
      artistsCount: artists.size,
      topGenres: topGenres.length,
      era: era.dominantDecade,
      // What did Spotify actually grant when this connection was made?
      // If `playlist-read-private` is missing, that's the bug.
      connectionScopes: (args.connectionRow as { scopes?: string }).scopes,
    })
    const displayTracks = p.tracks
      .slice(0, DISPLAY_TRACK_CAP)
      .map((t) => buildDisplayTrack(t, perTrack, artists))
    await upsertRecent({
      userId: args.userId,
      connectionId: args.connectionRow.id,
      externalId: p.playlistId,
      kind: 'page',
      title: p.name,
      iconUrl: p.coverUrl,
      // Stash the Spotify sub-kind so re-importing from the Recents list
      // dispatches correctly (otherwise it defaults to 'playlist' and a
      // track/album id 404s). The recents endpoint maps this to spotifyKind.
      mimeType: 'playlist',
    })
    const data: SpotifyPlaylistData = {
      connectionId: args.connectionRow.id,
      playlistId: p.playlistId,
      snapshotId: p.snapshotId,
      name: p.name,
      description: p.description,
      ownerName: p.ownerName,
      trackCount: p.trackCount,
      tracks: displayTracks,
      audioFeatures: aggregate,
      topGenres,
      era,
      url: p.url,
      fetchedAt,
    }
    if (p.coverUrl) data.coverUrl = p.coverUrl
    return { kind: 'playlist', data }
  }

  if (args.ref.kind === 'track') {
    const t = await getTrack({ token, trackId: args.ref.id })
    // Same resilience treatment as the playlist branch.
    const [featuresResult, artists] = await Promise.all([
      safeEnrich(() => trackFeaturesWithAggregate({ trackIds: [t.trackId] }), 'audio-features', {
        aggregate: emptyAudioFeaturesAgg(),
        perTrack: new Map(),
      }),
      t.artistIds[0]
        ? safeEnrich(
            () => getArtistsBatch({ token, artistIds: [t.artistIds[0]!] }),
            'artists',
            new Map(),
          )
        : Promise.resolve(new Map()),
    ])
    const { perTrack } = featuresResult
    const f = perTrack.get(t.trackId)
    const genres = (t.artistIds[0] ? artists.get(t.artistIds[0])?.genres : null) ?? []
    await upsertRecent({
      userId: args.userId,
      connectionId: args.connectionRow.id,
      externalId: t.trackId,
      kind: 'page',
      title: `${t.name} — ${t.artists.join(', ')}`,
      iconUrl: t.albumCoverUrl,
      mimeType: 'track',
    })
    const data: SpotifyTrackData = {
      connectionId: args.connectionRow.id,
      trackId: t.trackId,
      name: t.name,
      artists: t.artists,
      albumName: t.albumName,
      durationMs: t.durationMs,
      genres,
      url: t.url,
      fetchedAt,
    }
    if (t.albumCoverUrl) data.albumCoverUrl = t.albumCoverUrl
    if (t.albumReleaseDate) data.albumReleaseDate = t.albumReleaseDate
    if (typeof t.explicit === 'boolean') data.explicit = t.explicit
    if (typeof t.popularity === 'number') data.popularity = t.popularity
    if (t.previewUrl) data.previewUrl = t.previewUrl
    if (f) {
      data.audioFeatures = {
        energy: f.energy,
        valence: f.valence,
        danceability: f.danceability,
        acousticness: f.acousticness,
        instrumentalness: f.instrumentalness,
        speechiness: f.speechiness,
        tempo: f.tempo,
      }
    }
    return { kind: 'track', data }
  }

  // album — same fan-out as playlist.
  const a = await getAlbum({ token, albumId: args.ref.id })
  const albumPrimaryArtistIds = a.tracks
    .map((t) => t.artistIds[0])
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const [featuresResult, artists] = await Promise.all([
    safeEnrich(
      () => trackFeaturesWithAggregate({ trackIds: a.tracks.map((t) => t.id) }),
      'audio-features',
      { aggregate: emptyAudioFeaturesAgg(), perTrack: new Map() },
    ),
    safeEnrich(
      () => getArtistsBatch({ token, artistIds: albumPrimaryArtistIds }),
      'artists',
      new Map(),
    ),
  ])
  const { aggregate, perTrack } = featuresResult
  const topGenres = aggregateGenres(a.tracks, artists)
  const era = aggregateEra(a.tracks)
  const displayTracks = a.tracks
    .slice(0, DISPLAY_TRACK_CAP)
    .map((t) => buildDisplayTrack(t, perTrack, artists))
  await upsertRecent({
    userId: args.userId,
    connectionId: args.connectionRow.id,
    externalId: a.albumId,
    kind: 'page',
    title: `${a.name} — ${a.artists.join(', ')}`,
    iconUrl: a.coverUrl,
    mimeType: 'album',
  })
  const data: SpotifyAlbumData = {
    connectionId: args.connectionRow.id,
    albumId: a.albumId,
    name: a.name,
    artists: a.artists,
    releaseDate: a.releaseDate,
    trackCount: a.trackCount,
    tracks: displayTracks,
    audioFeatures: aggregate,
    topGenres,
    era,
    url: a.url,
    fetchedAt,
  }
  if (a.coverUrl) data.coverUrl = a.coverUrl
  return { kind: 'album', data }
}

// Inline asset insert so we don't depend on files.ts. Same shape as the
// helper there; kept tiny because all the validation is upstream (we know
// the file came from a verified Drive call, not a user upload).
async function recordAsset(
  userId: string,
  filename: string,
  mimeType: string,
  size: number,
  kind: 'upload' | 'pdf' | 'pdf-thumb',
): Promise<void> {
  await db.insert(schema.asset).values({
    id: nanoid(),
    userId,
    filename,
    mimeType,
    size,
    kind,
  })
}

// Maintain a per-user / per-connection recents row. Updates lastUsedAt if a
// row for the same external resource already exists, inserts otherwise.
// After insert, prunes the user's recents back to RECENT_PER_USER_CAP newest.
async function upsertRecent(args: {
  userId: string
  connectionId: string
  externalId: string
  kind: 'page' | 'file' | 'folder'
  title: string
  iconUrl?: string
  mimeType?: string
}) {
  const existing = await db
    .select({ id: schema.recentExternal.id })
    .from(schema.recentExternal)
    .where(
      and(
        eq(schema.recentExternal.userId, args.userId),
        eq(schema.recentExternal.connectionId, args.connectionId),
        eq(schema.recentExternal.externalId, args.externalId),
      ),
    )
    .limit(1)

  if (existing[0]) {
    await db
      .update(schema.recentExternal)
      .set({
        lastUsedAt: new Date(),
        title: args.title,
        iconUrl: args.iconUrl ?? null,
        mimeType: args.mimeType ?? null,
      })
      .where(eq(schema.recentExternal.id, existing[0].id))
  } else {
    await db.insert(schema.recentExternal).values({
      id: nanoid(),
      userId: args.userId,
      connectionId: args.connectionId,
      externalId: args.externalId,
      kind: args.kind,
      title: args.title,
      iconUrl: args.iconUrl ?? null,
      mimeType: args.mimeType ?? null,
    })
  }

  // Prune. Order by lastUsedAt desc, find the cap-th newest, delete anything
  // older than its lastUsedAt for this user. Two-step because Drizzle's
  // delete doesn't take a correlated subquery directly. Best-effort —
  // failing a prune shouldn't fail the import.
  const newest = await db
    .select({ lastUsedAt: schema.recentExternal.lastUsedAt })
    .from(schema.recentExternal)
    .where(eq(schema.recentExternal.userId, args.userId))
    .orderBy(desc(schema.recentExternal.lastUsedAt))
    .limit(RECENT_PER_USER_CAP)
  if (newest.length === RECENT_PER_USER_CAP) {
    const cutoff = newest[RECENT_PER_USER_CAP - 1]!.lastUsedAt
    await db
      .delete(schema.recentExternal)
      .where(
        and(
          eq(schema.recentExternal.userId, args.userId),
          lt(schema.recentExternal.lastUsedAt, cutoff),
        ),
      )
      .catch(() => {
        // Swallow — older rows can be pruned next time.
      })
  }
}

// Walk a stored board.data jsonb for the object with matching id. Loose
// typing — the stored shape is opaque to the API and we only need a couple
// of fields to dispatch on.
function findObject(
  data: unknown,
  objectId: string,
): { type: string; data: Record<string, unknown> } | null {
  if (!data || typeof data !== 'object') return null
  const objects = (data as { objects?: unknown[] }).objects
  if (!Array.isArray(objects)) return null
  for (const o of objects) {
    if (!o || typeof o !== 'object') continue
    const obj = o as { id?: unknown; type?: unknown; data?: unknown }
    if (
      obj.id === objectId &&
      typeof obj.type === 'string' &&
      obj.data &&
      typeof obj.data === 'object'
    ) {
      return { type: obj.type, data: obj.data as Record<string, unknown> }
    }
  }
  return null
}
