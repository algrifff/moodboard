// Spotify Web API wrapper + audio-features aggregation.
//
// Same shape as apps/api/src/lib/drive.ts — no SDK, just fetch against the
// narrow surface the importer needs:
//
//   POST https://accounts.spotify.com/api/token   — OAuth code exchange + refresh
//   GET  /v1/me                                    — account email for the connection label
//   GET  /v1/playlists/{id}                       — playlist metadata + snapshot_id
//   GET  /v1/playlists/{id}/tracks?limit=100&offset — paginated tracks
//   GET  /v1/tracks/{id}                          — single track
//   GET  /v1/albums/{id}                          — album metadata + tracks
//   GET  /v1/audio-features?ids={comma-sep}       — batched audio features (max 100 ids)
//   GET  /v1/artists?ids={comma-sep}              — batched artist metadata + genres (max 50 ids)
//
// Spotify access tokens expire in 1h; refresh tokens are long-lived. Mirrors
// drive.ts: getValidToken decrypts, refreshes if stale, persists the new
// access token back to the connection row.
//
// Genre & era signal — Spotify doesn't attach genres to tracks; they live on
// the artist object. We batch-fetch the unique primary-artist set across a
// playlist/album, count genre frequency weighted by track occurrence, and
// surface the top N to the AD as "genre vibe" context. Release era is
// aggregated by decade from per-track album release dates.

import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { decryptToken, encryptToken } from './cryptoTokens'
import { fetchAudioFeatures as fetchReccoBeatsAudioFeatures } from './reccobeats'
import {
  aggregateAudioFeatures,
  aggregateEra,
  aggregateGenres,
  ARTISTS_BATCH,
  DISPLAY_TRACK_CAP,
  TOP_GENRES_CAP,
  type ArtistInfo,
  type AudioFeaturesAgg,
  type EraAgg,
  type ExtractedTrack,
  type RawAudioFeatures,
} from './spotifyAggregates'

const SPOTIFY_API = 'https://api.spotify.com/v1'
const OAUTH_TOKEN_URL = 'https://accounts.spotify.com/api/token'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpotifyTokenResponse = {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  scope?: string
  email?: string
}

type RawTrack = {
  id: string | null
  name: string
  duration_ms: number
  // 'track' | 'episode' — a playlist row's entry can be a podcast episode.
  // Episodes lack artists/audio-features, so we skip them on import.
  type?: string
  explicit?: boolean
  popularity?: number
  preview_url?: string | null
  artists?: { id: string; name: string }[]
  album?: { name: string; release_date?: string; images?: { url: string }[] }
}

// One row in a playlist's item list. Spotify migrated the entry field from
// `track` (now deprecated) to `item` in late 2024 — apps registered after
// the cutoff get the song on `item` and `null` on `track`. We read `item`
// first and fall back to `track` for older apps / cached responses.
type PlaylistItemObject = {
  is_local?: boolean
  item?: RawTrack | null
  track?: RawTrack | null
}

// Paging object shared by the playlist body's `items`/`tracks` field and the
// standalone /playlists/{id}/items endpoint.
type PlaylistPage = {
  total?: number
  next?: string | null
  items?: PlaylistItemObject[]
}

class SpotifyApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'SpotifyApiError'
  }
}

export { SpotifyApiError }

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function spotifyFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${SPOTIFY_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new SpotifyApiError(res.status, undefined, `Spotify ${path}: ${body}`)
  }
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export async function exchangeCode(args: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
}): Promise<SpotifyTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.redirectUri,
  })
  // Spotify uses Basic auth on the token endpoint, not body params for the
  // client credentials (unlike Google).
  const basic = Buffer.from(`${args.clientId}:${args.clientSecret}`).toString('base64')
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: params.toString(),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new SpotifyApiError(res.status, undefined, `OAuth exchange failed: ${body}`)
  }
  const raw = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    scope?: string
  }
  // Fetch the connected user's email so the connection card has a label.
  // Account scope `user-read-email` is required for this; if it's not in
  // the granted scopes the request 403s and we fall back to a generic
  // label upstream.
  let email: string | undefined
  try {
    const me = await spotifyFetch<{ email?: string }>('/me', raw.access_token)
    email = me.email
  } catch {
    // Best-effort label fetch. Upstream uses 'Spotify account' fallback.
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresIn: raw.expires_in,
    scope: raw.scope,
    email,
  }
}

