import { describe, expect, it } from 'vitest'
import { isEmailAllowed, parseAllowedDomains } from './emailDomain'

describe('parseAllowedDomains', () => {
  it('splits, trims, lowercases, and strips a leading @', () => {
    expect(parseAllowedDomains(' Acme.com, @acme.studio ,,')).toEqual(['acme.com', 'acme.studio'])
  })

  it('returns empty for unset', () => {
    expect(parseAllowedDomains(undefined)).toEqual([])
  })
})

describe('isEmailAllowed', () => {
  it('allows anything when no domains are configured', () => {
    expect(isEmailAllowed('a@anywhere.io', [])).toBe(true)
  })

  it('matches the domain case-insensitively', () => {
    expect(isEmailAllowed('Alex@ACME.com', ['acme.com'])).toBe(true)
  })

  it('rejects other domains, including lookalike subdomains', () => {
    expect(isEmailAllowed('a@evil.com', ['acme.com'])).toBe(false)
    expect(isEmailAllowed('a@acme.com.evil.com', ['acme.com'])).toBe(false)
    expect(isEmailAllowed('a@sub.acme.com', ['acme.com'])).toBe(false)
  })

  it('uses the last @ so a quoted local part cannot smuggle a domain', () => {
    expect(isEmailAllowed('"x@acme.com"@evil.com', ['acme.com'])).toBe(false)
  })

  it('rejects a string with no @', () => {
    expect(isEmailAllowed('acme.com', ['acme.com'])).toBe(false)
  })
})
