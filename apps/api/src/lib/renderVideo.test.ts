import { HOUSE_KIT_TOKENS, kitToCss, viewportSize } from '@moodboard/shared'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromiumAvailable } from './browser'
import { composeDocument } from './compose'
import { closeBrowser } from './browser'
import { loadStarterTemplates } from './starterTemplateFiles'
import { renderVideo, VideoRenderCancelled, VideoRenderError } from './renderVideo'

const run = promisify(execFile)

async function probe(file: string) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    file,
  ])
  return JSON.parse(stdout) as {
    streams: {
      codec_type: string
      codec_name: string
      pix_fmt?: string
      width?: number
      height?: number
      nb_read_frames?: string
      r_frame_rate?: string
      profile?: string
      color_space?: string
    }[]
    format: { duration: string; format_name: string }
  }
}

// Top-level MP4 atoms in file order: faststart puts moov before mdat.
async function atoms(file: string): Promise<string[]> {
  const buf = await readFile(file)
  const out: string[] = []
  for (let i = 0; i + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(i)
    out.push(buf.toString('ascii', i + 4, i + 8))
    if (size < 8) break
    i += size
  }
  return out
}

function doc(body: string, css: string, extra = '') {
  return composeDocument({
    title: 'Test',
    format: 'video',
    viewport: { kind: 'fixed', width: 640, height: 360 },
    html: `<main class="v" data-duration="2000" ${extra}>${body}</main>`,
    css: `html,body{margin:0;width:640px;height:360px;overflow:hidden;background:#101018}${css}`,
    js: '',
    kitCss: kitToCss(HOUSE_KIT_TOKENS),
    kitHasLogo: false,
    values: {},
    assets: new Map(),
  }).html
}

// A bar sweeping across over the whole 2s, with a delayed fade-in.
const SWEEP = doc(
  '<div class="bar"></div><p class="t">Hello</p>',
  `.bar{position:absolute;left:0;top:140px;height:80px;width:80px;background:#f3b61f;animation:sweep 2000ms linear both}
   .t{position:absolute;left:40px;top:40px;margin:0;color:#fff;font:700 48px sans-serif;animation:fade 500ms 1000ms both}
   @keyframes sweep{from{transform:translateX(0)}to{transform:translateX(560px)}}
   @keyframes fade{from{opacity:0}to{opacity:1}}`,
)

const hasBrowser = chromiumAvailable()
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mb-video-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  await closeBrowser()
})

