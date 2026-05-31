import { describe, expect, it } from 'vitest'
import { extractSpotifyRef } from './spotifyUrl'

const ID = '37i9dQZF1DXcBWIGoYBM5M' // 22-char base62, plausible Spotify id

describe('extractSpotifyRef', () => {
  it('extracts a playlist from a canonical open.spotify.com URL', () => {
    expect(extractSpotifyRef(`https://open.spotify.com/playlist/${ID}`)).toEqual({
      kind: 'playlist',
      id: ID,
    })
  })

  it('extracts a track', () => {
    expect(extractSpotifyRef(`https://open.spotify.com/track/${ID}`)).toEqual({
      kind: 'track',
      id: ID,
    })
  })

  it('extracts an album', () => {
    expect(extractSpotifyRef(`https://open.spotify.com/album/${ID}`)).toEqual({
      kind: 'album',
      id: ID,
    })
  })

  it('ignores the ?si= referrer query', () => {
    expect(extractSpotifyRef(`https://open.spotify.com/playlist/${ID}?si=abc123`)).toEqual({
      kind: 'playlist',
      id: ID,
    })
  })

  it('handles the localised /intl-XX/ path segment', () => {
    expect(extractSpotifyRef(`https://open.spotify.com/intl-de/playlist/${ID}`)).toEqual({
      kind: 'playlist',
      id: ID,
    })
    expect(extractSpotifyRef(`https://open.spotify.com/intl-pt-br/track/${ID}`)).toEqual({
      kind: 'track',
      id: ID,
    })
  })

  it('accepts the spotify:KIND:ID URI form', () => {
    expect(extractSpotifyRef(`spotify:playlist:${ID}`)).toEqual({ kind: 'playlist', id: ID })
    expect(extractSpotifyRef(`spotify:track:${ID}`)).toEqual({ kind: 'track', id: ID })
    expect(extractSpotifyRef(`spotify:album:${ID}`)).toEqual({ kind: 'album', id: ID })
  })

  it('trims surrounding whitespace', () => {
    expect(extractSpotifyRef(`   https://open.spotify.com/playlist/${ID}   `)).toEqual({
      kind: 'playlist',
      id: ID,
    })
  })

  it('returns null for non-spotify hosts', () => {
    expect(extractSpotifyRef('https://music.apple.com/playlist/whatever')).toBe(null)
    expect(extractSpotifyRef('https://soundcloud.com/foo/sets/bar')).toBe(null)
    expect(extractSpotifyRef('https://www.notion.so/foo')).toBe(null)
  })

  it('returns null for unsupported Spotify resource kinds', () => {
    // Artists, shows, episodes — we don't surface those (yet).
    expect(extractSpotifyRef(`https://open.spotify.com/artist/${ID}`)).toBe(null)
    expect(extractSpotifyRef(`https://open.spotify.com/show/${ID}`)).toBe(null)
    expect(extractSpotifyRef(`https://open.spotify.com/episode/${ID}`)).toBe(null)
  })

  it('returns null when the id is malformed (not 22 chars base62)', () => {
    expect(extractSpotifyRef('https://open.spotify.com/playlist/short')).toBe(null)
    expect(extractSpotifyRef('https://open.spotify.com/playlist/has-a-dash-in-it22')).toBe(null)
  })

  it('returns null for non-URL strings', () => {
    expect(extractSpotifyRef('hello world')).toBe(null)
    expect(extractSpotifyRef('')).toBe(null)
  })
})
