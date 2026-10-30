import {
  extractDriveFileId,
  extractSpotifyRef,
  extractVideoRef,
  extractWebUrl,
  type DriveFileData,
  type DriveFolderData,
  type ImageData,
  type PDFData,
  type SpotifyAlbumData,
  type SpotifyPlaylistData,
  type SpotifyTrackData,
  type VideoClipData,
  type WebPageData,
} from '@moodboard/shared'
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { importDriveFile } from './importers/drive'
import { TokenDecryptError } from './importers/errors'
import { importSpotifyRef } from './importers/spotify'
import { saveImageFromUrl } from './saveImageFromUrl'
import { extractVideoClip } from './video'
import { extractWebPage } from './web'

// One tool for URLs in the MCP — the model doesn't choose between
// add_spotify / add_video / add_web. This dispatcher matches the
// paste-handler priority chain in MoodBoardCanvas.tsx so behaviour
// stays consistent across surfaces: provider-specific URLs always
// trump the generic web fallback.

export type DispatchOk =
  | { kind: 'web'; page: WebPageData; logoImages: ImageData[] }
  | { kind: 'video'; data: VideoClipData }
  | { kind: 'image'; data: ImageData }
  | { kind: 'drive-file'; data: DriveFileData }
  | { kind: 'drive-folder'; data: DriveFolderData }
  | { kind: 'drive-pdf'; data: PDFData }
  | { kind: 'drive-image'; data: ImageData }
  | { kind: 'spotify-playlist'; data: SpotifyPlaylistData }
  | { kind: 'spotify-track'; data: SpotifyTrackData }
  | { kind: 'spotify-album'; data: SpotifyAlbumData }

export type DispatchError = {
  code: 'UNRECOGNISED' | 'CONNECTION_REQUIRED' | 'CONNECTION_DOWN' | 'EXTRACT_FAILED'
  message: string
  // For CONNECTION_REQUIRED — which provider the user needs to connect.
  provider?: 'drive' | 'spotify'
}

export type DispatchResult = { ok: true; result: DispatchOk } | { ok: false; error: DispatchError }

// Look up the user's first available connection for a provider. The
// MCP doesn't take a connection ID — we pick the most-recently-used
// one. Returns null when none exists.
async function findConnection(userId: string, provider: 'drive' | 'spotify') {
  const [row] = await db
    .select()
    .from(schema.connection)
    .where(and(eq(schema.connection.userId, userId), eq(schema.connection.provider, provider)))
    .orderBy(desc(schema.connection.lastUsedAt))
    .limit(1)
  return row ?? null
}

function hasImageExtension(url: string): boolean {
  try {
    const u = new URL(url)
    return /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico)$/i.test(u.pathname.toLowerCase())
  } catch {
    return false
  }
}

export async function routeUrlToImporter(url: string, userId: string): Promise<DispatchResult> {
  const trimmed = url.trim()
  if (!trimmed) {
    return { ok: false, error: { code: 'UNRECOGNISED', message: 'URL is empty' } }
  }

  // 1. Spotify (URI form or open.spotify.com URL)
  const spotifyRef = extractSpotifyRef(trimmed)
  if (spotifyRef) {
    const conn = await findConnection(userId, 'spotify')
    if (!conn) {
      return {
        ok: false,
        error: {
          code: 'CONNECTION_REQUIRED',
          provider: 'spotify',
          message:
            'Spotify is not connected. Visit moodboard.ai and connect Spotify in the dashboard.',
        },
      }
    }
    try {
      const result = await importSpotifyRef({
        userId,
        connectionRow: conn,
        ref: spotifyRef,
      })
      if (result.kind === 'playlist')
        return { ok: true, result: { kind: 'spotify-playlist', data: result.data } }
      if (result.kind === 'track')
        return { ok: true, result: { kind: 'spotify-track', data: result.data } }
      return { ok: true, result: { kind: 'spotify-album', data: result.data } }
    } catch (e) {
      if (e instanceof TokenDecryptError) {
        return {
          ok: false,
          error: {
            code: 'CONNECTION_DOWN',
            provider: 'spotify',
            message: 'Spotify connection is unavailable — reconnect from the dashboard.',
          },
        }
      }
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        error: { code: 'EXTRACT_FAILED', message: `Spotify import failed: ${msg}` },
      }
    }
  }

  // Drive only accepts http(s) URLs — the recogniser doesn't assert a
  // scheme so we filter here.
  if (/^https?:\/\//i.test(trimmed)) {
    // 2. Drive
    const driveFileId = extractDriveFileId(trimmed)
    if (driveFileId) {
      const conn = await findConnection(userId, 'drive')
      if (!conn) {
        return {
          ok: false,
          error: {
            code: 'CONNECTION_REQUIRED',
            provider: 'drive',
            message:
              'Google Drive is not connected. Visit moodboard.ai and connect Drive in the dashboard.',
          },
        }
      }
      try {
        const result = await importDriveFile({ userId, connectionRow: conn, fileId: driveFileId })
        if (result.kind === 'file')
          return { ok: true, result: { kind: 'drive-file', data: result.data } }
        if (result.kind === 'folder')
          return { ok: true, result: { kind: 'drive-folder', data: result.data } }
        if (result.kind === 'pdf')
          return { ok: true, result: { kind: 'drive-pdf', data: result.data } }
        return { ok: true, result: { kind: 'drive-image', data: result.data } }
      } catch (e) {
        if (e instanceof TokenDecryptError) {
          return {
            ok: false,
            error: {
              code: 'CONNECTION_DOWN',
              provider: 'drive',
              message: 'Drive connection unavailable — reconnect from the dashboard.',
            },
          }
        }
        const msg = e instanceof Error ? e.message : String(e)
        return {
          ok: false,
          error: { code: 'EXTRACT_FAILED', message: `Drive import failed: ${msg}` },
        }
      }
    }

    // 3. Video (YouTube / TikTok / Instagram / X / Vimeo)
    const videoRef = extractVideoRef(trimmed)
    if (videoRef) {
      try {
        const result = await extractVideoClip(trimmed, userId)
        return { ok: true, result: { kind: 'video', data: result.data } }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          ok: false,
          error: { code: 'EXTRACT_FAILED', message: `Video import failed: ${msg}` },
        }
      }
    }

    // 4. Image-by-extension — path ends in a recognised image suffix.
    if (hasImageExtension(trimmed)) {
      try {
        const data = await saveImageFromUrl(trimmed, userId)
        return { ok: true, result: { kind: 'image', data } }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          ok: false,
          error: { code: 'EXTRACT_FAILED', message: `Image import failed: ${msg}` },
        }
      }
    }

    // 5. Generic web page (catch-all for http(s)).
    const webUrl = extractWebUrl(trimmed)
    if (webUrl) {
      try {
        const result = await extractWebPage(trimmed, userId)
        return {
          ok: true,
          result: { kind: 'web', page: result.page, logoImages: result.logoImages },
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          ok: false,
          error: { code: 'EXTRACT_FAILED', message: `Web import failed: ${msg}` },
        }
      }
    }
  }

  return {
    ok: false,
    error: {
      code: 'UNRECOGNISED',
      message: 'URL was not recognised as a Spotify, Drive, video, image, or web page link.',
    },
  }
}