/**
 * Decrypt + (if stale) refresh the connection's access token. Mirrors
 * drive.ts:getValidToken. Spotify's refresh response sometimes includes a
 * new refresh_token, sometimes not — we persist the new one when present
 * and leave the existing one untouched otherwise.
 */
export async function getValidToken(connectionRow: {
  id: string
  accessTokenEnc: string
  refreshTokenEnc: string | null
  expiresAt: Date | null
}): Promise<string> {
  const access = decryptToken(connectionRow.accessTokenEnc)
  const now = Date.now()
  const fudgeMs = 60_000
  if (!connectionRow.expiresAt || connectionRow.expiresAt.getTime() - fudgeMs > now) {
    return access
  }
  if (!connectionRow.refreshTokenEnc) return access
  const refresh = decryptToken(connectionRow.refreshTokenEnc)
  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new SpotifyApiError(500, 'SPOTIFY_ENV_MISSING', 'Spotify OAuth env vars not configured')
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh })
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: params.toString(),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new SpotifyApiError(res.status, undefined, `Refresh failed: ${body}`)
  }
  const raw = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }
  const expiresAt = raw.expires_in ? new Date(now + raw.expires_in * 1000) : null
  const updateFields: {
    accessTokenEnc: string
    expiresAt: Date | null
    lastUsedAt: Date
    refreshTokenEnc?: string
  } = {
    accessTokenEnc: encryptToken(raw.access_token),
    expiresAt,
    lastUsedAt: new Date(),
  }
  if (raw.refresh_token) updateFields.refreshTokenEnc = encryptToken(raw.refresh_token)
  await db
    .update(schema.connection)
    .set(updateFields)
    .where(eq(schema.connection.id, connectionRow.id))
  return raw.access_token
}

// ---------------------------------------------------------------------------
// Playlist / track / album fetch
// ---------------------------------------------------------------------------

type PlaylistRaw = {
  id: string
  name: string
  description: string | null
  snapshot_id: string
  external_urls: { spotify: string }
  owner: { display_name?: string | null; id: string }
  images: { url: string }[] | null
  // `items` is the current field (Spotify, late 2024). `tracks` is the
  // deprecated alias and returns null for apps registered after the cutoff
  // even when `items` is fully populated — which is exactly why reading
  // only `tracks` showed "0 tracks" for the user's own playlists. We read
  // `items` first, fall back to `tracks`. Both can be absent for truly
  // restricted editorial playlists (Discover Weekly etc.), which we treat
  // as an empty playlist rather than crashing.
  items?: PlaylistPage | null
  tracks?: PlaylistPage | null
}

// Re-exported from spotifyAggregates so callers don't need to change paths
// and the pure types stay testable without dragging the HTTP layer in.
export type {
  ArtistInfo,
  AudioFeaturesAgg,
  EraAgg,
  ExtractedTrack,
  RawAudioFeatures,
} from './spotifyAggregates'
export {
  aggregateAudioFeatures,
  aggregateEra,
  aggregateGenres,
  ARTISTS_BATCH,
  DISPLAY_TRACK_CAP,
  TOP_GENRES_CAP,
} from './spotifyAggregates'

export type PlaylistExtract = {
  playlistId: string
  snapshotId: string
  name: string
  description: string
  ownerName: string
  coverUrl?: string
  trackCount: number
  // FULL tracklist — caller can cap for display.
  tracks: ExtractedTrack[]
  url: string
}

