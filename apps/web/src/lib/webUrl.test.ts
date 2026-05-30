import { describe, expect, it } from 'vitest'
import { extractWebUrl } from './webUrl'

describe('extractWebUrl', () => {
  it('returns the URL for a plain brand homepage', () => {
    expect(extractWebUrl('https://stripe.com')).toBe('https://stripe.com/')
    expect(extractWebUrl('http://acme.io/about')).toBe('http://acme.io/about')
  })

  it('strips embedded credentials', () => {
    expect(extractWebUrl('https://alex:hunter2@acme.com/')).toBe('https://acme.com/')
  })

  it('returns null for non-URL strings', () => {
    expect(extractWebUrl('hello world')).toBe(null)
    expect(extractWebUrl('')).toBe(null)
    expect(extractWebUrl('not a url at all')).toBe(null)
  })

  it('returns null for non-http(s) schemes', () => {
    expect(extractWebUrl('mailto:hello@acme.com')).toBe(null)
    expect(extractWebUrl('javascript:alert(1)')).toBe(null)
    expect(extractWebUrl('ftp://files.acme.com/file')).toBe(null)
  })

  it('returns null for provider-claimed URLs so the right adapter runs', () => {
    // Notion
    expect(
      extractWebUrl('https://www.notion.so/Title-12345678abcdef1234567890abcdef12'),
    ).toBe(null)
    expect(extractWebUrl('https://notion.so/page')).toBe(null)
    // Drive
    expect(extractWebUrl('https://docs.google.com/document/d/abc/edit')).toBe(null)
    expect(extractWebUrl('https://drive.google.com/file/d/abc/view')).toBe(null)
    // Phase-15 forward-looking
    expect(extractWebUrl('https://open.spotify.com/playlist/abc')).toBe(null)
    // Phase-16 forward-looking
    expect(extractWebUrl('https://www.youtube.com/watch?v=abc')).toBe(null)
    expect(extractWebUrl('https://youtu.be/abc')).toBe(null)
    expect(extractWebUrl('https://www.tiktok.com/@user/video/123')).toBe(null)
    expect(extractWebUrl('https://www.instagram.com/reel/abc')).toBe(null)
    expect(extractWebUrl('https://vimeo.com/12345')).toBe(null)
  })

  it('handles whitespace around the URL', () => {
    expect(extractWebUrl('   https://acme.com   ')).toBe('https://acme.com/')
  })
})
