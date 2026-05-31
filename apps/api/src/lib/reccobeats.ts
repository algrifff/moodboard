// ReccoBeats audio-features adapter.
//
// Spotify deprecated GET /v1/audio-features on 2024-11-27 — apps registered
// after that date get 403 Forbidden, so energy/valence/tempo/etc. are no
// longer obtainable from Spotify directly. ReccoBeats (https://reccobeats.com)
// is a free, no-auth drop-in: it returns the same descriptors keyed by
// Spotify track id. We use it as the primary source for audio features.
//
//   GET https://api.reccobeats.com/v1/audio-features?ids=<comma-sep spotify ids>
//
// Notes from probing the live API:
//   - No API key / auth required.
//   - The `ids` length is capped (~35 ok, ~100 → 400), so we batch at 30.
//   - Results come back UNORDERED in a `content` array and DON'T echo the
//     Spotify id as a field — each entry carries `href` like
//     "https://open.spotify.com/track/{id}", which we parse back to the id.
//   - Coverage is sparse: a track ReccoBeats doesn't have simply isn't in
//     `content` (same sparse-Map contract the old Spotify path had).

import type { RawAudioFeatures } from './spotifyAggregates'

const RECCOBEATS_API = 'https://api.reccobeats.com/v1'

// Comfortably under the observed ~35-id ceiling. A 100-track playlist is
// then 4 sequential requests — fine for an import action behind a toast.
const RECCOBEATS_BATCH = 30

type RawReccoFeature = {
  href?: string
  energy?: number
  valence?: number
  danceability?: number
  acousticness?: number
  instrumentalness?: number
  speechiness?: number
  liveness?: number
  tempo?: number
}

// Pull the Spotify track id out of a ReccoBeats `href`
// ("https://open.spotify.com/track/{id}").
function spotifyIdFromHref(href: string | undefined): string | null {
  if (!href) return null
  const m = href.match(/\/track\/([A-Za-z0-9]+)/)
  return m ? m[1]! : null
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Fetch audio features for the given Spotify track ids from ReccoBeats.
 * Returns a sparse map keyed by Spotify track id (missing ids = no coverage).
 * Each batch is independently guarded so one failing/oversized chunk degrades
 * to "no features for those tracks" rather than throwing the whole import.
 */
export async function fetchAudioFeatures(
  trackIds: string[],
): Promise<Map<string, RawAudioFeatures>> {
  const out = new Map<string, RawAudioFeatures>()
  const ids = trackIds.filter((id) => typeof id === 'string' && id.length > 0)
  for (let i = 0; i < ids.length; i += RECCOBEATS_BATCH) {
    const batch = ids.slice(i, i + RECCOBEATS_BATCH)
    if (batch.length === 0) continue
    try {
      const res = await fetch(`${RECCOBEATS_API}/audio-features?ids=${batch.join(',')}`, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) continue
      const json = (await res.json()) as { content?: RawReccoFeature[] }
      for (const f of json.content ?? []) {
        const id = spotifyIdFromHref(f.href)
        if (!id) continue
        out.set(id, {
          id,
          energy: num(f.energy),
          valence: num(f.valence),
          danceability: num(f.danceability),
          acousticness: num(f.acousticness),
          instrumentalness: num(f.instrumentalness),
          speechiness: num(f.speechiness),
          liveness: num(f.liveness),
          tempo: num(f.tempo),
        })
      }
    } catch {
      // Network blip / oversized batch — skip; the caller treats absent ids
      // as "no features available" and the card degrades gracefully.
    }
  }
  return out
}

export { RECCOBEATS_BATCH }
