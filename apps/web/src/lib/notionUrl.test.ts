import { describe, expect, it } from 'vitest'
import { extractNotionPageId } from './notionUrl'

describe('extractNotionPageId', () => {
  it('extracts a plain 32-char id from a notion.so URL', () => {
    expect(
      extractNotionPageId('https://www.notion.so/Brand-Bible-12345678abcdef1234567890abcdef12'),
    ).toBe('12345678abcdef1234567890abcdef12')
  })

  it('extracts and normalises a dashed UUID', () => {
    expect(
      extractNotionPageId(
        'https://www.notion.so/workspace/Brief-12345678-abcd-1234-abcd-1234567890ab',
      ),
    ).toBe('12345678abcd1234abcd1234567890ab')
  })

  it('handles bare notion.so (no www)', () => {
    expect(extractNotionPageId('https://notion.so/abcdef0123456789abcdef0123456789')).toBe(
      'abcdef0123456789abcdef0123456789',
    )
  })

  it('handles notion.site published pages', () => {
    expect(
      extractNotionPageId('https://example.notion.site/Brief-fedcba9876543210fedcba9876543210'),
    ).toBe('fedcba9876543210fedcba9876543210')
  })

  it('survives a query string', () => {
    expect(
      extractNotionPageId('https://www.notion.so/Brief-12345678abcdef1234567890abcdef12?v=share'),
    ).toBe('12345678abcdef1234567890abcdef12')
  })

  it('returns null for non-notion URLs', () => {
    expect(extractNotionPageId('https://www.figma.com/abcdef0123456789abcdef0123456789')).toBe(null)
  })

  it('returns null when no 32-char id is present', () => {
    expect(extractNotionPageId('https://www.notion.so/some-page')).toBe(null)
  })

  it('returns null for invalid URL strings', () => {
    expect(extractNotionPageId('hello world')).toBe(null)
    expect(extractNotionPageId('')).toBe(null)
  })

  it('lowercases the id even when the URL uses upper-case hex', () => {
    expect(
      extractNotionPageId('https://www.notion.so/Brief-ABCDEF0123456789ABCDEF0123456789'),
    ).toBe('abcdef0123456789abcdef0123456789')
  })

  it('rejects partial hex sequences (less than 32 chars)', () => {
    expect(extractNotionPageId('https://www.notion.so/Brief-abc123')).toBe(null)
  })
})
