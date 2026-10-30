import { z } from 'zod'
import { firstAttributeValue } from './slots'

// Phase 25 — HTML → MP4. A video is an ordinary fixed-size output whose root
// carries `data-duration` (ms) and whose motion is CSS keyframes / WAAPI with
// explicit delays, so the whole timeline is seekable: the renderer pauses
// every animation and sets `currentTime` per frame. Silent for v1.

export const VIDEO_FPS_OPTIONS = [30, 60] as const
export const videoFpsSchema = z.union([z.literal(30), z.literal(60)])
export type VideoFps = z.infer<typeof videoFpsSchema>
export const DEFAULT_VIDEO_FPS: VideoFps = 30

// Render limits. Anything over is refused by the renderer, the enqueue route
// and the agent's edit tools alike (videoDocProblems / videoRenderProblems).
export const VIDEO_MIN_DURATION_MS = 500
export const VIDEO_MAX_DURATION_MS = 60_000
export const VIDEO_MAX_EDGE = 1920
export const VIDEO_MAX_PIXELS = 1920 * 1080
export const VIDEO_MAX_FRAMES = 1800

export const videoDocSchema = z.object({
  durationMs: z.number().int(),
  // The moment that stands for the video: its thumbnail and poster.
  posterMs: z.number().int(),
})
export type VideoDoc = z.infer<typeof videoDocSchema>

function attrNumber(html: string, name: string): number | null {
  const raw = firstAttributeValue(html, name)
  if (raw === null) return null
  const n = Number(raw.trim())
  return raw.trim() !== '' && Number.isFinite(n) ? n : Number.NaN
}

// A document is a video when some tag carries a valid data-duration.
// `data-poster` (ms) picks the representative still; otherwise 35% in.
export function parseVideoDoc(html: string): VideoDoc | null {
  const duration = attrNumber(html, 'data-duration')
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return null
  const durationMs = Math.round(duration)
  const poster = attrNumber(html, 'data-poster')
  const posterMs =
    poster !== null && Number.isFinite(poster)
      ? Math.min(Math.max(0, Math.round(poster)), durationMs)
      : Math.round(durationMs * 0.35)
  return { durationMs, posterMs }
}

// What is wrong with a document's video declaration, or null. Documents
// without a data-duration at all are simply not videos.
export function videoDurationProblem(html: string): string | null {
  const raw = firstAttributeValue(html, 'data-duration')
  if (raw === null) return null
  const n = Number(raw.trim())
  if (raw.trim() === '' || !Number.isFinite(n) || n <= 0) {
    return 'data-duration must be a positive number of milliseconds'
  }
  if (n < VIDEO_MIN_DURATION_MS) return `Videos are at least ${VIDEO_MIN_DURATION_MS}ms long`
  if (n > VIDEO_MAX_DURATION_MS) {
    return `Videos are at most ${VIDEO_MAX_DURATION_MS / 1000}s long (data-duration is ${Math.round(n)}ms)`
  }
  return null
}

export function videoFrameCount(durationMs: number, fps: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * fps))
}

// The output size: the viewport, scaled down so its long edge fits `maxEdge`.
// Even numbers, which yuv420p requires.
export function videoOutputSize(
  viewport: { width: number; height: number },
  maxEdge?: number,
): { width: number; height: number } {
  const longest = Math.max(viewport.width, viewport.height)
  const scale = maxEdge && longest > maxEdge ? maxEdge / longest : 1
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2)
  return { width: even(viewport.width), height: even(viewport.height) }
}

export function videoRenderProblems(args: {
  viewport: { width: number; height: number }
  durationMs: number
  fps: number
}): string[] {
  const problems: string[] = []
  const { width, height } = args.viewport
  if (Math.max(width, height) > VIDEO_MAX_EDGE) {
    problems.push(`The viewport is ${width}×${height}; the longest edge can be ${VIDEO_MAX_EDGE}px`)
  }
  if (width * height > VIDEO_MAX_PIXELS) {
    problems.push(`The viewport is ${width}×${height}; at most 1920×1080 pixels' worth`)
  }
  if (args.durationMs < VIDEO_MIN_DURATION_MS) {
    problems.push(`Videos are at least ${VIDEO_MIN_DURATION_MS}ms long`)
  }
  if (args.durationMs > VIDEO_MAX_DURATION_MS) {
    problems.push(`Videos are at most ${VIDEO_MAX_DURATION_MS / 1000}s long`)
  }
  const frames = videoFrameCount(args.durationMs, args.fps)
  if (frames > VIDEO_MAX_FRAMES) {
    problems.push(
      `${frames} frames is over the ${VIDEO_MAX_FRAMES}-frame limit — shorten it or render at 30 fps`,
    )
  }
  return problems
}