describe.skipIf(!hasBrowser)('renderVideo', () => {
  it('encodes an H.264 yuv420p MP4 of the right size, length and frame count', async () => {
    const out = path.join(dir, 'sweep.mp4')
    const progress: number[] = []
    const result = await renderVideo({
      html: SWEEP,
      viewport: { width: 640, height: 360 },
      fps: 30,
      outPath: out,
      onProgress: (done) => progress.push(done),
    })
    expect(result).toMatchObject({ width: 640, height: 360, frames: 60, fps: 30, durationMs: 2000 })
    expect(result.blocked).toEqual([])
    expect(result.errors).toEqual([])
    expect(progress.at(-1)).toBe(60)

    const info = await probe(out)
    const video = info.streams.find((s) => s.codec_type === 'video')!
    expect(video).toMatchObject({
      codec_name: 'h264',
      pix_fmt: 'yuv420p',
      width: 640,
      height: 360,
      nb_read_frames: '60',
      r_frame_rate: '30/1',
      color_space: 'bt709',
    })
    expect(info.streams.filter((s) => s.codec_type === 'audio')).toEqual([])
    expect(Number(info.format.duration)).toBeCloseTo(2, 1)
    expect(info.format.format_name).toContain('mp4')
    const order = await atoms(out)
    expect(order.indexOf('moov')).toBeGreaterThan(-1)
    expect(order.indexOf('moov')).toBeLessThan(order.indexOf('mdat'))
    expect((await stat(out)).size).toBe(result.bytes)
    expect(await stat(`${out}.partial`).catch(() => null)).toBeNull()
  }, 60_000)

  it('renders at 60 fps, a clip, and a draft size with even sides', async () => {
    const out = path.join(dir, 'clip.mp4')
    const result = await renderVideo({
      html: SWEEP,
      viewport: { width: 640, height: 360 },
      fps: 60,
      outPath: out,
      clipMs: 1000,
      maxEdge: 320,
    })
    expect(result).toMatchObject({ width: 320, height: 180, frames: 60, durationMs: 1000 })
    const video = (await probe(out)).streams.find((s) => s.codec_type === 'video')!
    expect(video).toMatchObject({ width: 320, height: 180, nb_read_frames: '60' })
    expect(video.r_frame_rate).toBe('60/1')
  }, 60_000)

  it('steps the document’s timeline: the first and last frames differ', async () => {
    const frames: Buffer[] = []
    const { withDocument } = await import('./renderFrame')
    await withDocument(SWEEP, { viewport: { width: 640, height: 360 } }, async (handle) => {
      for (const t of [0, 1000, 1999]) {
        await handle.page.evaluate(
          (time) =>
            (
              window as unknown as { __moodboardTimeline: { seek(t: number): void } }
            ).__moodboardTimeline.seek(time),
          t,
        )
        frames.push(await handle.screenshot())
      }
    })
    expect(frames[0]!.equals(frames[1]!)).toBe(false)
    expect(frames[1]!.equals(frames[2]!)).toBe(false)
  }, 30_000)

  it.each(['promo-spot', 'promo-spot-vertical'])(
    'renders a short clip of the %s starter template',
    async (key) => {
      const starter = (await loadStarterTemplates()).find((s) => s.key === key)!
      const viewport = viewportSize(starter.viewport)
      const html = composeDocument({
        title: starter.name,
        format: starter.format,
        viewport: starter.viewport,
        html: starter.html,
        css: starter.css,
        js: starter.js,
        kitCss: kitToCss(HOUSE_KIT_TOKENS),
        kitHasLogo: false,
        values: {},
        assets: new Map(),
      }).html
      const out = path.join(dir, `${key}.mp4`)
      const result = await renderVideo({
        html,
        viewport,
        fps: 30,
        outPath: out,
        clipMs: 1500,
        maxEdge: 480,
      })
      const wide = viewport.width > viewport.height
      expect(result).toMatchObject({
        width: wide ? 480 : 270,
        height: wide ? 270 : 480,
        frames: 45,
      })
      const info = await probe(out)
      const video = info.streams.find((s) => s.codec_type === 'video')!
      expect(video).toMatchObject({
        codec_name: 'h264',
        pix_fmt: 'yuv420p',
        width: result.width,
        height: result.height,
        nb_read_frames: '45',
      })
      expect(Number(info.format.duration)).toBeCloseTo(1.5, 1)
    },
    60_000,
  )

  it('refuses a document that is not a video, or is outside the limits, before rendering', async () => {
    const plain = SWEEP.replace(/ data-duration="2000"/, '')
    await expect(
      renderVideo({
        html: plain,
        viewport: { width: 640, height: 360 },
        fps: 30,
        outPath: path.join(dir, 'no.mp4'),
      }),
    ).rejects.toMatchObject({ name: 'VideoRenderError', permanent: true })

    const long = SWEEP.replace('data-duration="2000"', 'data-duration="90000"')
    await expect(
      renderVideo({
        html: long,
        viewport: { width: 640, height: 360 },
        fps: 30,
        outPath: path.join(dir, 'long.mp4'),
      }),
    ).rejects.toBeInstanceOf(VideoRenderError)

    await expect(
      renderVideo({
        html: SWEEP,
        viewport: { width: 3840, height: 2160 },
        fps: 30,
        outPath: path.join(dir, 'huge.mp4'),
      }),
    ).rejects.toThrow(/longest edge/)
    expect(await stat(path.join(dir, 'no.mp4')).catch(() => null)).toBeNull()
  })

  it('cancels mid-render and leaves no file behind', async () => {
    const out = path.join(dir, 'cancel.mp4')
    const controller = new AbortController()
    const promise = renderVideo({
      html: SWEEP,
      viewport: { width: 640, height: 360 },
      fps: 60,
      outPath: out,
      signal: controller.signal,
      onProgress: (done) => {
        if (done === 10) controller.abort()
      },
    })
    await expect(promise).rejects.toBeInstanceOf(VideoRenderCancelled)
    expect(await stat(out).catch(() => null)).toBeNull()
    expect(await stat(`${out}.partial`).catch(() => null)).toBeNull()
  }, 30_000)
})
