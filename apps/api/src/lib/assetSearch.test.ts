import { describe, expect, it } from 'vitest'
import { buildTsQuery, nameFromUrl, thumbnailFor } from './assetSearch'

describe('buildTsQuery', () => {
  it('ANDs the words and matches each as a prefix', () => {
    expect(buildTsQuery('brand logo')).toBe('brand:* & logo:*')
  })

  it('lowercases and keeps unicode letters and digits', () => {
    expect(buildTsQuery('Café V2')).toBe('café:* & v2:*')
  })

  it('drops everything that could be tsquery syntax', () => {
    expect(buildTsQuery("logo' | !(secret) & <-> :*")).toBe('logo:* & secret:*')
    expect(buildTsQuery('a"; DROP TABLE asset;--')).toBe('a:* & drop:* & table:* & asset:*')
  })

  it('returns null when there is nothing searchable', () => {
    expect(buildTsQuery('')).toBeNull()
    expect(buildTsQuery('  !!! --- ')).toBeNull()
  })

  it('bounds the number and length of terms', () => {
    const many = buildTsQuery(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '))!
    expect(many.split(' & ')).toHaveLength(8)
    expect(buildTsQuery('x'.repeat(100))).toBe(`${'x'.repeat(40)}:*`)
  })
})

describe('nameFromUrl', () => {
  it('takes the last path segment, decoded', () => {
    expect(nameFromUrl('https://cdn.example.com/a/b/Hero%20Shot.jpg?x=1')).toBe('Hero Shot.jpg')
    expect(nameFromUrl(new URL('https://example.com/logo.svg'))).toBe('logo.svg')
  })

  it('survives bad escapes and empty paths', () => {
    expect(nameFromUrl('https://example.com/100%.png')).toBe('100%.png')
    expect(nameFromUrl('https://example.com/')).toBeNull()
    expect(nameFromUrl('not a url')).toBeNull()
  })
})

describe('thumbnailFor', () => {
  it('uses the image itself, a pdf’s first-page render, and nothing for the rest', () => {
    expect(thumbnailFor({ filename: 'a.png', kind: 'upload', mediaKind: 'image' })).toBe(
      '/api/files/a.png',
    )
    expect(thumbnailFor({ filename: 'b.pdf', kind: 'pdf', mediaKind: 'pdf' })).toBe(
      '/api/files/b.png',
    )
    expect(thumbnailFor({ filename: 'c.woff2', kind: 'upload', mediaKind: 'font' })).toBeNull()
  })
})
