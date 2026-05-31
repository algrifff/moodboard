import { describe, expect, it } from 'vitest'
import { rewriteAssetUrl } from './sharesApi'

describe('rewriteAssetUrl', () => {
  it('rewrites /api/files/<x> to /api/shares/<token>/files/<x>', () => {
    expect(rewriteAssetUrl('/api/files/abc.png', 'tok123')).toBe('/api/shares/tok123/files/abc.png')
  })

  it('passes external URLs through unchanged', () => {
    expect(rewriteAssetUrl('https://i.scdn.co/image/abc.jpg', 'tok123')).toBe(
      'https://i.scdn.co/image/abc.jpg',
    )
  })

  it('URL-encodes the token segment', () => {
    expect(rewriteAssetUrl('/api/files/abc.png', 't ok')).toBe('/api/shares/t%20ok/files/abc.png')
  })

  it('leaves empty / non-matching strings alone', () => {
    expect(rewriteAssetUrl('', 'tok')).toBe('')
    expect(rewriteAssetUrl('not a url', 'tok')).toBe('not a url')
  })
})
