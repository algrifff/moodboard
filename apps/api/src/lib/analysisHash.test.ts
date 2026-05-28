import type { CanvasObject } from '@moodboard/shared'
import { describe, expect, it } from 'vitest'
import { analysisHash } from './analysisHash'

const sticky = (id: string, text: string, color = '#FEF3C7'): CanvasObject => ({
  id,
  type: 'sticky',
  position: { x: 0, y: 0 },
  size: { width: 200, height: 200 },
  rotation: 0,
  zIndex: 0,
  data: { text, color },
})

const image = (id: string, url: string): CanvasObject => ({
  id,
  type: 'image',
  position: { x: 0, y: 0 },
  size: { width: 400, height: 400 },
  rotation: 0,
  zIndex: 0,
  data: { url },
})

describe('analysisHash', () => {
  it('is stable across object ordering', () => {
    const a = analysisHash([sticky('a', 'foo'), sticky('b', 'bar')], 'm1')
    const b = analysisHash([sticky('b', 'bar'), sticky('a', 'foo')], 'm1')
    expect(a).toBe(b)
  })

  it('changes when text content changes', () => {
    const a = analysisHash([sticky('a', 'foo')], 'm1')
    const b = analysisHash([sticky('a', 'bar')], 'm1')
    expect(a).not.toBe(b)
  })

  it('changes when sticky color changes', () => {
    const a = analysisHash([sticky('a', 'foo', '#FEF3C7')], 'm1')
    const b = analysisHash([sticky('a', 'foo', '#A7F3D0')], 'm1')
    expect(a).not.toBe(b)
  })

  it('changes when image url changes', () => {
    const a = analysisHash([image('a', '/api/files/x.png')], 'm1')
    const b = analysisHash([image('a', '/api/files/y.png')], 'm1')
    expect(a).not.toBe(b)
  })

  it('changes when membership changes', () => {
    const base = [sticky('a', 'foo')]
    const grown = [...base, sticky('b', 'bar')]
    expect(analysisHash(base, 'm1')).not.toBe(analysisHash(grown, 'm1'))
  })

  it('changes when model tag changes', () => {
    const a = analysisHash([sticky('a', 'foo')], 'haiku')
    const b = analysisHash([sticky('a', 'foo')], 'sonnet')
    expect(a).not.toBe(b)
  })

  it('produces a hex string of expected length', () => {
    const h = analysisHash([sticky('a', 'foo')], 'm1')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })
})
