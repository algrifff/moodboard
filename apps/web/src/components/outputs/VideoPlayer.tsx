import type { RenderJob, VideoRenderInfo } from '@moodboard/shared'
import { DownloadSimple, X } from '@phosphor-icons/react'
import { ghostButton } from '@/components/ui'

// The finished MP4: the browser's own player (range requests make it seek),
// with what it is and a download. Also the progress bar of a render that's
// still going.

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function formatClock(ms: number): string {
  const total = Math.max(0, ms) / 1000
  const m = Math.floor(total / 60)
  const s = total - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export function VideoPlayer({
  src,
  poster,
  downloadHref,
  info,
  aspect,
  maxHeight,
  className = '',
}: {
  src: string
  poster?: string
  downloadHref: string
  info: VideoRenderInfo
  aspect: string
  // Caps the player's height (a tall vertical video on a short screen).
  maxHeight?: string
  className?: string
}) {
  return (
    <div className={className}>
      <div
        className="overflow-hidden bg-black"
        style={{
          borderRadius: 'var(--radius-lg)',
          aspectRatio: aspect,
          boxShadow: 'var(--shadow-card)',
        }}
      >
        <video
          src={src}
          poster={poster}
          controls
          playsInline
          preload="metadata"
          className="h-full w-full object-contain"
        />
      </div>
      <div className="mt-2 flex items-center gap-2 text-[12px] text-[var(--text-mute)]">
        <span className="min-w-0 flex-1 truncate">
          {info.width}×{info.height} · {info.fps} fps · {(info.durationMs / 1000).toFixed(1)}s ·{' '}
          {formatBytes(info.bytes)}
          {info.draft ? ' · draft' : ''}
        </span>
        <a href={downloadHref} download className={`${ghostButton} !px-2 !py-1 !text-[12px]`}>
          <DownloadSimple size={13} />
          Download MP4
        </a>
      </div>
    </div>
  )
}

export function jobPercent(job: RenderJob): number {
  return job.status === 'done' ? 100 : Math.round(job.progress * 100)
}

// Queued / running / failed / cancelled state of a render job.
export function RenderProgress({ job, onCancel }: { job: RenderJob; onCancel?: () => void }) {
  const active = job.status === 'queued' || job.status === 'running'
  const pct = jobPercent(job)
  return (
    <div className="text-[12.5px]" role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        <span
          className={
            job.status === 'failed'
              ? 'text-[var(--danger)]'
              : active
                ? 'text-shimmer'
                : 'text-[var(--text-mute)]'
          }
        >
          {job.status === 'queued' && 'Waiting for a renderer…'}
          {job.status === 'running' && `Rendering · ${pct}%`}
          {job.status === 'failed' && 'Render failed'}
          {job.status === 'cancelled' && 'Render cancelled'}
          {job.status === 'done' && 'Rendered'}
          {job.status === 'running' && job.attempts > 1 ? ` (attempt ${job.attempts})` : ''}
        </span>
        <div className="flex-1" />
        {active && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1 text-[12px] text-[var(--text-mute)] transition-colors hover:text-foreground"
          >
            <X size={12} weight="bold" />
            Cancel
          </button>
        )}
      </div>
      {active && (
        <div
          className="mt-1.5 h-1.5 overflow-hidden bg-[var(--bg-elevated)]"
          style={{ borderRadius: 'var(--radius)' }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div
            className="h-full bg-[var(--accent)]"
            style={{
              width: `${job.status === 'queued' ? 3 : Math.max(3, pct)}%`,
              transition: 'width 600ms cubic-bezier(0.2, 0.8, 0.2, 1)',
              borderRadius: 'var(--radius)',
            }}
          />
        </div>
      )}
      {job.status === 'failed' && job.error && (
        <p className="mt-1 text-[12px] leading-snug text-[var(--text-mute)]">{job.error}</p>
      )}
    </div>
  )
}