export async function getPlaylist(args: {
  token: string
  playlistId: string
}): Promise<PlaylistExtract> {
  const raw = await spotifyFetch<PlaylistRaw>(`/playlists/${args.playlistId}`, args.token)
  const tracks: ExtractedTrack[] = []
  // Pull a song out of one playlist row. Prefer the current `item` field;
  // fall back to the deprecated `track` field for older apps. Skip podcast
  // episodes (no artists / audio features) and local files (null id).
  const pushItems = (items: PlaylistItemObject[] | undefined | null) => {
    if (!items) return
    for (const row of items) {
      const t = row?.item ?? row?.track
      if (!t || !t.id) continue
      if (t.type === 'episode') continue
      const artists = Array.isArray(t.artists) ? t.artists : []
      const entry: ExtractedTrack = {
        id: t.id,
        name: t.name,
        artists: artists.map((a) => a.name),
        artistIds: artists.map((a) => a.id).filter((id): id is string => Boolean(id)),
        durationMs: t.duration_ms,
      }
      if (t.album?.name) entry.albumName = t.album.name
      if (t.album?.release_date) entry.albumReleaseDate = t.album.release_date
      if (typeof t.explicit === 'boolean') entry.explicit = t.explicit
      if (typeof t.popularity === 'number') entry.popularity = t.popularity
      if (t.preview_url) entry.previewUrl = t.preview_url
      tracks.push(entry)
    }
  }
  // Read the new `items` field first, then the deprecated `tracks` alias.
  const body = raw.items ?? raw.tracks
  pushItems(body?.items)
  let next: string | null | undefined = body?.next
  const total = raw.items?.total ?? raw.tracks?.total
  // Fallback: if the embedded page came back empty, hit the standalone
  // /playlists/{id}/items endpoint. Same `item`/`track` row shape. This
  // rescues the case where the playlist body omits the page but the
  // dedicated endpoint still serves it (and is the documented, current
  // way to page playlist contents).
  if (tracks.length === 0 && !next) {
    try {
      const fallback = await spotifyFetch<PlaylistPage>(
        `/playlists/${args.playlistId}/items?limit=50`,
        args.token,
      )
      pushItems(fallback.items)
      next = fallback.next ?? null
    } catch (e) {
      console.warn(
        '[spotify/getPlaylist] fallback /items failed',
        e instanceof Error ? e.message : e,
      )
    }
  }
  // Walk the `next` cursor for playlists longer than one page.
  while (next) {
    const page = await fetch(next, {
      headers: { Authorization: `Bearer ${args.token}` },
    })
    if (!page.ok) break
    const json = (await page.json()) as PlaylistPage
    pushItems(json.items)
    next = json.next ?? null
  }
  return {
    playlistId: raw.id,
    snapshotId: raw.snapshot_id,
    name: raw.name,
    description: raw.description ?? '',
    ownerName: raw.owner.display_name ?? raw.owner.id,
    ...(raw.images?.[0]?.url ? { coverUrl: raw.images[0].url } : {}),
    trackCount: total ?? tracks.length,
    tracks,
    url: raw.external_urls.spotify,
  }
}

export type TrackExtract = {
  trackId: string
  name: string
  artists: string[]
  artistIds: string[]
  albumName: string
  albumCoverUrl?: string
  albumReleaseDate?: string
  durationMs: number
  explicit?: boolean
  popularity?: number
  previewUrl?: string
  url: string
}

export async function getTrack(args: { token: string; trackId: string }): Promise<TrackExtract> {
  const raw = await spotifyFetch<RawTrack & { external_urls: { spotify: string } }>(
    `/tracks/${args.trackId}`,
    args.token,
  )
  const artistsArr = Array.isArray(raw.artists) ? raw.artists : []
  const out: TrackExtract = {
    trackId: raw.id!,
    name: raw.name,
    artists: artistsArr.map((a) => a.name),
    artistIds: artistsArr.map((a) => a.id).filter((id): id is string => Boolean(id)),
    albumName: raw.album?.name ?? '',
    durationMs: raw.duration_ms,
    url: raw.external_urls.spotify,
  }
  if (raw.album?.images?.[0]?.url) out.albumCoverUrl = raw.album.images[0].url
  if (raw.album?.release_date) out.albumReleaseDate = raw.album.release_date
  if (typeof raw.explicit === 'boolean') out.explicit = raw.explicit
  if (typeof raw.popularity === 'number') out.popularity = raw.popularity
  if (raw.preview_url) out.previewUrl = raw.preview_url
  return out
}

type AlbumRaw = {
  id: string
  name: string
  release_date: string
  total_tracks: number
  external_urls: { spotify: string }
  artists: { id: string; name: string }[]
  images: { url: string }[] | null
  tracks?: { items?: RawTrack[]; next?: string | null } | null
}

export type AlbumExtract = {
  albumId: string
  name: string
  artists: string[]
  artistIds: string[]
  releaseDate: string
  coverUrl?: string
  trackCount: number
  // Same rich shape as PlaylistExtract.tracks so the import path can call
  // the same genre/era helpers uniformly.
  tracks: ExtractedTrack[]
  url: string
}

