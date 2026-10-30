import type { CanvasObject } from '@moodboard/shared'
import { describe, expect, it } from 'vitest'
import {
  applySaveResult,
  diffObjects,
  foldServerObjects,
  isEmptyDiff,
  syncedStateFrom,
} from './boardSync'

function sticky(id: string, text = id): CanvasObject {
  return {
    id,
    type: 'sticky',
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    rotation: 0,
    zIndex: 0,
    data: { text, color: '#fff' },
  }
}

describe('diffObjects', () => {
  it('is empty when nothing changed', () => {
    const a = sticky('a')
    const state = syncedStateFrom([a], { a: 1 })
    expect(isEmptyDiff(diffObjects(state, [a]))).toBe(true)
  })

  it('ignores a new reference with identical content', () => {
    const state = syncedStateFrom([sticky('a')], { a: 1 })
    expect(isEmptyDiff(diffObjects(state, [sticky('a')]))).toBe(true)
  })

  it('sends creates with a null base and edits with the known version', () => {
    const state = syncedStateFrom([sticky('a')], { a: 3 })
    const diff = diffObjects(state, [sticky('a', 'edited'), sticky('b')])
    expect(diff.upserts.map((u) => [u.object.id, u.baseVersion])).toEqual([
      ['a', 3],
      ['b', null],
    ])
    expect(diff.deletes).toEqual([])
  })

  it('sends deletes for saved objects that disappeared', () => {
    const state = syncedStateFrom([sticky('a'), sticky('b')], { a: 1, b: 4 })
    const diff = diffObjects(state, [sticky('a')])
    expect(diff.deletes).toEqual([{ id: 'b', baseVersion: 4 }])
  })
})

describe('applySaveResult', () => {
  it('records applied versions so the next diff is empty', () => {
    const state = syncedStateFrom([], {})
    const current = [sticky('a')]
    const sent = diffObjects(state, current)
    const out = applySaveResult(state, sent, { versions: { a: 1 }, conflicts: [] })
    expect(out).toEqual({ adopt: [], remove: [] })
    expect(isEmptyDiff(diffObjects(state, current))).toBe(true)
  })

  it('adopts the server copy on conflict and stops resending', () => {
    const state = syncedStateFrom([sticky('a')], { a: 1 })
    const sent = diffObjects(state, [sticky('a', 'mine')])
    const theirs = sticky('a', 'theirs')
    const out = applySaveResult(state, sent, {
      versions: {},
      conflicts: [{ id: 'a', object: theirs, version: 2 }],
    })
    expect(out.adopt).toEqual([theirs])
    expect(isEmptyDiff(diffObjects(state, [theirs]))).toBe(true)
  })

  it('removes locally when the server says the object is gone', () => {
    const state = syncedStateFrom([sticky('a')], { a: 1 })
    const sent = diffObjects(state, [sticky('a', 'mine')])
    const out = applySaveResult(state, sent, {
      versions: {},
      conflicts: [{ id: 'a', object: null, version: null }],
    })
    expect(out.remove).toEqual(['a'])
    expect(isEmptyDiff(diffObjects(state, []))).toBe(true)
  })

  it('keeps a delete that lost to a newer copy', () => {
    const state = syncedStateFrom([sticky('a')], { a: 1 })
    const sent = diffObjects(state, [])
    const theirs = sticky('a', 'theirs')
    const out = applySaveResult(state, sent, {
      versions: {},
      conflicts: [{ id: 'a', object: theirs, version: 2 }],
    })
    expect(out.adopt).toEqual([theirs])
    expect(state.versions.get('a')).toBe(2)
  })
})

describe('foldServerObjects', () => {
  it('adopts newer server copies and marks them saved', () => {
    const state = syncedStateFrom([sticky('a')], { a: 1 })
    const moved = { ...sticky('a'), position: { x: 300, y: 0 } }
    const adopt = foldServerObjects(state, [
      { object: moved, version: 2 },
      { object: sticky('n'), version: 1 },
    ])
    expect(adopt.map((o) => o.id)).toEqual(['a', 'n'])
    expect(state.versions.get('a')).toBe(2)
    // Autosave now sees the canvas (which adopted them) as clean.
    expect(isEmptyDiff(diffObjects(state, adopt))).toBe(true)
  })

  it('skips copies we already hold at that version or newer', () => {
    const state = syncedStateFrom([sticky('a', 'mine')], { a: 3 })
    expect(foldServerObjects(state, [{ object: sticky('a', 'old'), version: 2 }])).toEqual([])
    expect((state.saved.get('a')!.data as { text: string }).text).toBe('mine')
  })

  it('a local edit made after the fold saves against the new version', () => {
    const state = syncedStateFrom([sticky('a')], { a: 1 })
    const [adopted] = foldServerObjects(state, [{ object: sticky('a', 'agent'), version: 2 }])
    const edited = { ...adopted!, data: { text: 'mine', color: '#fff' } }
    expect(diffObjects(state, [edited]).upserts[0]!.baseVersion).toBe(2)
  })
})
