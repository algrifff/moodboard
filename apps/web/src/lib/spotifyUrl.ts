// Spotify URL / URI recogniser. Public Spotify resources surface in a few
// shapes:
//
//   https://open.spotify.com/playlist/{id}
//   https://open.spotify.com/playlist/{id}?si=…           (share link with referrer)
//   https://open.spotify.com/intl-de/playlist/{id}        (geo-localised)
//   https://open.spotify.com/track/{id}
//   https://open.spotify.com/album/{id}
//   spotify:playlist:{id}                                 (URI form)
//   spotify:track:{id}
//   spotify:album:{id}
//
// IDs are 22-char base62. We return `{ kind, id }` matching the server's
// SpotifyRef shape. Returns null when the input doesn't look like a
// Spotify resource we know how to import (artist / show / episode pages
// fall through — we don't surface those yet).

export type SpotifyRef = { kind: 'playlist' | 'track' | 'album'; id: string }

const ID_RE = /^[A-Za-z0-9]{22}$/

/**
 * Pull a Spotify ref (kind + id) from a pasted URL or URI string.
 * Returns null if the input isn't a recognised Spotify resource shape.
 */
export function extractSpotifyRef(input: string): SpotifyRef | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // URI form first — cheap to detect.
  const uri = trimmed.match(/^spotify:(playlist|track|album):([A-Za-z0-9]{22})$/i)
  if (uri) return { kind: uri[1] as SpotifyRef['kind'], id: uri[2]! }

  // URL form.
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.hostname !== 'open.spotify.com') return null

  // Path is /{kind}/{id} or /intl-XX/{kind}/{id}. Split and skip the
  // optional locale segment.
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length === 0) return null
  let kindIdx = 0
  if (segments[0]?.startsWith('intl-')) kindIdx = 1
  const kind = segments[kindIdx]
  const id = segments[kindIdx + 1]
  if (!kind || !id) return null
  if (kind !== 'playlist' && kind !== 'track' && kind !== 'album') return null
  if (!ID_RE.test(id)) return null
  return { kind, id }
}