export async function getAlbum(args: { token: string; albumId: string }): Promise<AlbumExtract> {
  const raw = await spotifyFetch<AlbumRaw>(`/albums/${args.albumId}`, args.token)
  // Album-level release date applies to every track when Spotify omits per-
  // track album metadata (album-tracks endpoint strips it, only including
  // it on /tracks/{id}).
  const albumReleaseDate = raw.release_date
  const tracks: ExtractedTrack[] = []
  const pushTrack = (t: RawTrack | undefined | null) => {
    if (!t || !t.id) return
    const row: ExtractedTrack = {
      id: t.id,
      name: t.name,
      artists: Array.isArray(t.artists) ? t.artists.map((a) => a.name) : [],
      artistIds: Array.isArray(t.artists)
        ? t.artists.map((a) => a.id).filter((id): id is string => Boolean(id))
        : [],
      durationMs: t.duration_ms,
      albumName: raw.name,
      albumReleaseDate,
    }
    if (typeof t.explicit === 'boolean') row.explicit = t.explicit
    if (typeof t.popularity === 'number') row.popularity = t.popularity
    if (t.preview_url) row.previewUrl = t.preview_url
    tracks.push(row)
  }
  for (const t of raw.tracks?.items ?? []) pushTrack(t)
  // Albums rarely paginate (a 30-track album fits in one page), but if Spotify
  // returns a `next` we walk it for completeness.
  let next: string | null | undefined = raw.tracks?.next
  while (next) {
    const page = await fetch(next, {
      headers: { Authorization: `Bearer ${args.token}` },
    })
    if (!page.ok) break
    const json = (await page.json()) as { items?: RawTrack[]; next?: string | null }
    for (const t of json.items ?? []) pushTrack(t)
    next = json.next ?? null
  }
  return {
    albumId: raw.id,
    name: raw.name,
    artists: raw.artists.map((a) => a.name),
    artistIds: raw.artists.map((a) => a.id).filter(Boolean),
    releaseDate: raw.release_date,
    ...(raw.images?.[0]?.url ? { coverUrl: raw.images[0].url } : {}),
    trackCount: raw.total_tracks ?? tracks.length,
    tracks,
    url: raw.external_urls.spotify,
  }
}

// ---------------------------------------------------------------------------
// Artists (genre source) + aggregation
// ---------------------------------------------------------------------------

type RawArtist = {
  id: string
  name: string
  genres: string[]
  popularity?: number
  images?: { url: string }[]
}

/**
 * Batch-fetch artist metadata for the given artist ids. The /v1/artists?ids=
 * endpoint caps at 50 ids per call; we chunk + concat. Returns a sparse map
 * (skipped ids stay absent so the caller can decide how to handle gaps).
 */
export async function getArtistsBatch(args: {
  token: string
  artistIds: string[]
}): Promise<Map<string, ArtistInfo>> {
  const out = new Map<string, ArtistInfo>()
  // Dedup first — playlists with the same artist on multiple tracks would
  // otherwise refetch the same row.
  const uniq = Array.from(new Set(args.artistIds.filter((id) => id && id.length > 0)))
  for (let i = 0; i < uniq.length; i += ARTISTS_BATCH) {
    const batch = uniq.slice(i, i + ARTISTS_BATCH)
    if (batch.length === 0) continue
    const path = `/artists?ids=${batch.join(',')}`
    const raw = await spotifyFetch<{ artists: (RawArtist | null)[] }>(path, args.token)
    for (const a of raw.artists) {
      if (!a || !a.id) continue
      const info: ArtistInfo = {
        id: a.id,
        name: a.name,
        genres: a.genres ?? [],
      }
      if (typeof a.popularity === 'number') info.popularity = a.popularity
      if (a.images && a.images[0]?.url) info.imageUrl = a.images[0].url
      out.set(a.id, info)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Audio features
// ---------------------------------------------------------------------------

// Convenience for the playlist/album importers: takes a track list, fetches
// audio features, returns both the aggregate AND a per-track lookup so the
// display rows can carry their own features.
//
// Audio features come from ReccoBeats, not Spotify — Spotify retired
// /v1/audio-features for apps registered after 2024-11-27 (403 Forbidden).
// ReccoBeats is a free, no-auth drop-in keyed by Spotify track id. See
// lib/reccobeats.ts. No Spotify token is needed for this step.
export async function trackFeaturesWithAggregate(args: { trackIds: string[] }): Promise<{
  aggregate: AudioFeaturesAgg
  perTrack: Map<string, RawAudioFeatures>
}> {
  const perTrack = await fetchReccoBeatsAudioFeatures(args.trackIds)
  const aggregate = aggregateAudioFeatures([...perTrack.values()])
  return { aggregate, perTrack }
}

// ---------------------------------------------------------------------------
// /v1/me/playlists — picker browsing
// ---------------------------------------------------------------------------

// Page size for the /v1/me/playlists pull. 50 is Spotify's max per page.
// The picker drawer's infinite-scroll sentinel triggers `next` pulls when
// the user scrolls near the bottom.
const ME_PLAYLISTS_PAGE = 50

type MyPlaylistsRaw = {
  items: {
    id: string
    name: string
    owner: { display_name?: string | null; id: string }
    images: { url: string }[]
  }[]
  next: string | null
}

export type MyPlaylistTile = {
  id: string
  name: string
  ownerName: string
  coverUrl?: string
}

/**
 * Fetch one page of the connected user's playlists (owned + followed).
 * `cursor` is Spotify's `next` URL from a previous page; omit on first call.
 * Returns the tiles + the cursor for the next page (or null when done).
 */
export async function listMyPlaylists(args: {
  token: string
  cursor?: string
}): Promise<{ playlists: MyPlaylistTile[]; nextCursor: string | null }> {
  // First call hits the standard path; subsequent calls follow the `next`
  // absolute URL Spotify returns. We use fetch directly for the cursor
  // case since spotifyFetch hard-codes the base prefix.
  const url = args.cursor ?? `${SPOTIFY_API}/me/playlists?limit=${ME_PLAYLISTS_PAGE}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${args.token}` } })
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new SpotifyApiError(res.status, undefined, `Spotify /me/playlists: ${body}`)
  }
  const raw = (await res.json()) as MyPlaylistsRaw
  const playlists: MyPlaylistTile[] = []
  for (const p of raw.items) {
    // Spotify occasionally returns null entries when a playlist the user
    // follows has been deleted by its owner. Defensive guard.
    if (!p || !p.id) continue
    const tile: MyPlaylistTile = {
      id: p.id,
      name: p.name,
      ownerName: p.owner.display_name ?? p.owner.id,
    }
    if (p.images[0]?.url) tile.coverUrl = p.images[0].url
    playlists.push(tile)
  }
  return { playlists, nextCursor: raw.next }
}

