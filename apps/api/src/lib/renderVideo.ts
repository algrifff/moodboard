import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { rename, rm, stat } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import {
  parseVideoDoc,
  videoFrameCount,
  videoOutputSize,
  videoRenderProblems,
  type VideoFps,
} from '@moodboard/shared'
import { withDocument, type FrameViewport } from './renderFrame'

// HTML → MP4. The composed video document (lib/compose.ts; the same bytes
// every surface serves) is loaded in the shared headless Chromium with the
// network refused, then stepped: for frame i, seek the document's timeline
// to i/fps (pause every animation, set currentTime — the same seek the
// thumbnail path uses), screenshot, and pipe the JPEG to ffmpeg, which
// encodes H.264 yuv420p with the moov atom up front for streaming.
//
// JPEG (quality 95) rather than PNG: Chromium's PNG encode is ~10× slower
// (≈400 ms vs ≈35 ms per 1080p frame) and the H.264 pass that follows
// swallows the difference. Frames go through a pipe, so memory stays flat
// whatever the length. Silent: no audio stream.

export const VIDEO_RENDER_TIMEOUT_MS = 20 * 60_000
const JPEG_QUALITY = 95
const STDERR_TAIL = 2000

export class VideoRenderError extends Error {
  // Retrying won't help: the document is outside the render limits.
  constructor(
    message: string,
    readonly permanent = false,
  ) {
    super(message)
    this.name = 'VideoRenderError'
  }
}

export class VideoRenderCancelled extends Error {
  constructor() {
    super('The render was cancelled')
    this.name = 'VideoRenderCancelled'
  }
}

export type RenderVideoOptions = {
  // The composed standalone document.
  html: string
  viewport: FrameViewport
  fps: VideoFps
  outPath: string
  // Scale the output down so its long edge fits (drafts).
  maxEdge?: number
  // Render only the first part.
  clipMs?: number
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
  timeoutMs?: number
}

export type RenderedVideo = {
  width: number
  height: number
  frames: number
  durationMs: number
  fps: VideoFps
  bytes: number
  // Network requests the document tried (all refused) and page errors.
  blocked: string[]
  errors: string[]
}

type Ffmpeg = ChildProcessByStdio<Writable, null, Readable>

// ffmpeg reading JPEG frames on stdin. Write errors (a dead encoder)
// surface with ffmpeg's own stderr rather than a bare EPIPE.
class Encoder {
  private readonly child: Ffmpeg
  private stderr = ''
  private failure: Error | null = null
  readonly exited: Promise<number | null>

  constructor(args: string[]) {
    this.child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    this.child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-STDERR_TAIL)
    })
    this.child.stdin.on('error', () => undefined)
    this.exited = new Promise((resolve) => {
      this.child.once('error', (e: NodeJS.ErrnoException) => {
        this.failure = new VideoRenderError(
          e.code === 'ENOENT' ? 'ffmpeg isn’t installed on this server' : `ffmpeg: ${e.message}`,
          e.code === 'ENOENT',
        )
        resolve(null)
      })
      this.child.once('close', (code) => resolve(code))
    })
  }

  private died(code: number | null): Error {
    return (
      this.failure ??
      new VideoRenderError(`ffmpeg exited with code ${code}: ${this.stderr.trim() || 'no output'}`)
    )
  }

  async write(frame: Buffer): Promise<void> {
    const stdin = this.child.stdin
    if (stdin.destroyed || this.child.exitCode !== null || this.failure) {
      throw this.died(this.child.exitCode)
    }
    if (stdin.write(frame)) return
    await Promise.race([
      new Promise<void>((resolve) => stdin.once('drain', resolve)),
      this.exited.then((code) => {
        throw this.died(code)
      }),
    ])
  }

  async finish(): Promise<void> {
    this.child.stdin.end()
    const code = await this.exited
    if (code !== 0) throw this.died(code)
  }

  kill(): void {
    this.child.kill('SIGKILL')
  }
}

export function ffmpegArgs(args: {
  fps: number
  width: number
  height: number
  outPath: string
}): string[] {
  const { fps, width, height } = args
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'image2pipe',
    '-framerate',
    String(fps),
    '-c:v',
    'mjpeg',
    '-i',
    'pipe:0',
    // Full-range sRGB JPEG in, limited-range BT.709 yuv420p out, so players
    // show the colours the page had.
    '-vf',
    `scale=${width}:${height}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '18',
    '-g',
    String(fps * 2),
    '-pix_fmt',
    'yuv420p',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-r',
    String(fps),
    '-an',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    args.outPath,
  ]
}

export async function renderVideo(opts: RenderVideoOptions): Promise<RenderedVideo> {
  const doc = parseVideoDoc(opts.html)
  if (!doc) {
    throw new VideoRenderError('This document has no data-duration, so it isn’t a video.', true)
  }
  const durationMs = Math.min(doc.durationMs, opts.clipMs ?? doc.durationMs)
  const problems = videoRenderProblems({ viewport: opts.viewport, durationMs, fps: opts.fps })
  if (problems.length > 0) throw new VideoRenderError(problems.join('; '), true)

  const out = videoOutputSize(opts.viewport, opts.maxEdge)
  const scale = out.width / opts.viewport.width
  const frames = videoFrameCount(durationMs, opts.fps)
  const partial = `${opts.outPath}.partial`
  const encoder = new Encoder(ffmpegArgs({ fps: opts.fps, ...out, outPath: partial }))
  const cancelled = () => opts.signal?.aborted === true
  const onAbort = () => encoder.kill()
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const { blocked, errors } = await withDocument(
      opts.html,
      {
        viewport: opts.viewport,
        deviceScaleFactor: scale,
        timeoutMs: opts.timeoutMs ?? VIDEO_RENDER_TIMEOUT_MS,
        pool: 'video',
      },
      async (handle) => {
        const page = handle.page
        const timeline = await page.evaluate(() => {
          const t = (window as unknown as { __moodboardTimeline?: { duration: number } })
            .__moodboardTimeline
          return t ? { duration: t.duration } : null
        })
        if (!timeline) {
          throw new VideoRenderError('The document has no seekable timeline.', true)
        }
        for (let i = 0; i < frames; i++) {
          if (cancelled()) throw new VideoRenderCancelled()
          const time = (i * 1000) / opts.fps
          await page.evaluate(
            (t) =>
              (
                window as unknown as { __moodboardTimeline: { seek(t: number): void } }
              ).__moodboardTimeline.seek(t),
            time,
          )
          const jpeg = await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY })
          await encoder.write(jpeg)
          opts.onProgress?.(i + 1, frames)
        }
        return { blocked: handle.blocked, errors: handle.errors }
      },
    )
    await encoder.finish()
    await rename(partial, opts.outPath)
    const { size } = await stat(opts.outPath)
    return { ...out, frames, durationMs, fps: opts.fps, bytes: size, blocked, errors }
  } catch (e) {
    encoder.kill()
    await rm(partial, { force: true })
    if (cancelled()) throw new VideoRenderCancelled()
    throw e
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    await rm(partial, { force: true })
  }
}
