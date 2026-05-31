import type { CanvasObject, VoiceNoteData } from '@moodboard/shared'
import { ArrowClockwise, Microphone, Pause, Play } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBoxInteraction } from '@/hooks/useBoxInteraction'
import { EASE_OUT_QUICK, OBJECT_SPAWN_DURATION, SNAP_CURVE } from '@/lib/motion'
import { BAR_COUNT } from '@/lib/voiceRecorder'
import { getPeaks, placeholderPeaks } from '@/lib/voiceNotePeaks'
import { markDone, markTranscribing, useTranscribing } from '@/lib/voiceNoteTranscribing'
import { filenameFromUrl, transcribeVoiceNote } from '@/lib/voiceTranscribeApi'
import { useCanvasStore } from '@/store/canvas'
import { SpawnRing } from './SpawnRing'
import { showToast } from './Toast'
import { WaveformBars, type WaveformBarsHandle } from './WaveformBars'

// DOM overlay card for a voice-note canvas object.
//
// Header:    mic glyph + duration + play/pause.
// Waveform:  drives WaveformBars from a recorded peak snapshot when idle,
//            and from a live AudioContext+AnalyserNode during playback.
// Scrubber:  thin progress bar — clickable to seek. Shows current /
//            total time in M:SS / M:SS.
// Body:      cleaned-up Gemini transcript, clamped to 3 lines with an
//            expand toggle. Shows a "Transcribing…" pulse while the
//            background call is in flight, or a "Retry" button on the
//            empty-transcript-after-failure path.

const PLAYBACK_BIN_CAP = 96

