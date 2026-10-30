import {
  isTerminalJobStatus,
  outputThumbnailPath,
  outputVideoPath,
  renderJobSchema,
  templateViewportSchema,
  videoRenderInfoOf,
  videoRenderInfoSchema,
  viewportSize,
  type AgentToolPayload,
  type RenderJob,
  type VideoRenderInfo,
} from '@moodboard/shared'
import { ArrowSquareOut, FilmSlate } from '@phosphor-icons/react'
import { RenderProgress, VideoPlayer } from '@/components/outputs/VideoPlayer'
import { useRenderJob } from '@/lib/videoApi'
import { useAgentSidebarStore } from '@/store/agentSidebar'
import { STAGE_LABEL } from './DesignRunCard'

// design_video and render_video in the thread. A render is a background job:
// the card follows it live (SSE, falling back to polling), from "waiting"
// through a progress bar to the finished video with a download — so the
// agent never has to wait on it, and a reloaded thread still shows where it
// got to.

const cardStyle = {
  borderRadius: 'var(--radius-lg)',
  backgroundColor: 'var(--bg)',
  boxShadow: '0 0 0 1px var(--border-soft)',
}

type OutputRef = { id: string; name: string; version?: number; viewport?: unknown }

function aspectOf(viewport: unknown): string {
  const parsed = templateViewportSchema.safeParse(viewport)
  const { width, height } =
    parsed.success && parsed.data.kind === 'fixed'
      ? viewportSize(parsed.data)
      : { width: 16, height: 9 }
  return `${width} / ${height}`
}

function jobOf(raw: unknown): RenderJob | null {
  const parsed = renderJobSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// The render, wherever it is: finished already (payload.render), a job to
// follow, or neither.
function RenderedVideo({
  output,
  version,
  fps,
  job: initialJob,
  render: initialRender,
}: {
  output: OutputRef
  version: number
  fps: number
  job: RenderJob | null
  render: VideoRenderInfo | null
}) {
  const { job, cancel } = useRenderJob(initialJob?.id ?? null, initialJob)
  const current = job ?? initialJob
  const finished = current?.status === 'done' ? videoRenderInfoOf(current) : initialRender
  const aspect = aspectOf(output.viewport)

  if (finished) {
    return (
      <VideoPlayer
        className="px-3 pb-3 pt-1"
        src={outputVideoPath(output.id, { version, fps: finished.fps })}
        poster={outputThumbnailPath(output.id, version)}
        downloadHref={outputVideoPath(output.id, { version, fps: finished.fps, download: true })}
        info={finished}
        aspect={aspect}
      />
    )
  }
  if (!current) return null
  return (
    <div className="px-3 pb-3 pt-1">
      <div
        className="mb-2.5 overflow-hidden bg-[var(--bg-elevated)]"
        style={{ borderRadius: 'var(--radius)', aspectRatio: aspect }}
      >
        <img
          src={outputThumbnailPath(output.id, version)}
          alt=""
          className="h-full w-full object-cover"
          style={{ opacity: isTerminalJobStatus(current.status) ? 0.5 : 1 }}
        />
      </div>
      <RenderProgress job={current} onCancel={() => void cancel()} />
      <p className="mt-1 text-[11.5px] text-[var(--text-faint)]">
        {fps} fps · rendering continues if you close this panel.
      </p>
    </div>
  )
}

function Header({ title, shimmer, extra }: { title: string; shimmer?: boolean; extra?: string }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-2.5">
      <FilmSlate size={14} weight="fill" className="shrink-0 text-[var(--accent)]" />
      <span className={`font-medium ${shimmer ? 'text-shimmer' : 'text-foreground'}`}>{title}</span>
      {extra && <span className="text-[11px] text-[var(--text-faint)]">{extra}</span>}
    </div>
  )
}

