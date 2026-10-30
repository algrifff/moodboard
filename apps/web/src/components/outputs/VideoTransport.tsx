import { VIDEO_READY_MESSAGE, VIDEO_SEEK_MESSAGE, type VideoDoc } from '@moodboard/shared'
import { Pause, Play } from '@phosphor-icons/react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { FrameController } from './OutputFrame'
import { formatClock } from './VideoPlayer'

// Play / pause and a scrubber for a video output's sandboxed preview. The
// composed document seeks its own timeline when told a time (postMessage —
// the CSP and sandbox stay as they are); playing is this component stepping
// that time with requestAnimationFrame, so the preview shows the same frame
// the renderer would capture at that moment.

export type VideoTransportHandle = {
  // Messages from the preview frame; true when it was a video message.
  handleMessage: (data: unknown) => boolean
}

export const VideoTransport = forwardRef<
  VideoTransportHandle,
  {
    video: VideoDoc
    controller: RefObject<FrameController | null>
    // Changes when the preview reloads a different document.
    documentKey: string
  }
>(function VideoTransport({ video, controller, documentKey }, ref) {
  const [time, setTime] = useState(video.posterMs)
  const [playing, setPlaying] = useState(false)
  const timeRef = useRef(video.posterMs)
  const last = video.durationMs - 1

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.min(Math.max(0, t), last)
      timeRef.current = clamped
      setTime(clamped)
      controller.current?.post({ type: VIDEO_SEEK_MESSAGE, time: clamped })
    },
    [controller, last],
  )

  useImperativeHandle(
    ref,
    () => ({
      handleMessage: (data) => {
        const type = (data as { type?: unknown } | null)?.type
        if (type !== VIDEO_READY_MESSAGE) return false
        // A freshly loaded document starts playing on its own; hold it at
        // the time we're on.
        controller.current?.post({ type: VIDEO_SEEK_MESSAGE, time: timeRef.current })
        return true
      },
    }),
    [controller],
  )

  useEffect(() => {
    setPlaying(false)
    seek(video.posterMs)
    // A different document (output or version): start from its poster.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentKey])

  useEffect(() => {
    if (!playing) return
    const from = timeRef.current >= last ? 0 : timeRef.current
    const origin = performance.now() - from
    let raf = 0
    const tick = (now: number) => {
      const t = now - origin
      if (t >= last) {
        seek(last)
        setPlaying(false)
        return
      }
      seek(t)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, last, seek])

  return (
    <div
      className="mx-6 mb-5 flex shrink-0 items-center gap-3 bg-card px-3 py-2"
      style={{ borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-small)' }}
    >
      <button
        type="button"
        onClick={() => setPlaying((p) => !p)}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center bg-primary text-primary-foreground transition-[filter] hover:brightness-110"
        style={{ borderRadius: '999px' }}
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
      </button>
      <input
        type="range"
        min={0}
        max={last}
        step={1}
        value={Math.round(time)}
        onChange={(e) => {
          setPlaying(false)
          seek(Number(e.target.value))
        }}
        aria-label="Timeline"
        className="min-w-0 flex-1 accent-[var(--accent)]"
      />
      <span className="w-[120px] shrink-0 whitespace-nowrap text-right font-mono text-[12px] tabular-nums text-[var(--text-mute)]">
        {formatClock(time)} / {formatClock(video.durationMs)}
      </span>
    </div>
  )
})
