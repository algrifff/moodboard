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
