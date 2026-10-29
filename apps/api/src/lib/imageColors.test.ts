import { describe, expect, it } from 'vitest'
import { dominantColors } from './imageColors'

function pixels(
  spec: [r: number, g: number, b: number, n: number, a?: number][],
): Uint8ClampedArray {
  const out: number[] = []
  for (const [r, g, b, n, a = 255] of spec) for (let i = 0; i < n; i++) out.push(r, g, b, a)
  return Uint8ClampedArray.from(out)
}

describe('dominantColors', () => {
  it('orders colours by how much of the image they cover', () => {
    const px = pixels([
      [200, 30, 30, 50],
      [30, 30, 200, 120],
      [30, 200, 30, 10],
    ])
    expect(dominantColors(px, { max: 3 })).toEqual(['#1E1EC8', '#C81E1E', '#1EC81E'])
  })

  it('ignores transparent pixels and caps the count', () => {
    const px = pixels([
      [200, 30, 30, 50],
      [30, 30, 200, 500, 0],
    ])
    expect(dominantColors(px, { max: 1 })).toEqual(['#C81E1E'])
  })

  it('drops whites, blacks and greys unless asked to fall back', () => {
    const px = pixels([
      [255, 255, 255, 80],
      [5, 5, 5, 20],
    ])
    expect(dominantColors(px)).toEqual([])
    expect(dominantColors(px, { fallbackToNeutrals: true })).toEqual(['#FFFFFF', '#050505'])
  })

  it('merges shades that are within minDistance of a colour already taken', () => {
    const px = pixels([
      [30, 30, 200, 100],
      [34, 34, 204, 90],
      [200, 30, 30, 40],
    ])
    expect(dominantColors(px, { max: 2 })).toHaveLength(2)
    expect(dominantColors(px, { max: 2, minDistance: 40 })).toEqual(['#1E1EC8', '#C81E1E'])
  })

  it('returns nothing for an empty buffer', () => {
    expect(dominantColors(new Uint8ClampedArray(0))).toEqual([])
  })
})
