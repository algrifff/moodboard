import {
  parseVideoDoc,
  RENDER_VIDEO_KIND,
  renderVideoPayloadSchema,
  videoFpsSchema,
  videoRenderInfoSchema,
  videoRenderProblems,
  viewportSize,
  type RenderJob,
  type VideoDoc,
  type VideoFps,
  type VideoRenderInfo,
} from '@moodboard/shared'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { kickJobWorker, PermanentJobError, type JobHandler } from './jobRunner'
import { enqueueJob, getRenderJob, QueueFullError } from './jobs'
import { composeDoc, getOutputSummary, outputRenderDoc } from './outputs'
import { renderVideo, VideoRenderError } from './renderVideo'
import { OUTPUTS_DIR } from './storage'

// MP4s of output versions: rendering one (the render-video job handler) and
// finding the ones that exist. A render is `<id>@v<n>@<fps>fps.mp4` on the
// volume with a `.json` sidecar of what it is; versions are immutable, so a
// file never goes stale. Drafts (scaled down / clipped) get a `-draft` name
// and are never offered to people.

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

function base(outputId: string, version: number, fps: VideoFps, draft = false): string {
  return path.join(OUTPUTS_DIR, `${outputId}@v${version}@${fps}fps${draft ? '-draft' : ''}`)
}

export function videoFilePath(outputId: string, version: number, fps: VideoFps): string | null {
  return SAFE_ID.test(outputId) ? `${base(outputId, version, fps)}.mp4` : null
}

async function readInfo(file: string): Promise<VideoRenderInfo | null> {
  try {
    const parsed = videoRenderInfoSchema.safeParse(
      JSON.parse(await readFile(`${file}.json`, 'utf8')),
    )
    if (!parsed.success) return null
    await stat(`${file}.mp4`)
    return parsed.data
  } catch {
    return null
  }
}

export async function findVideoRender(
  outputId: string,
  version: number,
  fps: VideoFps,
): Promise<VideoRenderInfo | null> {
  if (!SAFE_ID.test(outputId)) return null
  return readInfo(base(outputId, version, fps))
}

// The finished full-size renders of a version, 60 fps first.
export async function listVideoRenders(
  outputId: string,
  version: number,
): Promise<VideoRenderInfo[]> {
  const found = await Promise.all(
    ([60, 30] as const).map((fps) => findVideoRender(outputId, version, fps)),
  )
  return found.flatMap((r) => (r ? [r] : []))
}

// A video output's duration and finished renders at `version`, or null when
// the version isn't a video.
export async function videoInfoFor(
  outputId: string,
  version: number,
): Promise<(VideoDoc & { renders: VideoRenderInfo[] }) | null> {
  const doc = await outputRenderDoc(outputId, version)
  const video = doc && parseVideoDoc(doc.html)
  if (!video) return null
  return { ...video, renders: await listVideoRenders(outputId, version) }
}

export async function renderOutputVideo(opts: {
  outputId: string
  version: number
  fps: VideoFps
  maxEdge?: number
  clipMs?: number
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}): Promise<VideoRenderInfo> {
  if (!SAFE_ID.test(opts.outputId)) throw new VideoRenderError('Bad output id', true)
  const summary = await getOutputSummary(opts.outputId)
  if (!summary) throw new VideoRenderError('The output no longer exists.', true)
  const doc = await outputRenderDoc(opts.outputId, opts.version)
  if (!doc) throw new VideoRenderError(`The output has no version ${opts.version}.`, true)
  if (doc.viewport.kind !== 'fixed' || !parseVideoDoc(doc.html)) {
    throw new VideoRenderError(
      'Only fixed-size documents with a data-duration on their root can be rendered as video.',
      true,
    )
  }
  const composed = await composeDoc(doc)
  const draft = opts.maxEdge !== undefined || opts.clipMs !== undefined
  const target = base(opts.outputId, opts.version, opts.fps, draft)
  await mkdir(OUTPUTS_DIR, { recursive: true })
  // renderVideo writes `<name>.mp4.partial` and renames on success, so a
  // crash never leaves a half file under the final name.
  const rendered = await renderVideo({
    html: composed.html,
    viewport: viewportSize(doc.viewport),
    fps: opts.fps,
    outPath: `${target}.mp4`,
    maxEdge: opts.maxEdge,
    clipMs: opts.clipMs,
    signal: opts.signal,
    onProgress: opts.onProgress,
  })
  const info: VideoRenderInfo = {
    version: opts.version,
    fps: opts.fps,
    width: rendered.width,
    height: rendered.height,
    frames: rendered.frames,
    durationMs: rendered.durationMs,
    bytes: rendered.bytes,
    renderedAt: new Date().toISOString(),
    draft,
  }
  const sidecar = `${target}.json.tmp`
  await writeFile(sidecar, JSON.stringify(info))
  await rename(sidecar, `${target}.json`)
  return info
}