// ---------------------------------------------------------------------------
// /v1/search — track catalog search (drop individual songs)
// ---------------------------------------------------------------------------

export type TrackSearchTile = {
  id: string
  name: string
  artists: string
  albumName: string
  coverUrl?: string
}

// Spotify's /v1/search caps `limit` at 10 per item type (Range: 0–10,
// default 5) — unlike most list endpoints which allow 50. Exceeding it
// returns 400 "Invalid limit". `offset` ranges 0–1000 so we page in 10s.
const SEARCH_LIMIT = 10

/**
 * Search the Spotify catalog for tracks matching `query`. Returns lightweight
 * tiles for the picker; the full per-track data (audio features, genres) is
 * fetched on import via importSpotifyRef. `offset` paginates (Spotify caps
 * search offset at 1000), pulling SEARCH_LIMIT (10) per page.
 */
export async function searchTracks(args: {
  token: string
  query: string
  limit?: number
  offset?: number
}): Promise<{ tracks: TrackSearchTile[]; nextOffset: number | null }> {
  const limit = Math.min(args.limit ?? SEARCH_LIMIT, SEARCH_LIMIT)
  const offset = args.offset ?? 0
  // Encode `q` with encodeURIComponent, NOT URLSearchParams — the latter
  // encodes spaces as `+`, which Spotify's /v1/search rejects with 400
  // ("daft+punk" → 400, "daft%20punk" → 200). The other params are
  // space-free so we assemble the query string directly.
  const q = encodeURIComponent(args.query)
  const raw = await spotifyFetch<{
    tracks?: {
      items?: (RawTrack & { album?: { name?: string; images?: { url: string }[] } })[]
      total?: number
    }
  }>(`/search?q=${q}&type=track&limit=${limit}&offset=${offset}`, args.token)
  const items = raw.tracks?.items ?? []
  const tracks: TrackSearchTile[] = []
  for (const t of items) {
    if (!t || !t.id) continue
    const tile: TrackSearchTile = {
      id: t.id,
      name: t.name,
      artists: Array.isArray(t.artists) ? t.artists.map((a) => a.name).join(', ') : '',
      albumName: t.album?.name ?? '',
    }
    if (t.album?.images?.[0]?.url) tile.coverUrl = t.album.images[0].url
    tracks.push(tile)
  }
  const total = raw.tracks?.total ?? 0
  const consumed = offset + items.length
  const nextOffset = consumed < total && items.length > 0 && consumed < 1000 ? consumed : null
  return { tracks, nextOffset }
}