function OpenLink({ outputId }: { outputId: string }) {
  return (
    <div className="border-t border-[var(--border-soft)] px-3 py-2">
      <a
        href={`/outputs/${outputId}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent)] hover:brightness-110"
      >
        <ArrowSquareOut size={13} weight="bold" />
        Open to tweak
      </a>
    </div>
  )
}

export function VideoRunCard({
  toolUseId,
  input,
  payload,
  running,
}: {
  toolUseId: string
  input: Record<string, unknown>
  payload: AgentToolPayload | null
  running: boolean
}) {
  const progress = useAgentSidebarStore((s) => s.toolProgress[toolUseId]?.[1])
  const brief = typeof input.brief === 'string' ? input.brief : ''

  if (!payload) {
    const seen =
      progress?.outputId &&
      progress.version &&
      ['critique', 'revising', 'render-queued', 'done', 'cached'].includes(progress.stage)
    return (
      <div className="overflow-hidden text-[13px]" style={cardStyle}>
        <Header title={running ? 'Making a film…' : 'Film run interrupted'} shimmer={running} />
        {brief && (
          <p className="line-clamp-2 px-3 pt-1 text-[11.5px] leading-snug text-[var(--text-mute)]">
            {brief}
          </p>
        )}
        <div className="flex items-center gap-2.5 px-3 pb-3 pt-2.5">
          <div
            className="h-9 w-16 shrink-0 overflow-hidden bg-[var(--bg-elevated)]"
            style={{ borderRadius: 'var(--radius)' }}
          >
            {seen && (
              <img
                src={outputThumbnailPath(progress.outputId!, progress.version)}
                alt=""
                className="h-full w-full object-cover"
              />
            )}
          </div>
          <div
            className={`min-w-0 flex-1 truncate text-[11.5px] ${
              running ? 'text-shimmer' : 'text-[var(--text-mute)]'
            }`}
          >
            {progress ? STAGE_LABEL[progress.stage] : 'Starting'}
            {progress?.detail ? ` · ${progress.detail}` : ''}
          </div>
        </div>
      </div>
    )
  }

  const output = payload.output as OutputRef
  const version = typeof payload.version === 'number' ? payload.version : (output.version ?? 1)
  const render = videoRenderInfoSchema.safeParse(payload.render)
  const fps = typeof payload.fps === 'number' ? payload.fps : 30
  const critique = typeof payload.critique === 'string' ? payload.critique : ''
  const scenes = (payload.script as { scenes?: unknown[] } | null | undefined)?.scenes?.length
  return (
    <div className="overflow-hidden text-[13px]" style={cardStyle}>
      <Header title={payload.summary} extra={payload.cached === true ? 'reused' : undefined} />
      {(critique || scenes) && (
        <p className="px-3 pb-2 pt-1 text-[12px] leading-snug text-[var(--text-soft)]">
          {critique}
          {scenes ? (
            <span className="block pt-0.5 text-[11.5px] text-[var(--text-mute)]">
              {scenes} scenes
              {typeof payload.durationMs === 'number'
                ? ` · ${(payload.durationMs / 1000).toFixed(0)}s`
                : ''}
            </span>
          ) : null}
        </p>
      )}
      <RenderedVideo
        output={output}
        version={version}
        fps={fps}
        job={jobOf(payload.job)}
        render={render.success ? render.data : null}
      />
      <OpenLink outputId={output.id} />
    </div>
  )
}

// render_video / get_render_job.
export function RenderJobCard({ payload }: { payload: AgentToolPayload }) {
  const output = payload.output as OutputRef | undefined
  const job = jobOf(payload.job)
  const render = videoRenderInfoSchema.safeParse(payload.render)
  const version =
    typeof payload.version === 'number'
      ? payload.version
      : ((job?.payload as { version?: number } | undefined)?.version ?? 1)
  const fps = typeof payload.fps === 'number' ? payload.fps : 30
  const outputId = output?.id ?? job?.outputId ?? null
  return (
    <div className="overflow-hidden text-[13px]" style={cardStyle}>
      <Header title={payload.summary} />
      {outputId ? (
        <>
          <RenderedVideo
            output={output ?? { id: outputId, name: 'Video' }}
            version={version}
            fps={fps}
            job={job}
            render={render.success ? render.data : null}
          />
          <OpenLink outputId={outputId} />
        </>
      ) : (
        job && (
          <div className="px-3 pb-3 pt-2">
            <RenderProgress job={job} />
          </div>
        )
      )}
    </div>
  )
}
