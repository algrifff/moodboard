import { describe, expect, it } from 'vitest'
import { deriveFontFamily } from './fontFamily'

describe('deriveFontFamily', () => {
  it('strips a font extension', () => {
    expect(deriveFontFamily('Inter.ttf')).toBe('Inter')
    expect(deriveFontFamily('Inter.otf')).toBe('Inter')
    expect(deriveFontFamily('Inter.woff')).toBe('Inter')
    expect(deriveFontFamily('Inter.woff2')).toBe('Inter')
  })

  it('converts dashes to spaces', () => {
    expect(deriveFontFamily('AktivGrotesk-Bold.woff2')).toBe('AktivGrotesk Bold')
    expect(deriveFontFamily('helvetica-neue-roman.otf')).toBe('helvetica neue roman')
  })

  it('converts underscores to spaces', () => {
    expect(deriveFontFamily('inter_variable.ttf')).toBe('inter variable')
  })

  it('collapses runs of dashes/underscores', () => {
    expect(deriveFontFamily('foo--bar__baz.ttf')).toBe('foo bar baz')
  })

  it('strips POSIX path prefixes', () => {
    expect(deriveFontFamily('/usr/share/fonts/Inter.ttf')).toBe('Inter')
    expect(deriveFontFamily('./fonts/AktivGrotesk-Bold.woff2')).toBe('AktivGrotesk Bold')
  })

  it('strips Windows path prefixes', () => {
    expect(deriveFontFamily('C:\\Users\\me\\Inter.ttf')).toBe('Inter')
  })

  it('handles filenames with no extension', () => {
    expect(deriveFontFamily('noname')).toBe('noname')
    expect(deriveFontFamily('CustomThing')).toBe('CustomThing')
  })

  it('falls back to "Custom Font" for empty or whitespace-only input', () => {
    expect(deriveFontFamily('')).toBe('Custom Font')
    expect(deriveFontFamily('   ')).toBe('Custom Font')
    expect(deriveFontFamily('.ttf')).toBe('Custom Font')
    expect(deriveFontFamily('-.woff')).toBe('Custom Font')
  })

  it('preserves camelCase joined identifiers', () => {
    // The font designer chose CamelCase deliberately; we don't try to
    // split it into "Aktiv Grotesk" because heuristics there are wrong
    // as often as right (PingFangSC, IBMPlexMono, etc.).
    expect(deriveFontFamily('AktivGrotesk.ttf')).toBe('AktivGrotesk')
  })
})