// postMessage protocol between the video preview and the output view. The
// composed document answers SEEK by pausing every animation at that time;
// READY says the timeline is there and how long it is.
export const VIDEO_READY_MESSAGE = 'moodboard:video-ready'
export const VIDEO_SEEK_MESSAGE = 'moodboard:video-seek'

// The video agent's script: what each scene says and how long it runs. The
// agent writes it before touching the template, then checks its key frames
// against it.
export const videoSceneSchema = z.object({
  title: z.string().min(1).max(80),
  startMs: z.number().int().min(0).max(VIDEO_MAX_DURATION_MS),
  durationMs: z.number().int().min(300).max(VIDEO_MAX_DURATION_MS),
  onScreen: z.string().min(1).max(300),
  purpose: z.string().min(1).max(200),
})
export type VideoScene = z.infer<typeof videoSceneSchema>

export const videoScriptSchema = z.object({
  logline: z.string().min(1).max(300),
  scenes: z.array(videoSceneSchema).min(1).max(12),
})
export type VideoScript = z.infer<typeof videoScriptSchema>

// ---------------------------------------------------------------------------
// Render jobs (the Postgres-backed queue, lib/jobs.ts)
// ---------------------------------------------------------------------------

export const RENDER_JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const
export const renderJobStatusSchema = z.enum(RENDER_JOB_STATUSES)
export type RenderJobStatus = z.infer<typeof renderJobStatusSchema>
export const isTerminalJobStatus = (s: RenderJobStatus) =>
  s === 'done' || s === 'failed' || s === 'cancelled'

export const RENDER_VIDEO_KIND = 'render-video'

// What the render-video handler is given. `maxEdge` scales the output down
// (drafts, tests); `clipMs` renders only the first part.
export const renderVideoPayloadSchema = z.object({
  outputId: z.string().min(1),
  version: z.number().int().positive(),
  fps: videoFpsSchema,
  maxEdge: z.number().int().min(160).max(VIDEO_MAX_EDGE).optional(),
  clipMs: z.number().int().min(100).max(VIDEO_MAX_DURATION_MS).optional(),
})
export type RenderVideoPayload = z.infer<typeof renderVideoPayloadSchema>

export const videoRenderInfoSchema = z.object({
  version: z.number().int(),
  fps: videoFpsSchema,
  width: z.number().int(),
  height: z.number().int(),
  frames: z.number().int(),
  durationMs: z.number().int(),
  bytes: z.number().int(),
  renderedAt: z.string(),
  // Smaller than the document's own size, or only part of it.
  draft: z.boolean(),
})
export type VideoRenderInfo = z.infer<typeof videoRenderInfoSchema>

export const renderJobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: renderJobStatusSchema,
  // 0..1
  progress: z.number(),
  attempts: z.number().int(),
  outputId: z.string().nullable(),
  payload: z.record(z.unknown()),
  result: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})
export type RenderJob = z.infer<typeof renderJobSchema>

export const renderJobResponseSchema = z.object({ job: renderJobSchema })
export const renderJobsResponseSchema = z.object({
  jobs: z.array(renderJobSchema),
  // Finished renders of the asked version, newest first.
  renders: z.array(videoRenderInfoSchema),
})

export const renderVideoRequestSchema = z.object({
  version: z.number().int().positive().optional(),
  fps: videoFpsSchema.default(DEFAULT_VIDEO_FPS),
  // Render again even if this version already has an MP4 at this fps.
  force: z.boolean().optional(),
})
export type RenderVideoRequest = z.infer<typeof renderVideoRequestSchema>

export function videoRenderInfoOf(job: RenderJob): VideoRenderInfo | null {
  const parsed = videoRenderInfoSchema.safeParse(job.result)
  return parsed.success ? parsed.data : null
}

export function renderVideoPayloadOf(job: RenderJob): RenderVideoPayload | null {
  const parsed = renderVideoPayloadSchema.safeParse(job.payload)
  return parsed.success ? parsed.data : null
}

// Paths the app serves an output's MP4 from.
export function outputVideoPath(
  id: string,
  opts: { version?: number; fps?: VideoFps; download?: boolean } = {},
): string {
  const q = new URLSearchParams()
  if (opts.version) q.set('version', String(opts.version))
  if (opts.fps) q.set('fps', String(opts.fps))
  if (opts.download) q.set('download', '1')
  const qs = q.toString()
  return `/api/outputs/${id}/video${qs ? `?${qs}` : ''}`
}

export function shareVideoPath(token: string, opts: { fps?: VideoFps; download?: boolean } = {}) {
  const q = new URLSearchParams()
  if (opts.fps) q.set('fps', String(opts.fps))
  if (opts.download) q.set('download', '1')
  const qs = q.toString()
  return `/api/output-shares/${encodeURIComponent(token)}/video${qs ? `?${qs}` : ''}`
}

export const renderJobPath = (id: string) => `/api/render-jobs/${encodeURIComponent(id)}`
export const renderJobStreamPath = (id: string) => `${renderJobPath(id)}/stream`
