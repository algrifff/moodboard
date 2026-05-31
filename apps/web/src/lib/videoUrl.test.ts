import { describe, expect, it } from 'vitest'
import { extractVideoRef } from './videoUrl'

describe('extractVideoRef', () => {
  it('recognises YouTube watch URLs', () => {
    expect(extractVideoRef('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      platform: 'youtube',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    })
  })

  it('recognises youtu.be short links', () => {
    expect(extractVideoRef('https://youtu.be/dQw4w9WgXcQ')?.platform).toBe('youtube')
  })

  it('recognises YouTube Shorts + live + embed', () => {
    expect(extractVideoRef('https://www.youtube.com/shorts/abc123')?.platform).toBe('youtube')
    expect(extractVideoRef('https://youtube.com/live/abc123')?.platform).toBe('youtube')
    expect(extractVideoRef('https://www.youtube.com/embed/abc123')?.platform).toBe('youtube')
  })

  it('recognises music.youtube.com', () => {
    expect(extractVideoRef('https://music.youtube.com/watch?v=abc123')?.platform).toBe('youtube')
  })

  it('rejects a bare YouTube channel / home URL', () => {
    expect(extractVideoRef('https://www.youtube.com')).toBeNull()
    expect(extractVideoRef('https://www.youtube.com/@someChannel')).toBeNull()
    expect(extractVideoRef('https://www.youtube.com/watch')).toBeNull() // no ?v=
  })

  it('recognises TikTok video + short links', () => {
    expect(
      extractVideoRef('https://www.tiktok.com/@charlidamelio/video/7012345678901234567')?.platform,
    ).toBe('tiktok')
    expect(extractVideoRef('https://vm.tiktok.com/ZMabc123/')?.platform).toBe('tiktok')
    expect(extractVideoRef('https://www.tiktok.com/t/ZTabc123/')?.platform).toBe('tiktok')
  })

  it('rejects a bare TikTok profile', () => {
    expect(extractVideoRef('https://www.tiktok.com/@charlidamelio')).toBeNull()
  })

  it('recognises Instagram reels / posts / tv', () => {
    expect(extractVideoRef('https://www.instagram.com/reel/Cabc123/')?.platform).toBe('instagram')
    expect(extractVideoRef('https://instagram.com/p/Cabc123/')?.platform).toBe('instagram')
    expect(extractVideoRef('https://www.instagram.com/tv/Cabc123/')?.platform).toBe('instagram')
  })

  it('rejects an Instagram profile', () => {
    expect(extractVideoRef('https://www.instagram.com/natgeo/')).toBeNull()
  })

  it('recognises X / Twitter status URLs', () => {
    expect(extractVideoRef('https://x.com/someone/status/1750000000000000000')?.platform).toBe('x')
    expect(
      extractVideoRef('https://twitter.com/someone/status/1750000000000000000')?.platform,
    ).toBe('x')
  })

  it('rejects an X profile (no status)', () => {
    expect(extractVideoRef('https://x.com/someone')).toBeNull()
  })

  it('recognises Vimeo numeric URLs', () => {
    expect(extractVideoRef('https://vimeo.com/123456789')?.platform).toBe('vimeo')
  })

  it('rejects a non-video site (lets the web-page handler take it)', () => {
    expect(extractVideoRef('https://stripe.com')).toBeNull()
    expect(extractVideoRef('https://www.notion.so/Some-Page-abc123')).toBeNull()
  })

  it('returns null for non-URLs and non-http schemes', () => {
    expect(extractVideoRef('not a url')).toBeNull()
    expect(extractVideoRef('')).toBeNull()
    expect(extractVideoRef('  ')).toBeNull()
    expect(extractVideoRef('ftp://youtube.com/watch?v=x')).toBeNull()
  })

  it('preserves the original URL string for the importer', () => {
    const u = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'
    expect(extractVideoRef(`  ${u}  `)?.url).toBe(u)
  })
})
