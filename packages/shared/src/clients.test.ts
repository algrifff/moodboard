import { describe, expect, it } from 'vitest'
import { matchNamed, slugify } from './clients'

describe('slugify', () => {
  it('lowercases, strips diacritics and collapses punctuation', () => {
    expect(slugify('  Acme & Sons, Inc.  ')).toBe('acme-sons-inc')
    expect(slugify('Café Müller')).toBe('cafe-muller')
  })

  it('falls back when nothing usable is left', () => {
    expect(slugify('***')).toBe('client')
  })

  it('caps the length without leaving a trailing dash', () => {
    const slug = slugify('a'.repeat(39) + ' bbbbbb')
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('matchNamed', () => {
  const clients = [
    { id: 'c1', name: 'Acme', slug: 'acme' },
    { id: 'c2', name: 'Acme Labs', slug: 'acme-labs' },
    { id: 'c3', name: 'Globex', slug: 'globex' },
  ]

  it('prefers an exact name or slug over a looser match', () => {
    expect(matchNamed(clients, 'acme')).toEqual({ kind: 'found', item: clients[0] })
    expect(matchNamed(clients, 'ACME LABS')).toEqual({ kind: 'found', item: clients[1] })
  })

  it('matches by id', () => {
    expect(matchNamed(clients, 'c3')).toEqual({ kind: 'found', item: clients[2] })
  })

  it('resolves a unique partial match', () => {
    expect(matchNamed(clients, 'glob')).toEqual({ kind: 'found', item: clients[2] })
  })

  it('reports ambiguity instead of guessing', () => {
    expect(matchNamed(clients, 'ac')).toEqual({
      kind: 'ambiguous',
      candidates: [clients[0], clients[1]],
    })
  })

  it('matches things without a slug by name', () => {
    const kits = [
      { id: 'k1', name: 'Brand kit' },
      { id: 'k2', name: 'Launch kit' },
    ]
    expect(matchNamed(kits, 'launch')).toEqual({ kind: 'found', item: kits[1] })
    expect(matchNamed(kits, 'kit')).toEqual({ kind: 'ambiguous', candidates: kits })
  })

  it('returns none for no match or an empty query', () => {
    expect(matchNamed(clients, 'initech')).toEqual({ kind: 'none' })
    expect(matchNamed(clients, '  ')).toEqual({ kind: 'none' })
  })
})