export function VoiceNoteNode({
  object,
  scale,
  panMode,
  selected,
}: {
  object: CanvasObject
  scale: number
  panMode: boolean
  selected: boolean
}) {
  const data = object.data as VoiceNoteData
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const barsRef = useRef<WaveformBarsHandle | null>(null)

  const [playing, setPlaying] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [audioError, setAudioError] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [knownDuration, setKnownDuration] = useState<number | null>(null)

  const updateObject = useCanvasStore((s) => s.updateObject)
  const transcribing = useTranscribing(object.id)

  // Web Audio nodes live in refs — created lazily on first play (browsers
  // require a user gesture to create / resume an AudioContext).
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const freqBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const playbackBarsRef = useRef<Float32Array | null>(null)
  const rafIdRef = useRef<number | null>(null)

  const HALO = 14
  const interaction = useBoxInteraction(object.id, scale, {
    panMode,
    editing: false,
    minWidth: 260,
    minHeight: 170,
    haloPx: HALO,
  })

  // Snapshot peaks from the in-session cache (HUD stashed them on spawn),
  // or a deterministic placeholder if the cache has nothing. Used when
  // playback is NOT active.
  const snapshotPeaks = useMemo(() => {
    const cached = getPeaks(object.id)
    if (cached && cached.length === BAR_COUNT) return cached
    return placeholderPeaks(object.id, BAR_COUNT)
  }, [object.id])

  // The duration we trust: prefer the audio element's reported duration
  // (sometimes more accurate than the recorder estimate), fall back to
  // the data the spawner stored.
  const duration = knownDuration ?? data.durationSec ?? 0
  const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0

  // Repaint the snapshot whenever it changes (object id swap) or playback
  // toggles off. Imperative so we don't re-render the bars 60×/sec.
  useEffect(() => {
    if (playing) return
    barsRef.current?.setLevels(snapshotPeaks, false)
  }, [snapshotPeaks, playing])

  // ---------------------------------------------------------------------
  // Audio element wiring — load events, play/pause sync, error toasts.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => {
      setPlaying(false)
      setCurrentTime(0)
    }
    const onError = () => {
      setAudioError(true)
      setPlaying(false)
    }
    const onLoaded = () => {
      if (isFinite(el.duration) && el.duration > 0) {
        setKnownDuration(el.duration)
      }
    }
    const onTime = () => {
      setCurrentTime(el.currentTime)
    }
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    el.addEventListener('error', onError)
    el.addEventListener('loadedmetadata', onLoaded)
    el.addEventListener('durationchange', onLoaded)
    el.addEventListener('timeupdate', onTime)
    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('error', onError)
      el.removeEventListener('loadedmetadata', onLoaded)
      el.removeEventListener('durationchange', onLoaded)
      el.removeEventListener('timeupdate', onTime)
    }
  }, [])

  // ---------------------------------------------------------------------
  // Playback analyser — drives the waveform from live audio.
  // ---------------------------------------------------------------------
  const ensureAnalyserGraph = useCallback(() => {
    if (sourceNodeRef.current) return
    const el = audioRef.current
    if (!el) return
    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    const source = ctx.createMediaElementSource(el)
    sourceNodeRef.current = source
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.6
    source.connect(analyser)
    analyser.connect(ctx.destination)
    analyserRef.current = analyser
    freqBufRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
    playbackBarsRef.current = new Float32Array(BAR_COUNT)
  }, [])

  const stopRafLoop = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
  }, [])

  const startRafLoop = useCallback(() => {
    if (rafIdRef.current !== null) return
    const loop = () => {
      const analyser = analyserRef.current
      const freqBuf = freqBufRef.current
      const bars = playbackBarsRef.current
      if (!analyser || !freqBuf || !bars) return
      analyser.getByteFrequencyData(freqBuf)
      const usable = Math.min(freqBuf.length, PLAYBACK_BIN_CAP)
      const bucketSize = usable / BAR_COUNT
      for (let i = 0; i < BAR_COUNT; i++) {
        const lo = Math.floor(i * bucketSize)
        const hi = Math.floor((i + 1) * bucketSize)
        let acc = 0
        let count = 0
        for (let j = lo; j < hi; j++) {
          const v = freqBuf[j]
          if (v === undefined) continue
          acc += v
          count += 1
        }
        bars[i] = count > 0 ? acc / count / 255 : 0
      }
      barsRef.current?.setLevels(bars, false)
      rafIdRef.current = requestAnimationFrame(loop)
    }
    rafIdRef.current = requestAnimationFrame(loop)
  }, [])

  // Wire play/pause to start/stop the RAF loop.
  useEffect(() => {
    if (playing) startRafLoop()
    else stopRafLoop()
  }, [playing, startRafLoop, stopRafLoop])

  // Cleanup on unmount: tear down the AudioContext + RAF.
  useEffect(() => {
    return () => {
      stopRafLoop()
      const ctx = audioCtxRef.current
      audioCtxRef.current = null
      sourceNodeRef.current = null
      analyserRef.current = null
      if (ctx && ctx.state !== 'closed') {
        ctx.close().catch(() => undefined)
      }
    }
  }, [stopRafLoop])

  // ---------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------
  const controlPointerDown = (e: React.PointerEvent) => e.stopPropagation()

  const onTogglePlay = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const el = audioRef.current
    if (!el || audioError) return
    if (el.paused) {
      ensureAnalyserGraph()
      const ctx = audioCtxRef.current
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => undefined)
      el.play().catch(() => setAudioError(true))
    } else {
      el.pause()
    }
  }

  const onToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setExpanded((v) => !v)
  }

  const onScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    const el = audioRef.current
    if (!el || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const ratio = Math.max(0, Math.min(1, x / rect.width))
    el.currentTime = ratio * duration
    setCurrentTime(el.currentTime)
  }

  const onRetryTranscribe = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const filename = filenameFromUrl(data.url)
    if (!filename) return
    markTranscribing(object.id)
    transcribeVoiceNote(filename)
      .then((transcript) => {
        updateObject(object.id, { data: { ...data, transcript } })
      })
      .catch((err) => {
        console.warn('[voice/transcribe] retry failed', err)
        showToast('Transcription failed — try again later.')
      })
      .finally(() => markDone(object.id))
  }

  const transcript = data.transcript?.trim() ?? ''
  const hasTranscript = transcript.length > 0

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: OBJECT_SPAWN_DURATION, ease: [...SNAP_CURVE] }}
      onPointerEnter={interaction.onPointerEnter}
      onPointerLeave={interaction.onPointerLeave}
      onPointerMove={interaction.onPointerMove}
      onPointerDown={interaction.onPointerDown}
      onPointerUp={interaction.onPointerUp}
      style={{
        position: 'absolute',
        left: object.position.x - HALO,
        top: object.position.y - HALO,
        width: object.size.width + HALO * 2,
        height: object.size.height + HALO * 2,
        padding: HALO,
        boxSizing: 'border-box',
        cursor: interaction.cursor,
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          backgroundColor: 'var(--bg-card)',
          boxShadow: 'var(--shadow-card)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          outline: selected || interaction.nearEdge ? '2px solid var(--accent)' : 'none',
          outlineOffset: 3,
          color: 'var(--text)',
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
        }}
      >
        <SpawnRing />

        {/* Header — mic glyph, label, play/pause. Drag handle except the
            play button. */}
        <div
          className="flex items-center gap-2.5"
          style={{ padding: '12px 14px 6px 14px', flexShrink: 0 }}
        >
          <div
            className="inline-flex items-center justify-center"
            style={{
              width: 28,
              height: 28,
              borderRadius: 999,
              backgroundColor: 'var(--bg-elevated)',
              color: 'var(--text-mute)',
              flexShrink: 0,
            }}
            aria-hidden
          >
            <Microphone size={14} weight="fill" />
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="text-[12px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: 'var(--text-mute)' }}
            >
              Voice note
            </div>
          </div>
          <motion.button
            type="button"
            onPointerDown={controlPointerDown}
            onClick={onTogglePlay}
            disabled={audioError}
            whileTap={audioError ? undefined : { scale: 0.92 }}
            transition={{ duration: 0.12, ease: [...EASE_OUT_QUICK] }}
            aria-label={playing ? 'Pause voice note' : 'Play voice note'}
            title={audioError ? 'Audio unavailable' : playing ? 'Pause' : 'Play'}
            className="inline-flex items-center justify-center"
            style={{
              width: 34,
              height: 34,
              borderRadius: 999,
              border: 'none',
              backgroundColor: audioError ? 'var(--bg-elevated)' : 'var(--accent)',
              color: audioError ? 'var(--text-faint)' : 'var(--accent-contrast, #fff)',
              cursor: audioError ? 'not-allowed' : 'pointer',
              boxShadow: 'var(--shadow-small)',
              flexShrink: 0,
              transition: 'background-color 120ms cubic-bezier(0.3, 0, 0.2, 1)',
            }}
          >
            {playing ? (
              <Pause size={14} weight="fill" />
            ) : (
              <Play size={14} weight="fill" style={{ marginLeft: 1 }} />
            )}
          </motion.button>
        </div>

        {/* Waveform — live during playback, snapshot otherwise. */}
        <div
          style={{
            margin: '0 14px',
            padding: '8px 12px',
            borderRadius: 'var(--radius)',
            backgroundColor: 'var(--bg-elevated)',
            flexShrink: 0,
          }}
        >
          <WaveformBars
            ref={barsRef}
            levels={snapshotPeaks}
            isPeaking={false}
            height={28}
            floor={0.08}
            barWidth={3}
            gap={4}
          />
        </div>

        {/* Scrubber + time readout. The track itself is clickable to seek;
            it stops pointer-down bubbling so a click here doesn't start a
            drag. */}
        <div
          className="flex items-center gap-2.5"
          style={{ padding: '8px 14px 0 14px', flexShrink: 0 }}
        >
          <div
            className="text-[10.5px] font-medium tabular-nums"
            style={{ color: 'var(--text-faint)', minWidth: 32 }}
          >
            {formatDuration(currentTime)}
          </div>
          <div
            onPointerDown={controlPointerDown}
            onClick={onScrub}
            role="slider"
            aria-label="Seek playback"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(currentTime)}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 999,
              backgroundColor: 'var(--bg-elevated)',
              position: 'relative',
              cursor: audioError ? 'not-allowed' : 'pointer',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${progress * 100}%`,
                borderRadius: 999,
                backgroundColor: 'var(--accent)',
                transition: playing ? 'none' : 'width 160ms cubic-bezier(0.3, 0, 0.2, 1)',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: `calc(${progress * 100}% - 5px)`,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 10,
                height: 10,
                borderRadius: 999,
                backgroundColor: 'var(--accent)',
                boxShadow: 'var(--shadow-small)',
                pointerEvents: 'none',
                opacity: duration > 0 ? 1 : 0,
              }}
              aria-hidden
            />
          </div>
          <div
            className="text-[10.5px] font-medium tabular-nums"
            style={{ color: 'var(--text-faint)', minWidth: 32, textAlign: 'right' }}
          >
            {formatDuration(duration)}
          </div>
        </div>

        {/* Transcript — Gemini's cleaned-up version. Three-line clamp by
            default with an expand toggle. Shows a Transcribing pulse
            while the background call is in flight; a small Retry button
            when transcript is empty and we're not currently transcribing
            (typical case: user reloaded mid-transcribe). */}
        <div
          className="flex-1 min-w-0"
          style={{ padding: '8px 14px 12px 14px', overflow: 'hidden', position: 'relative' }}
        >
          {transcribing ? (
            <TranscribingHint />
          ) : hasTranscript ? (
            <>
              <div
                className="text-[12.5px] leading-snug"
                style={{
                  color: 'var(--text)',
                  display: '-webkit-box',
                  WebkitLineClamp: expanded ? 'unset' : 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {transcript}
              </div>
              {transcript.length > 140 && (
                <button
                  type="button"
                  onPointerDown={controlPointerDown}
                  onClick={onToggleExpand}
                  className="mt-1 text-[10.5px] font-medium hover:underline"
                  style={{
                    color: 'var(--text-mute)',
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                  }}
                >
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2">
              <div className="text-[11.5px] italic" style={{ color: 'var(--text-faint)' }}>
                No transcript captured
              </div>
              <button
                type="button"
                onPointerDown={controlPointerDown}
                onClick={onRetryTranscribe}
                className="inline-flex items-center gap-1 text-[10.5px] font-medium hover:underline"
                style={{
                  color: 'var(--text-mute)',
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                }}
                title="Retry transcription"
              >
                <ArrowClockwise size={11} weight="bold" />
                Retry
              </button>
            </div>
          )}
        </div>

        {/* Hidden audio element drives playback. preload=metadata keeps
            the request light until the user actually plays.
            crossOrigin must be left as anonymous-by-default so the
            same-origin /api/files response stays uncorsed. */}
        <audio
          ref={audioRef}
          src={data.url}
          preload="metadata"
          style={{ display: 'none' }}
          aria-hidden
        />
      </div>
    </motion.div>
  )
}

function TranscribingHint() {
  return (
    <div className="flex items-center gap-2">
      <motion.div
        animate={{ opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 1.4, ease: [0.2, 0.8, 0.2, 1], repeat: Infinity }}
        className="text-[11.5px] font-medium"
        style={{ color: 'var(--text-mute)' }}
      >
        Transcribing…
      </motion.div>
    </div>
  )
}

function formatDuration(sec: number): string {
  const s = Math.round(Math.max(0, sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
  return `${m}:${r.toString().padStart(2, '0')}`
}
