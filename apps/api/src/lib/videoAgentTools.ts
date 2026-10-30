import {
  DEFAULT_VIDEO_FPS,
  isSlotImageValue,
  outputThumbnailPath,
  outputVideoPath,
  type VideoFps,
} from '@moodboard/shared'
import type { ToolContext, ToolOutcome } from './canvasTools'
import { loadBoardObjects } from './boardObjects'
import { resolveDesignTarget } from './designAgentTools'
import { VIDEO_AGENT_MODEL_TAG, designCacheKey } from './designHash'
import { dbDesignCache } from './designRuns'
import { getRenderJob } from './jobs'
import { defaultModelClient } from './orchestrator'
import { getOutputSummary } from './outputs'
import { enqueueVideoRender, findVideoRender } from './outputVideo'
import { outputRef, outputUrl, resolveOutput } from './outputTools'
import { runVideo, type BoardClip, type VideoContext } from './videoAgent'
import { videoToolbox } from './videoToolbox'

// Bodies of design_video (the video agent), render_video and get_render_job.
// Registered in canvasTools.ts (CANVAS_TOOLS).

type Fail = Extract<ToolOutcome, { ok: false }>
const fail = (error: string): Fail => ({ ok: false, error })

async function boardClips(boardId: string): Promise<BoardClip[]> {
  const objects = (await loadBoardObjects(boardId)).map((v) => v.object)
  return objects.flatMap((o) => {
    if (o.type !== 'video-clip') return []
    const d = o.data as {
      title: string
      channel: string
      durationSec: number
      thumbnailUrl: string
    }
    return [
      {
        title: d.title,
        channel: d.channel,
        durationSec: d.durationSec,
        posterUrl: isSlotImageValue(d.thumbnailUrl) ? d.thumbnailUrl : null,
      },
    ]
  })
}

export async function designVideoTool(
  ctx: ToolContext,
  input: {
    brief: string
    client?: string
    kit?: string
    fps?: VideoFps
    regenerate?: boolean
  },
): Promise<ToolOutcome> {
  const target = await resolveDesignTarget(ctx, { ...input, format: 'video' })
  if (!target.ok) return target
  const { client, templates } = target
  const clips = await boardClips(ctx.boardId)
  const fps = input.fps ?? DEFAULT_VIDEO_FPS

  const context: VideoContext = {
    brief: input.brief,
    client: { id: client.id, name: client.name },
    kit: target.kit,
    templates,
    assets: target.assets,
    clips,
    fps,
  }
  const run = await runVideo({
    model: ctx.model === undefined ? defaultModelClient() : ctx.model,
    context,
    toolbox: videoToolbox({
      boardId: ctx.boardId,
      userId: ctx.userId,
      clientId: client.id,
      kitId: target.kitId,
      templates,
    }),
    cache: dbDesignCache(VIDEO_AGENT_MODEL_TAG),
    key: designCacheKey({
      brief: input.brief,
      clientId: client.id,
      kitId: target.kitId,
      kitVersion: target.kit?.version ?? null,
      templates: templates.map((t) => ({ id: t.id, version: t.latestVersion })),
      assetIds: [...target.assetIds, ...clips.map((c) => `clip:${c.title}:${c.posterUrl ?? ''}`)],
      format: 'video',
      variantIndex: 1,
      modelTag: VIDEO_AGENT_MODEL_TAG,
    }),
    regenerate: input.regenerate,
    onProgress: ctx.onProgress ?? (() => undefined),
    signal: ctx.signal,
  })

  if (run.status !== 'done' || !run.outputId || !run.version) {
    return fail(`The video agent couldn’t make a film: ${run.error ?? 'unknown error'}`)
  }
  const output = (await getOutputSummary(run.outputId))!
  const job = run.jobId ? await getRenderJob(run.jobId) : null
  const render = await findVideoRender(run.outputId, run.version, run.fps)
  return {
    ok: true,
    payload: {
      summary: `${run.cached ? 'Reused' : 'Made'} “${run.name}” for ${client.name}${job ? ' — rendering the MP4' : render ? ' — MP4 ready' : ''}`,
      client: client.name,
      kit: target.kit ? `${target.kit.name} v${target.kit.version}` : null,
      output: outputRef(output),
      version: run.version,
      name: run.name,
      template: run.template,
      critique: run.critique,
      script: run.script,
      durationMs: run.durationMs,
      fps: run.fps,
      cached: run.cached,
      job,
      render,
      thumbnailUrl: outputThumbnailPath(run.outputId, run.version),
      videoUrl: render
        ? outputVideoPath(run.outputId, { version: run.version, fps: run.fps })
        : null,
      url: outputUrl(run.outputId),
      note: 'The sidebar card shows the render’s progress and then the finished video with a download button — don’t wait for or poll it.',
    },
  }
}

export async function renderVideoTool(
  ctx: ToolContext,
  input: { output: string; version?: number; fps?: VideoFps; force?: boolean },
): Promise<ToolOutcome> {
  const found = await resolveOutput(input.output)
  if ('ok' in found) return found
  const fps = input.fps ?? DEFAULT_VIDEO_FPS
  const queued = await enqueueVideoRender({
    outputId: found.item.id,
    version: input.version,
    fps,
    force: input.force,
    userId: ctx.userId,
  })
  if (!queued.ok) return fail(queued.error)
  const version = input.version ?? found.item.latestVersion
  return {
    ok: true,
    payload: {
      summary: queued.job
        ? `Queued the MP4 render of “${found.item.name}” v${version} at ${fps} fps`
        : `“${found.item.name}” v${version} already has an MP4 at ${fps} fps`,
      output: outputRef(found.item),
      version,
      fps,
      job: queued.job,
      render: queued.render,
      videoUrl: queued.render ? outputVideoPath(found.item.id, { version, fps }) : null,
      note: 'The sidebar card shows progress and then the video — don’t wait for or poll it.',
    },
  }
}

export async function getRenderJobTool(
  _ctx: ToolContext,
  input: { job: string },
): Promise<ToolOutcome> {
  const job = await getRenderJob(input.job)
  if (!job) return fail(`No render job “${input.job}”.`)
  const pct = Math.round(job.progress * 100)
  return {
    ok: true,
    payload: {
      summary: `Render ${job.status}${job.status === 'running' ? ` · ${pct}%` : ''}`,
      job,
    },
  }
}
