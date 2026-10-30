import {
  isTerminalJobStatus,
  outputThumbnailPath,
  outputVideoPath,
  renderVideoPayloadOf,
  videoFrameCount,
  videoOutputSize,
  videoRenderProblems,
  VIDEO_FPS_OPTIONS,
  type RenderJob,
  type VideoDoc,
  type VideoFps,
  type VideoRenderInfo,
} from '@moodboard/shared'
import { Play } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { showToast } from '@/components/canvas/Toast'
import { primaryButton } from '@/components/ui'
import { listRenders, renderVideo, useRenderJob } from '@/lib/videoApi'
import { RenderProgress, VideoPlayer } from './VideoPlayer'

// The output view's Video tab: render this version as an MP4 (fps choice),
// watch the job, and play / download the finished renders. Rendering is a
// background job — leaving the page doesn't stop it.

export function VideoPanel({
  outputId,
  version,
  video,
  viewport,
}: {
  outputId: string
  version: number
  video: VideoDoc
  viewport: { width: number; height: number }
}) {
  const [fps, setFps] = useState<VideoFps>(30)
  const [renders, setRenders] = useState<VideoRenderInfo[]>([])
  const [jobs, setJobs] = useState<RenderJob[]>([])
  const [busy, setBusy] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await listRenders(outputId, version)
      setRenders(next.renders)
      setJobs(next.jobs)
      const running = next.jobs.find(
        (j) => !isTerminalJobStatus(j.status) && renderVideoPayloadOf(j)?.version === version,
      )
      setActiveId(running?.id ?? null)
    } catch {
      /* the panel stays as it was */
    }
  }, [outputId, version])

  useEffect(() => {
    setRenders([])
    setJobs([])
    setActiveId(null)
    void refresh()
  }, [refresh])

  const { job: live, cancel } = useRenderJob(activeId)
  const liveStatus = live?.status
  useEffect(() => {
    if (liveStatus && isTerminalJobStatus(liveStatus)) void refresh()
  }, [liveStatus, refresh])

  const problems = videoRenderProblems({ viewport, durationMs: video.durationMs, fps })
  const size = videoOutputSize(viewport)
  const frames = videoFrameCount(video.durationMs, fps)
  const existing = renders.find((r) => r.fps === fps)
  const active = live && !isTerminalJobStatus(live.status) ? live : null
  const lastFailed =
    !active && !existing
      ? jobs.find((j) => renderVideoPayloadOf(j)?.version === version && j.status === 'failed')
      : undefined

  const start = async () => {
    setBusy(true)
    try {
      const res = await renderVideo(outputId, { version, fps, force: existing !== undefined })
      if (res.job) setActiveId(res.job.id)
      await refresh()
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-[13px] font-medium text-foreground">Render to MP4</h3>
        <p className="mt-1 text-[12px] leading-snug text-[var(--text-mute)]">
          {size.width}×{size.height} H.264, silent · {(video.durationMs / 1000).toFixed(1)}s ·{' '}
          {frames} frames at {fps} fps. Rendering runs in the background.
        </p>
      </div>

      <div
        className="flex items-center gap-0.5 self-start bg-[var(--bg-elevated)] p-0.5"
        style={{ borderRadius: 'var(--radius-lg)' }}
        role="radiogroup"
        aria-label="Frame rate"
      >
        {VIDEO_FPS_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={fps === option}
            onClick={() => setFps(option)}
            className={`h-7 px-3 text-[12.5px] transition-colors ${
              fps === option
                ? 'bg-card text-foreground'
                : 'text-[var(--text-mute)] hover:text-foreground'
            }`}
            style={{ borderRadius: 'var(--radius)' }}
          >
            {option} fps
          </button>
        ))}
      </div>

      {problems.length > 0 && (
        <p className="text-[12px] leading-snug text-[var(--danger)]">{problems.join('. ')}.</p>
      )}

      {active ? (
        <RenderProgress job={active} onCancel={() => void cancel()} />
      ) : (
        <button
          type="button"
          className={`${primaryButton} self-start`}
          disabled={busy || problems.length > 0}
          onClick={() => void start()}
        >
          <Play size={13} weight="fill" />
          {existing ? `Render again at ${fps} fps` : 'Render MP4'}
        </button>
      )}
      {lastFailed && <RenderProgress job={lastFailed} />}
      {live?.status === 'cancelled' && !active && <RenderProgress job={live} />}

      {renders.length > 0 && (
        <div className="flex flex-col gap-4 border-t border-[var(--border-soft)] pt-4">
          {renders.map((r) => (
            <VideoPlayer
              key={`${r.version}-${r.fps}-${r.renderedAt}`}
              src={outputVideoPath(outputId, { version: r.version, fps: r.fps })}
              poster={outputThumbnailPath(outputId, r.version)}
              downloadHref={outputVideoPath(outputId, {
                version: r.version,
                fps: r.fps,
                download: true,
              })}
              info={r}
              aspect={`${viewport.width} / ${viewport.height}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
