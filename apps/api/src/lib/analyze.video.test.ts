import type { CanvasObject, VideoClipBreakdown } from '@moodboard/shared'
import { describe, expect, it } from 'vitest'
import { assembleVideoEditorBreakdown, mapWithConcurrency, videoClipCacheTag } from './videoClips'
import { analysisHash } from './analysisHash'

const videoClip = (id: string, videoId = 'vid1', title = 'How we built it'): CanvasObject => ({
  id,
  type: 'video-clip',
  position: { x: 0, y: 0 },
  size: { width: 320, height: 290 },
  rotation: 0,
  zIndex: 0,
  data: {
    platform: 'youtube',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    title,
    channel: 'Acme',
    durationSec: 213,
    thumbnailUrl: '/api/files/thumb.jpg',
    fetchedAt: '2026-05-30T00:00:00Z',
  },
})

const breakdown = (videoId: string): VideoClipBreakdown => ({
  videoId,
  title: 'A clip',
  platform: 'youtube',
  url: `https://youtu.be/${videoId}`,
  summary: 'tight',
  hooks: [
    { timestamp: '0:00', what: 'cold open', whyItWorks: 'pattern break', howToReplicate: 'do x' },
  ],
  transitions: [],
  soundDesign: [],
  spokenBeats: [],
  pacing: 'fast',
  replicationPlaybook: ['step 1'],
})

describe('videoClipCacheTag', () => {
  it('is a stable, model-scoped string distinct from the editor group tag', () => {
    expect(videoClipCacheTag()).toBe(videoClipCacheTag())
    expect(videoClipCacheTag()).toMatch(/^video-clip@gemini-.*@v\d+$/)
    expect(videoClipCacheTag().startsWith('video-editor@')).toBe(false)
  })
})

describe('per-clip cache key (the token-saving property)', () => {
  it('keys each clip on the clip alone, so it is insensitive to group composition', () => {
    const tag = videoClipCacheTag()
    const a = videoClip('a', 'vid1')
    const b = videoClip('b', 'vid2')

    // A whole-group key changes the moment any other object joins the group —
    // that's what re-bills every clip on regroup.
    expect(analysisHash([a, b], tag)).not.toBe(analysisHash([a], tag))

    // The per-clip key the route actually uses for A is just hash([a]) — the
    // same value no matter what else is on the canvas, so A is sent to Gemini
    // exactly once, ever.
    expect(analysisHash([a], tag)).toBe(analysisHash([a], tag))

    // Different videos get different buckets.
    expect(analysisHash([a], tag)).not.toBe(analysisHash([b], tag))
  })
})

describe('assembleVideoEditorBreakdown', () => {
  it('returns an empty-state note when there are no clips', () => {
    const out = assembleVideoEditorBreakdown([], 0)
    expect(out.clips).toEqual([])
    expect(out.note).toBeTruthy()
    expect(out.skipped).toBeUndefined()
  })

  it('omits skipped when nothing was dropped', () => {
    const out = assembleVideoEditorBreakdown([breakdown('vid1')], 0)
    expect(out).toEqual({ clips: [breakdown('vid1')] })
    expect(out.skipped).toBeUndefined()
    expect(out.note).toBeUndefined()
  })

  it('surfaces the skipped count when the cap dropped clips', () => {
    const out = assembleVideoEditorBreakdown([breakdown('vid1')], 3)
    expect(out.skipped).toBe(3)
    expect(out.clips).toHaveLength(1)
  })
})

describe('mapWithConcurrency', () => {
  it('preserves input order in the output', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10)
    expect(out).toEqual([10, 20, 30, 40, 50])
  })

  it('never runs more than `limit` tasks at once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6], 3, async (n) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return n
    })
    expect(maxInFlight).toBe(3)
  })

  it('handles empty input', async () => {
    expect(await mapWithConcurrency([], 3, async (n) => n)).toEqual([])
  })
})
