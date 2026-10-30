import { describe, expect, it } from 'vitest'
import { DESIGNER_MODEL_TAG, designCacheKey, type DesignCacheInput } from './designHash'

const base: DesignCacheInput = {
  brief: 'Thumbnail for the launch video — punchy, dark.',
  clientId: 'acme',
  kitId: 'kit-1',
  kitVersion: 3,
  templates: [
    { id: 't-thumb', version: 2 },
    { id: 't-custom', version: 1 },
  ],
  assetIds: ['a1', 'a2', 'a3'],
  format: 'thumbnail',
  variantIndex: 1,
  modelTag: DESIGNER_MODEL_TAG,
}

describe('designCacheKey', () => {
  it('is stable across ordering and brief whitespace', () => {
    const key = designCacheKey(base)
    expect(
      designCacheKey({
        ...base,
        brief: '  Thumbnail for the launch video —\n punchy,   dark. ',
        templates: [...base.templates].reverse(),
        assetIds: ['a3', 'a1', 'a2', 'a1'],
      }),
    ).toBe(key)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each<[string, Partial<DesignCacheInput>]>([
    ['brief', { brief: 'Thumbnail for the launch video — calm, light.' }],
    ['client', { clientId: 'globex' }],
    ['kit', { kitId: 'kit-2' }],
    ['kit version', { kitVersion: 4 }],
    ['template version', { templates: [{ id: 't-thumb', version: 3 }, base.templates[1]!] }],
    ['library', { assetIds: [...base.assetIds, 'a4'] }],
    ['format', { format: 'social' }],
    ['variant', { variantIndex: 2 }],
    ['model tag', { modelTag: 'designer@other@v1' }],
    ['attached Figma frame', { figmaFrames: ['K:12:34@2026-03-04T10:00:00Z'] }],
  ])('changes with the %s', (_label, patch) => {
    expect(designCacheKey({ ...base, ...patch })).not.toBe(designCacheKey(base))
  })

  it('keys a Figma reference by file, frame and version, regardless of order', () => {
    const frames = ['K:12:34@2026-03-04T10:00:00Z', 'K:12:40@2026-03-04T10:00:00Z']
    const key = designCacheKey({ ...base, figmaFrames: frames })
    expect(designCacheKey({ ...base, figmaFrames: [...frames].reverse() })).toBe(key)
    expect(
      designCacheKey({ ...base, figmaFrames: [frames[0]!.replace('03-04', '05-01'), frames[1]!] }),
    ).not.toBe(key)
    // No frames is the key it always was.
    expect(designCacheKey({ ...base, figmaFrames: [] })).toBe(designCacheKey(base))
  })
})
