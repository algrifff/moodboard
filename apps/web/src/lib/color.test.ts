import { describe, expect, it } from 'vitest'
import { readableOn } from './color'

describe('readableOn', () => {
  it('returns dark text on white', () => {
    expect(readableOn('#ffffff')).toBe('#0f172a')
  })

  it('returns light text on black', () => {
    expect(readableOn('#000000')).toBe('#f8fafc')
  })

  it('returns dark text on a typical light sticky note yellow', () => {
    expect(readableOn('#FEF3C7')).toBe('#0f172a')
  })

  it('returns light text on a saturated dark blue', () => {
    expect(readableOn('#0f172a')).toBe('#f8fafc')
  })

  it('handles uppercase hex', () => {
    expect(readableOn('#FFFFFF')).toBe('#0f172a')
  })

  it('falls back to dark text for malformed input', () => {
    expect(readableOn('not a hex')).toBe('#0f172a')
    expect(readableOn('')).toBe('#0f172a')
    expect(readableOn('#fff')).toBe('#0f172a') // 3-digit not supported
    expect(readableOn('#fffffff')).toBe('#0f172a') // too long
  })

  it('threshold lands light at moderately bright greens', () => {
    // sRGB-bright greens have very high luma due to the 0.587 weight —
    // dark text wins.
    expect(readableOn('#00ff00')).toBe('#0f172a')
  })

  it('threshold flips around mid-grey', () => {
    // The 0.55 cutoff translates to roughly #8c8c8c — should still be
    // light text.
    expect(readableOn('#808080')).toBe('#f8fafc')
    // A few stops brighter should flip.
    expect(readableOn('#a0a0a0')).toBe('#0f172a')
  })
})
