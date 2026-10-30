import { viewportSize, type TemplateSummary } from '@moodboard/shared'
import { designToolbox } from './designToolbox'
import { composeDoc, outputRenderDoc } from './outputs'
import { enqueueVideoRender } from './outputVideo'
import { RenderTimeoutError, withDocument } from './renderFrame'
import { VIDEO_AGENT_FRAME_EDGE, type VideoToolbox } from './videoAgent'

// The video agent's tools against the real thing: the designer's toolbox for
// slots / HTML edits / assets (same outputs, same rules), key frames from
// the composed document's own timeline at chosen times, and the render queue.

type Timeline = { duration: number }

export function videoToolbox(args: {
  boardId: string
  userId: string
  clientId: string | null
  kitId: string | null
  templates: TemplateSummary[]
}): VideoToolbox {
  const base = designToolbox(args)
  const fail = (error: string) => ({ ok: false as const, error })

  return {
    searchAssets: base.searchAssets,
    createOutput: base.createOutput,
    getSource: base.getSource,
    updateSlots: base.updateSlots,
    updateHtml: base.updateHtml,

    async renderFrames(outputId, version, timesMs) {
      const doc = await outputRenderDoc(outputId, version)
      if (!doc) return fail('Output not found.')
      const composed = await composeDoc(doc)
      const viewport = viewportSize(doc.viewport)
      const longest = Math.max(viewport.width, viewport.height)
      const scale = longest > VIDEO_AGENT_FRAME_EDGE ? VIDEO_AGENT_FRAME_EDGE / longest : 1
      try {
        return await withDocument(
          composed.html,
          { viewport, deviceScaleFactor: scale },
          async (handle) => {
            const info = await handle.page.evaluate(() => {
              const timeline = (window as unknown as { __moodboardTimeline?: Timeline })
                .__moodboardTimeline
              if (!timeline) return null
              return {
                duration: timeline.duration,
                overrunning: document
                  .getAnimations()
                  .filter((a) => {
                    const end = a.effect?.getComputedTiming().endTime
                    return (
                      typeof end !== 'number' ||
                      !Number.isFinite(end) ||
                      end > timeline.duration + 1
                    )
                  })
                  .map((a) => (a as CSSAnimation).animationName ?? 'animation'),
              }
            })
            if (!info) {
              return fail('This document has no data-duration, so it has no timeline to render.')
            }
            const frames = []
            for (const asked of timesMs) {
              const timeMs = Math.min(Math.max(0, asked), Math.max(0, info.duration - 1))
              await handle.seek(timeMs)
              frames.push({ timeMs, png: await handle.screenshot() })
            }
            return {
              ok: true as const,
              frames,
              durationMs: info.duration,
              text: JSON.stringify({
                version,
                size: `${viewport.width}×${viewport.height}`,
                durationMs: info.duration,
                times: frames.map((f) => f.timeMs),
                ...(info.overrunning.length > 0
                  ? {
                      problem: `These animations run past data-duration or never end — fix their delays/durations: ${[...new Set(info.overrunning)].join(', ')}`,
                    }
                  : {}),
                ...(composed.missingAssets.length > 0
                  ? { missingAssets: composed.missingAssets }
                  : {}),
                ...(handle.errors.length > 0 ? { pageErrors: handle.errors.slice(0, 5) } : {}),
              }),
            }
          },
        )
      } catch (e) {
        if (e instanceof RenderTimeoutError)
          return fail('The render timed out. Simplify and retry.')
        return fail(`Render failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },

    async enqueueRender(outputId, version, fps) {
      const queued = await enqueueVideoRender({ outputId, version, fps, userId: args.userId })
      if (!queued.ok) return fail(queued.error)
      return { ok: true, jobId: queued.job?.id ?? null, text: 'Queued.' }
    },
  }
}
