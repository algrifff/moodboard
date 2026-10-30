import { describe, expect, it } from 'vitest'
import {
  VIDEO_MAX_DURATION_MS,
  VIDEO_MAX_FRAMES,
  parseVideoDoc,
  renderVideoPayloadSchema,
  videoDurationProblem,
  videoFrameCount,
  videoOutputSize,
  videoRenderProblems,
} from './video'

describe('parseVideoDoc', () => {
  it('reads the root’s duration and defaults the poster to 35% in', () => {
    const doc = parseVideoDoc('<main class="spot" data-duration="15000"><h1>Hi</h1></main>')
    expect(doc).toEqual({ durationMs: 15000, posterMs: 5250 })
  })

  it('honours data-poster, clamped to the duration', () => {
    expect(parseVideoDoc('<main data-duration="4000" data-poster="1500">x</main>')?.posterMs).toBe(
      1500,
    )
    expect(parseVideoDoc('<main data-duration="4000" data-poster="99999">x</main>')?.posterMs).toBe(
      4000,
    )
  })

  it('is not a video without a valid duration', () => {
    expect(parseVideoDoc('<main>no duration</main>')).toBeNull()
    expect(parseVideoDoc('<main data-duration="soon">x</main>')).toBeNull()
    expect(parseVideoDoc('<main data-duration="0">x</main>')).toBeNull()
    expect(parseVideoDoc('<p data-duration=" ">x</p>')).toBeNull()
  })

  it('ignores a data-duration mentioned inside a script or comment', () => {
    expect(parseVideoDoc('<!-- data-duration="9000" --><script>"data-duration=1"</script>')).toBe(
      null,
    )
  })
})

describe('videoDurationProblem', () => {
  it('passes documents that are not videos and valid videos', () => {
    expect(videoDurationProblem('<main>x</main>')).toBeNull()
    expect(videoDurationProblem('<main data-duration="15000">x</main>')).toBeNull()
  })

  it('names what is wrong', () => {
    expect(videoDurationProblem('<main data-duration="abc">x</main>')).toMatch(/positive number/)
    expect(videoDurationProblem('<main data-duration="100">x</main>')).toMatch(/at least/)
    expect(
      videoDurationProblem(`<main data-duration="${VIDEO_MAX_DURATION_MS + 1}">x</main>`),
    ).toMatch(/at most/)
  })
})

describe('frames and sizes', () => {
  it('counts frames for the duration at the frame rate', () => {
    expect(videoFrameCount(15000, 30)).toBe(450)
    expect(videoFrameCount(15000, 60)).toBe(900)
    expect(videoFrameCount(500, 30)).toBe(15)
  })

  it('scales the output down to maxEdge with even sides', () => {
    expect(videoOutputSize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 })
    expect(videoOutputSize({ width: 1920, height: 1080 }, 480)).toEqual({ width: 480, height: 270 })
    expect(videoOutputSize({ width: 1080, height: 1920 }, 960)).toEqual({ width: 540, height: 960 })
    const odd = videoOutputSize({ width: 1281, height: 721 })
    expect(odd.width % 2).toBe(0)
    expect(odd.height % 2).toBe(0)
  })

  it('never upscales', () => {
    expect(videoOutputSize({ width: 1280, height: 720 }, 1920)).toEqual({
      width: 1280,
      height: 720,
    })
  })
})

describe('videoRenderProblems', () => {
  const hd = { width: 1920, height: 1080 }

  it('accepts a 15s 1080p spot at either frame rate', () => {
    expect(videoRenderProblems({ viewport: hd, durationMs: 15000, fps: 30 })).toEqual([])
    expect(videoRenderProblems({ viewport: hd, durationMs: 15000, fps: 60 })).toEqual([])
  })

  it('accepts the vertical variant', () => {
    expect(
      videoRenderProblems({ viewport: { width: 1080, height: 1920 }, durationMs: 15000, fps: 30 }),
    ).toEqual([])
  })

  it('refuses anything bigger than 1080p or longer than a minute', () => {
    expect(
      videoRenderProblems({ viewport: { width: 3840, height: 2160 }, durationMs: 1000, fps: 30 }),
    ).not.toEqual([])
    expect(
      videoRenderProblems({ viewport: hd, durationMs: VIDEO_MAX_DURATION_MS + 1, fps: 30 }),
    ).not.toEqual([])
  })

  it('caps the frame count, so 60 fps allows half the duration', () => {
    expect(VIDEO_MAX_FRAMES).toBe(1800)
    expect(videoRenderProblems({ viewport: hd, durationMs: 30000, fps: 60 })).toEqual([])
    expect(videoRenderProblems({ viewport: hd, durationMs: 31000, fps: 60 })[0]).toMatch(/frame/)
  })
})

describe('renderVideoPayloadSchema', () => {
  it('takes only 30 or 60 fps', () => {
    const base = { outputId: 'o', version: 1 }
    expect(renderVideoPayloadSchema.safeParse({ ...base, fps: 30 }).success).toBe(true)
    expect(renderVideoPayloadSchema.safeParse({ ...base, fps: 24 }).success).toBe(false)
  })
})
