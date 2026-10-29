import type {
  SpotifyAlbumData,
  SpotifyPlaylistData,
  SpotifyTrackData,
  SpotifyTrackSummary,
} from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db'
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
  trackFeaturesWithAggregate,
} from '../spotify'
import { TokenDecryptError } from './errors'
import { upsertRecent } from './recents'

export type SpotifyRef = { kind: 'playlist' | 'track' | 'album'; id: string }

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

export async function importSpotifyRef(args: {
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