// The render-video job: payload → MP4 on the volume; the result is the
// VideoRenderInfo. Documents outside the limits fail permanently.
export const renderVideoHandler: JobHandler = async (job, { signal, progress }) => {
  const payload = renderVideoPayloadSchema.safeParse(job.payload)
  if (!payload.success) throw new PermanentJobError('Invalid render-video payload')
  const fps = videoFpsSchema.parse(payload.data.fps)
  try {
    const info = await renderOutputVideo({
      ...payload.data,
      fps,
      signal,
      onProgress: (done, total) => progress(done / total),
    })
    return info
  } catch (e) {
    if (e instanceof VideoRenderError && e.permanent) throw new PermanentJobError(e.message)
    throw e
  }
}

export function videoDownloadName(name: string, version: number, fps: VideoFps): string {
  const stem =
    name
      .replace(/[^a-zA-Z0-9 _.-]/g, '')
      .trim()
      .slice(0, 80) || 'video'
  return `${stem} v${version} ${fps}fps.mp4`
}

export type EnqueueResult =
  | { ok: true; job: RenderJob | null; render: VideoRenderInfo | null }
  | { ok: false; status: 400 | 404 | 429; error: string }

// Queue an MP4 render of an output version (default: the latest) after
// checking it is a video inside the render limits. A finished render at this
// fps is returned instead unless `force`; an identical job already waiting or
// running is returned rather than queued twice.
export async function enqueueVideoRender(args: {
  outputId: string
  version?: number
  fps: VideoFps
  force?: boolean
  userId: string | null
}): Promise<EnqueueResult> {
  const summary = await getOutputSummary(args.outputId)
  if (!summary) return { ok: false, status: 404, error: 'Output not found' }
  const version = args.version ?? summary.latestVersion
  const doc = await outputRenderDoc(args.outputId, version)
  if (!doc) return { ok: false, status: 404, error: `The output has no version ${version}` }
  const video = parseVideoDoc(doc.html)
  if (!video || doc.viewport.kind !== 'fixed') {
    return {
      ok: false,
      status: 400,
      error: 'This output isn’t a video: its root needs a fixed size and a data-duration.',
    }
  }
  const problems = videoRenderProblems({
    viewport: viewportSize(doc.viewport),
    durationMs: video.durationMs,
    fps: args.fps,
  })
  if (problems.length > 0) return { ok: false, status: 400, error: problems.join('; ') }

  if (!args.force) {
    const render = await findVideoRender(args.outputId, version, args.fps)
    if (render) return { ok: true, job: null, render }
  }
  try {
    const { job } = await enqueueJob({
      kind: RENDER_VIDEO_KIND,
      payload: { outputId: args.outputId, version, fps: args.fps },
      outputId: args.outputId,
      userId: args.userId,
    })
    kickJobWorker()
    return { ok: true, job: await getRenderJob(job.id), render: null }
  } catch (e) {
    if (e instanceof QueueFullError) return { ok: false, status: 429, error: e.message }
    throw e
  }
}
