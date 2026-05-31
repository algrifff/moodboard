import type { CanvasObject } from '@moodboard/shared'
import { describe, expect, it } from 'vitest'
import { analysisHash } from './analysisHash'

const sticky = (id: string, text: string, color = '#FEF3C7'): CanvasObject => ({
  id,
  type: 'sticky',
  position: { x: 0, y: 0 },
  size: { width: 200, height: 200 },
  rotation: 0,
  zIndex: 0,
  data: { text, color },
})

const image = (id: string, url: string): CanvasObject => ({
  id,
  type: 'image',
  position: { x: 0, y: 0 },
  size: { width: 400, height: 400 },
  rotation: 0,
  zIndex: 0,
  data: { url },
})

describe('analysisHash', () => {
  it('is stable across object ordering', () => {
    const a = analysisHash([sticky('a', 'foo'), sticky('b', 'bar')], 'm1')
    const b = analysisHash([sticky('b', 'bar'), sticky('a', 'foo')], 'm1')
    expect(a).toBe(b)
  })

  it('changes when text content changes', () => {
    const a = analysisHash([sticky('a', 'foo')], 'm1')
    const b = analysisHash([sticky('a', 'bar')], 'm1')
    expect(a).not.toBe(b)
  })

  it('changes when sticky color changes', () => {
    const a = analysisHash([sticky('a', 'foo', '#FEF3C7')], 'm1')
    const b = analysisHash([sticky('a', 'foo', '#A7F3D0')], 'm1')
    expect(a).not.toBe(b)
  })

  it('changes when image url changes', () => {
    const a = analysisHash([image('a', '/api/files/x.png')], 'm1')
    const b = analysisHash([image('a', '/api/files/y.png')], 'm1')
    expect(a).not.toBe(b)
  })

  it('changes when membership changes', () => {
    const base = [sticky('a', 'foo')]
    const grown = [...base, sticky('b', 'bar')]
    expect(analysisHash(base, 'm1')).not.toBe(analysisHash(grown, 'm1'))
  })

  it('changes when model tag changes', () => {
    const a = analysisHash([sticky('a', 'foo')], 'haiku')
    const b = analysisHash([sticky('a', 'foo')], 'sonnet')
    expect(a).not.toBe(b)
  })

  it('produces a hex string of expected length', () => {
    const h = analysisHash([sticky('a', 'foo')], 'm1')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when an uploaded font family changes (regression)', () => {
    // Prior implementation ignored 'font' entirely, so swapping the uploaded
    // family slipped past the cache. Guard against the regression.
    const font = (id: string, family: string, url = '/api/files/x.woff2'): CanvasObject => ({
      id,
      type: 'font',
      position: { x: 0, y: 0 },
      size: { width: 320, height: 200 },
      rotation: 0,
      zIndex: 0,
      data: { family, url },
    })
    const a = analysisHash([font('a', 'Inter')], 'm1')
    const b = analysisHash([font('a', 'GT America')], 'm1')
    expect(a).not.toBe(b)
  })

  it('changes when a notion page markdown changes', () => {
    const page = (id: string, markdown: string, lastEditedAt?: string): CanvasObject => ({
      id,
      type: 'notion-page',
      position: { x: 0, y: 0 },
      size: { width: 280, height: 360 },
      rotation: 0,
      zIndex: 0,
      data: {
        connectionId: 'c1',
        pageId: 'p1',
        workspaceId: 'w1',
        title: 'Page',
        url: 'https://notion.so/p1',
        markdown,
        fetchedAt: '2026-05-30T00:00:00Z',
        lastEditedAt,
      },
    })
    const a = analysisHash([page('a', '# Hello')], 'm1')
    const b = analysisHash([page('a', '# Hello world')], 'm1')
    expect(a).not.toBe(b)
  })

  it('does not invalidate when only notion fetchedAt drifts', () => {
    // fetchedAt advances on every refresh even when content is unchanged.
    // Hashing it would burn AI cache on every poll.
    const base = {
      id: 'a',
      type: 'notion-page' as const,
      position: { x: 0, y: 0 },
      size: { width: 280, height: 360 },
      rotation: 0,
      zIndex: 0,
    }
    const a: CanvasObject = {
      ...base,
      data: {
        connectionId: 'c1',
        pageId: 'p1',
        workspaceId: 'w1',
        title: 'Page',
        url: 'https://notion.so/p1',
        markdown: '# Hello',
        fetchedAt: '2026-05-30T00:00:00Z',
        lastEditedAt: '2026-05-29T00:00:00Z',
      },
    }
    const b: CanvasObject = {
      ...base,
      data: { ...(a.data as Record<string, unknown>), fetchedAt: '2026-05-31T00:00:00Z' } as never,
    }
    expect(analysisHash([a], 'm1')).toBe(analysisHash([b], 'm1'))
  })

  it('changes when a drive file excerpt changes', () => {
    const driveFile = (id: string, excerpt: string): CanvasObject => ({
      id,
      type: 'drive-file',
      position: { x: 0, y: 0 },
      size: { width: 280, height: 140 },
      rotation: 0,
      zIndex: 0,
      data: {
        connectionId: 'c1',
        fileId: 'f1',
        mimeType: 'application/vnd.google-apps.document',
        name: 'Q4 Brief',
        webViewLink: 'https://docs.google.com/document/d/f1',
        excerpt,
        fetchedAt: '2026-05-30T00:00:00Z',
        modifiedTime: '2026-05-29T00:00:00Z',
      },
    })
    expect(analysisHash([driveFile('a', 'first draft')], 'm1')).not.toBe(
      analysisHash([driveFile('a', 'final draft')], 'm1'),
    )
  })

  it('changes when a web page readable text changes', () => {
    const webPage = (id: string, readableText: string): CanvasObject => ({
      id,
      type: 'web-page',
      position: { x: 0, y: 0 },
      size: { width: 300, height: 168 },
      rotation: 0,
      zIndex: 0,
      data: {
        url: 'https://stripe.com',
        host: 'stripe.com',
        title: 'Stripe',
        description: 'Payments infrastructure',
        readableText,
        colours: [{ hex: '#635BFF', role: 'primary' }],
        fonts: [{ family: 'Inter', role: 'display' }],
        fetchedAt: '2026-05-30T00:00:00Z',
      },
    })
    expect(analysisHash([webPage('a', 'Pay as you build')], 'm1')).not.toBe(
      analysisHash([webPage('a', 'Payments infrastructure for the internet')], 'm1'),
    )
  })

  it('does not invalidate when only web-page colours/fonts change', () => {
    // The hash is content-driven — palette and fonts are inline hints
    // for the AD prompt. A stylesheet tweak that shifts a swatch
    // shouldn't burn the cache.
    const base = {
      id: 'a',
      type: 'web-page' as const,
      position: { x: 0, y: 0 },
      size: { width: 300, height: 168 },
      rotation: 0,
      zIndex: 0,
    }
    const a: CanvasObject = {
      ...base,
      data: {
        url: 'https://acme.com',
        host: 'acme.com',
        title: 'Acme',
        description: '',
        readableText: 'Hello world',
        colours: [{ hex: '#FF0000', role: 'primary' }],
        fonts: [{ family: 'Inter', role: 'display' }],
        fetchedAt: '2026-05-30T00:00:00Z',
      },
    }
    const b: CanvasObject = {
      ...base,
      data: {
        url: 'https://acme.com',
        host: 'acme.com',
        title: 'Acme',
        description: '',
        readableText: 'Hello world',
        colours: [{ hex: '#00FF00', role: 'primary' }],
        fonts: [{ family: 'Roboto', role: 'display' }],
        fetchedAt: '2026-06-30T00:00:00Z',
      },
    }
    expect(analysisHash([a], 'm1')).toBe(analysisHash([b], 'm1'))
  })

  it('changes when a spotify playlist snapshotId changes', () => {
    const playlist = (id: string, snapshotId: string): CanvasObject => ({
      id,
      type: 'spotify-playlist',
      position: { x: 0, y: 0 },
      size: { width: 320, height: 160 },
      rotation: 0,
      zIndex: 0,
      data: {
        connectionId: 'c1',
        playlistId: 'p1',
        snapshotId,
        name: 'After Hours',
        description: '',
        ownerName: 'alex',
        trackCount: 12,
        tracks: [],
        audioFeatures: {
          avgEnergy: 0.6,
          avgValence: 0.4,
          avgDanceability: 0.5,
          avgAcousticness: 0.3,
          avgInstrumentalness: 0.1,
          avgSpeechiness: 0.05,
          medianTempo: 110,
          trackCount: 12,
        },
        url: 'https://open.spotify.com/playlist/p1',
        fetchedAt: '2026-05-30T00:00:00Z',
      },
    })
    // Adding / removing / reordering tracks issues a fresh snapshotId from
    // Spotify — that should bust the cache.
    expect(analysisHash([playlist('a', 'snap-v1')], 'm1')).not.toBe(
      analysisHash([playlist('a', 'snap-v2')], 'm1'),
    )
  })

  it('does not invalidate when only spotify fetchedAt drifts', () => {
    // A no-op refresh (same snapshotId, same content) should reuse the
    // AD cache. fetchedAt advances every refresh, so it stays out of the hash.
    const base = {
      id: 'a',
      type: 'spotify-playlist' as const,
      position: { x: 0, y: 0 },
      size: { width: 320, height: 160 },
      rotation: 0,
      zIndex: 0,
    }
    const a: CanvasObject = {
      ...base,
      data: {
        connectionId: 'c1',
        playlistId: 'p1',
        snapshotId: 'snap-v1',
        name: 'Mix',
        description: '',
        ownerName: 'alex',
        trackCount: 1,
        tracks: [],
        audioFeatures: {
          avgEnergy: 0.5,
          avgValence: 0.5,
          avgDanceability: 0.5,
          avgAcousticness: 0.5,
          avgInstrumentalness: 0.5,
          avgSpeechiness: 0.5,
          medianTempo: 100,
          trackCount: 1,
        },
        url: 'https://open.spotify.com/playlist/p1',
        fetchedAt: '2026-05-30T00:00:00Z',
      },
    }
    const b: CanvasObject = {
      ...base,
      data: { ...(a.data as Record<string, unknown>), fetchedAt: '2026-06-30T00:00:00Z' } as never,
    }
    expect(analysisHash([a], 'm1')).toBe(analysisHash([b], 'm1'))
  })

  it('changes when a spotify track audio features change', () => {
    const track = (id: string, energy: number): CanvasObject => ({
      id,
      type: 'spotify-track',
      position: { x: 0, y: 0 },
      size: { width: 320, height: 160 },
      rotation: 0,
      zIndex: 0,
      data: {
        connectionId: 'c1',
        trackId: 't1',
        name: 'Track',
        artists: ['Artist'],
        albumName: 'Album',
        durationMs: 180000,
        audioFeatures: {
          energy,
          valence: 0.5,
          danceability: 0.5,
          acousticness: 0.3,
          instrumentalness: 0.1,
          speechiness: 0.05,
          tempo: 120,
        },
        url: 'https://open.spotify.com/track/t1',
        fetchedAt: '2026-05-30T00:00:00Z',
      },
    })
    expect(analysisHash([track('a', 0.7)], 'm1')).not.toBe(analysisHash([track('a', 0.3)], 'm1'))
  })

  it('changes when a drive folder gains a child', () => {
    const folder = (id: string, children: { name: string; mimeType: string }[]): CanvasObject => ({
      id,
      type: 'drive-folder',
      position: { x: 0, y: 0 },
      size: { width: 280, height: 140 },
      rotation: 0,
      zIndex: 0,
      data: {
        connectionId: 'c1',
        folderId: 'fld1',
        name: 'Brand assets',
        webViewLink: 'https://drive.google.com/drive/folders/fld1',
        childCount: children.length,
        childPreview: children,
        fetchedAt: '2026-05-30T00:00:00Z',
      },
    })
    const a = folder('a', [{ name: 'logo.png', mimeType: 'image/png' }])
    const b = folder('a', [
      { name: 'logo.png', mimeType: 'image/png' },
      { name: 'logo-dark.png', mimeType: 'image/png' },
    ])
    expect(analysisHash([a], 'm1')).not.toBe(analysisHash([b], 'm1'))
  })

  const videoClip = (id: string, transcript: string, videoId = 'vid1'): CanvasObject => ({
    id,
    type: 'video-clip',
    position: { x: 0, y: 0 },
    size: { width: 320, height: 290 },
    rotation: 0,
    zIndex: 0,
    data: {
      platform: 'youtube',
      url: 'https://www.youtube.com/watch?v=vid1',
      videoId,
      title: 'How we built it',
      channel: 'Acme',
      durationSec: 213,
      thumbnailUrl: '/api/files/thumb.jpg',
      transcript,
      fetchedAt: '2026-05-30T00:00:00Z',
    },
  })

  it('changes when a video-clip transcript changes', () => {
    expect(analysisHash([videoClip('a', 'we ship fast')], 'm1')).not.toBe(
      analysisHash([videoClip('a', 'we ship slow and steady')], 'm1'),
    )
  })

  it('changes when the video id changes (different clip)', () => {
    expect(analysisHash([videoClip('a', 'same words', 'vid1')], 'm1')).not.toBe(
      analysisHash([videoClip('a', 'same words', 'vid2')], 'm1'),
    )
  })

  it('does not invalidate when only video fetchedAt drifts', () => {
    const base = videoClip('a', 'identical transcript')
    const drifted: CanvasObject = {
      ...base,
      data: { ...base.data, fetchedAt: '2026-09-09T00:00:00Z' },
    }
    expect(analysisHash([base], 'm1')).toBe(analysisHash([drifted], 'm1'))
  })
})
