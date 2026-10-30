import { describe, expect, it } from 'vitest'
import {
  collectAssetFilenames,
  createShareRequestSchema,
  sharedBoardSnapshotSchema,
} from './schemas'

describe('collectAssetFilenames', () => {
  it('pulls /api/files URLs out of image, pdf, voice-note, and video-clip fields', () => {
    const filenames = collectAssetFilenames({
      objects: [
        { type: 'image', data: { url: '/api/files/a.png' } },
        {
          type: 'pdf',
          data: { url: '/api/files/b.pdf', thumbnailUrl: '/api/files/b-thumb.png' },
        },
        {
          type: 'voice-note',
          data: {
            url: '/api/files/v.webm',
            transcript: 'unrelated text',
            mimeType: 'audio/webm',
          },
        },
        { type: 'video-clip', data: { thumbnailUrl: '/api/files/vc.jpg' } },
      ],
    })
    expect(filenames).toEqual(['a.png', 'b-thumb.png', 'b.pdf', 'v.webm', 'vc.jpg'])
  })

  it('ignores external URLs', () => {
    const filenames = collectAssetFilenames({
      objects: [
        { type: 'image', data: { url: 'https://i.scdn.co/cover.jpg' } },
        { type: 'web-page', data: { faviconUrl: 'https://example.com/favicon.ico' } },
      ],
    })
    expect(filenames).toEqual([])
  })

  it('walks one level of nested arrays-of-objects-with-url (web-page logoImages style)', () => {
    const filenames = collectAssetFilenames({
      objects: [
        {
          type: 'web-page',
          data: {
            url: 'https://example.com',
            logoImages: [{ url: '/api/files/logo1.png' }, { url: 'https://external/logo2.png' }],
          },
        },
      ],
    })
    expect(filenames).toEqual(['logo1.png'])
  })

  it('dedupes repeats and strips query strings', () => {
    const filenames = collectAssetFilenames({
      objects: [
        { type: 'image', data: { url: '/api/files/x.png?v=1' } },
        { type: 'image', data: { url: '/api/files/x.png' } },
      ],
    })
    expect(filenames).toEqual(['x.png'])
  })

  it('returns [] for an empty board', () => {
    expect(collectAssetFilenames({ objects: [] })).toEqual([])
  })
})

describe('sharedBoardSnapshotSchema', () => {
  it('parses a minimal valid snapshot', () => {
    const parsed = sharedBoardSnapshotSchema.safeParse({
      version: 1,
      boardName: 'Test board',
      capturedAt: new Date().toISOString(),
      objects: [],
      groups: [],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a snapshot with a wrong version literal', () => {
    const parsed = sharedBoardSnapshotSchema.safeParse({
      version: 2,
      boardName: 'Test',
      capturedAt: '',
      objects: [],
      groups: [],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an empty boardName', () => {
    const parsed = sharedBoardSnapshotSchema.safeParse({
      version: 1,
      boardName: '',
      capturedAt: '',
      objects: [],
      groups: [],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('createShareRequestSchema', () => {
  it('wraps a snapshot under { snapshot }', () => {
    const parsed = createShareRequestSchema.safeParse({
      snapshot: {
        version: 1,
        boardName: 'Test',
        capturedAt: new Date().toISOString(),
        objects: [],
        groups: [],
      },
    })
    expect(parsed.success).toBe(true)
  })
})

describe('sharedBoardSnapshotSchema keeps every card whole', () => {
  const base = {
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    rotation: 0,
    zIndex: 0,
  }
  const snapshot = (objects: unknown[]) =>
    sharedBoardSnapshotSchema.parse({
      version: 1,
      boardName: 'Board',
      capturedAt: '2026-10-30T00:00:00.000Z',
      objects,
      groups: [],
    })

  it('does not reduce a card with a url to a bare image', () => {
    const figma = {
      url: '/api/files/hero.png',
      fileKey: 'AbCdEfGhIjKlMnOpQrStUv',
      nodeId: '12:34',
      name: 'Hero',
      fileName: 'Acme Brand',
      figmaUrl: 'https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Acme?node-id=12-34',
      width: 1440,
      height: 900,
      lastModified: '2026-03-04T10:00:00Z',
      fetchedAt: '2026-03-04T10:05:00Z',
      structure: 'Frame “Hero”',
    }
    const font = { url: '/api/files/aktiv.woff2', family: 'Aktiv Grotesk' }
    const web = { url: 'https://acme.io', host: 'acme.io', title: 'Acme', description: '' }
    const parsed = snapshot([
      { id: 'f', type: 'figma-frame', data: figma, ...base },
      { id: 't', type: 'font', data: font, ...base },
      { id: 'w', type: 'web-page', data: web, ...base },
    ])
    expect(parsed.objects.map((o) => o.data)).toEqual([figma, font, web])
  })

  it('still rejects an object with no type or position', () => {
    expect(() => snapshot([{ id: 'x', data: {} }])).toThrow()
    expect(() => snapshot([{ id: 'x', type: 'nope', data: {}, ...base }])).toThrow()
  })

  it('walks a Figma card’s render for the share’s file allowlist', () => {
    expect(
      collectAssetFilenames({
        objects: [
          { type: 'figma-frame', data: { url: '/api/files/hero.png', figmaUrl: 'https://x' } },
        ],
      }),
    ).toEqual(['hero.png'])
  })
})
