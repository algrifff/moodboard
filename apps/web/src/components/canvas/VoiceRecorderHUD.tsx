import { Microphone, Stop } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { uploadFile } from '@/lib/api'
import { EASE_OUT_QUICK, EASE_OUT_STANDARD, SNAP_SPRING } from '@/lib/motion'
import { createVoiceNote } from '@/lib/objectFactory'
import { screenToWorld } from '@/lib/transform'
import { rememberPeaks } from '@/lib/voiceNotePeaks'
import { markDone, markTranscribing } from '@/lib/voiceNoteTranscribing'
import { createVoiceRecorder, type VoiceRecorderHandle } from '@/lib/voiceRecorder'
import { filenameFromUrl, transcribeVoiceNote } from '@/lib/voiceTranscribeApi'
import { useCanvasStore } from '@/store/canvas'
import { showToast } from './Toast'
import { WaveformBars, type WaveformBarsHandle } from './WaveformBars'

// Floating bottom-centre recording HUD.
//
// Idle:  44px circular mic button. EASE_OUT_QUICK press, exact match to
//        the existing toolbar button feel.
// Live:  pill morphs open via Framer `layout` + SNAP_SPRING. Live dot
//        pulses; bars react to the analyser at RAF cadence (no React
//        re-render — bars use an imperative handle); border tints accent
//        when the rolling RMS crosses the peak threshold; timer ticks;
//        pressing M or clicking stop ends the take, uploads, spawns the
//        voice-note card, and fires the Gemini transcription call in
//        the background.
//
// The recorder lives in a ref so the keyboard shortcut can drive
// start/stop without the toggle handler depending on render state.

type Mode = 'idle' | 'recording' | 'uploading'

export function VoiceRecorderHUD() {
  const [mode, setMode] = useState<Mode>('idle')
  const [timerLabel, setTimerLabel] = useState('0:00')
  const [isPeaking, setIsPeaking] = useState(false)

  const recorderRef = useRef<VoiceRecorderHandle | null>(null)
  const barsRef = useRef<WaveformBarsHandle | null>(null)
  const startedAtRef = useRef<number | null>(null)
  const timerIntervalRef = useRef<number | null>(null)
  // Peak state lives in a ref so the RAF-driven setLevels call always
  // sees the freshest value without depending on React re-renders.
  const peakingRef = useRef(false)

  const addObject = useCanvasStore((s) => s.addObject)
  const updateObject = useCanvasStore((s) => s.updateObject)
  const commit = useCanvasStore((s) => s.commitBeforeAction)

  const viewCenterWorld = useCallback(() => {
    const { scale, offset, viewportSize } = useCanvasStore.getState()
    return screenToWorld(
      { x: viewportSize.width / 2, y: viewportSize.height / 2 },
      { scale, x: offset.x, y: offset.y },
    )
  }, [])

  const stopTimer = useCallback(() => {
    if (timerIntervalRef.current !== null) {
      window.clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
    }
  }, [])

  const handleStart = useCallback(async () => {
    if (mode !== 'idle') return
    setIsPeaking(false)
    peakingRef.current = false
    const recorder = createVoiceRecorder({
      onLevel: (bars) => {
        barsRef.current?.setLevels(bars, peakingRef.current)
      },
      onPeak: (peaking) => {
        peakingRef.current = peaking
        setIsPeaking(peaking)
      },
      onError: (err) => {
        console.warn('[voice-recorder]', err)
      },
    })
    recorderRef.current = recorder
    try {
      await recorder.start()
    } catch (e) {
      recorderRef.current = null
      const name = e instanceof Error ? e.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        showToast('Microphone access denied — enable it in your browser to record.')
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        showToast('No microphone found.')
      } else {
        showToast(`Couldn't start recording: ${e instanceof Error ? e.message : 'unknown'}`)
      }
      return
    }
    startedAtRef.current = performance.now()
    setTimerLabel('0:00')
    setMode('recording')
    timerIntervalRef.current = window.setInterval(() => {
      const t0 = startedAtRef.current
      if (t0 === null) return
      const elapsed = (performance.now() - t0) / 1000
      setTimerLabel(formatDuration(elapsed))
    }, 250)
  }, [mode])

  const handleStop = useCallback(async () => {
    if (mode !== 'recording') return
    const recorder = recorderRef.current
    if (!recorder) return
    stopTimer()
    setMode('uploading')
    let result
    try {
      result = await recorder.stop()
    } catch (e) {
      showToast(`Recording failed: ${e instanceof Error ? e.message : 'unknown'}`)
      recorderRef.current = null
      setMode('idle')
      return
    }
    recorderRef.current = null

    // Spawn the card up front, then fire the transcription call in the
    // background. The card knows how to render "Transcribing…" until
    // markDone is called.
    let spawnedId: string | null = null
    try {
      const ext = extensionForMime(result.mimeType)
      const upload = await uploadFile(result.blob, `voice-note.${ext}`)
      const obj = createVoiceNote(viewCenterWorld(), useCanvasStore.getState().objects.length, {
        url: upload.url,
        mimeType: upload.mimeType || result.mimeType,
        durationSec: result.durationSec,
        transcript: '',
        fetchedAt: new Date().toISOString(),
      })
      rememberPeaks(obj.id, result.peakSnapshot)
      commit()
      addObject(obj)
      spawnedId = obj.id

      const filename = filenameFromUrl(upload.url)
      if (filename) {
        markTranscribing(obj.id)
        // Background — fire and forget. Cleanup happens in the .then/.catch.
        void transcribeVoiceNote(filename)
          .then((transcript) => {
            updateObject(obj.id, {
              data: { ...obj.data, transcript },
            })
          })
          .catch((err) => {
            console.warn('[voice/transcribe] failed', err)
            showToast(`Transcription failed — the recording is still saved.`)
          })
          .finally(() => {
            markDone(obj.id)
          })
      }
    } catch (e) {
      showToast(`Upload failed: ${e instanceof Error ? e.message : 'unknown'}`)
      if (spawnedId) markDone(spawnedId)
    } finally {
      setIsPeaking(false)
      peakingRef.current = false
      setMode('idle')
    }
  }, [mode, stopTimer, viewCenterWorld, addObject, updateObject, commit])

  // M toggles recording. Gated by !isEditableTarget so it doesn't fire
  // while a sticky or text node is being typed into.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'm' && e.key !== 'M') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditableTarget(e.target)) return
      e.preventDefault()
      if (mode === 'idle') {
        handleStart()
      } else if (mode === 'recording') {
        handleStop()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mode, handleStart, handleStop])

  // Failsafe — if the component unmounts mid-recording, drop the stream.
  useEffect(() => {
    return () => {
      stopTimer()
      recorderRef.current?.cancel()
      recorderRef.current = null
    }
  }, [stopTimer])

  const isRecording = mode === 'recording' || mode === 'uploading'

  return (
    <div
      className="pointer-events-none fixed bottom-6 left-1/2 z-20"
      style={{ transform: 'translateX(-50%)' }}
    >
      <motion.div
        layout
        transition={SNAP_SPRING}
        data-peaking={isPeaking ? 'true' : 'false'}
        className="pointer-events-auto bg-card/95 backdrop-blur-md"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          color: 'var(--text)',
          borderRadius: 999,
          padding: isRecording ? '8px 14px' : 4,
          minHeight: 48,
          boxShadow: 'var(--shadow-pill)',
          // Peak-driven border ring: short attack, longer release so the
          // tint feels like sound, not a flicker. ease-out only — never
          // ease-in-out per CLAUDE.md.
          outline: isPeaking ? '1.5px solid var(--accent)' : '1.5px solid transparent',
          outlineOffset: -1,
          transition: isPeaking
            ? 'outline-color 120ms cubic-bezier(0.3, 0, 0.2, 1)'
            : 'outline-color 400ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {isRecording ? (
            <motion.div
              key="recording"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: [...EASE_OUT_STANDARD] }}
              style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 320 }}
            >
              <LiveDot />
              <div
                className="text-[12px] font-medium tabular-nums"
                style={{ color: 'var(--text-mute)', minWidth: 36 }}
              >
                {timerLabel}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <WaveformBars
                  ref={barsRef}
                  isPeaking={isPeaking}
                  height={26}
                  floor={0.08}
                  barWidth={3}
                  gap={4}
                />
              </div>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={mode}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15, ease: [...EASE_OUT_STANDARD] }}
                  className="text-[11px] font-medium uppercase tracking-[0.06em]"
                  style={{
                    color: 'var(--text-faint)',
                    minWidth: 56,
                    textAlign: 'right',
                  }}
                >
                  {mode === 'uploading' ? 'Saving' : 'Listening'}
                </motion.div>
              </AnimatePresence>
              <StopButton onClick={handleStop} disabled={mode === 'uploading'} />
            </motion.div>
          ) : (
            <motion.button
              key="idle"
              type="button"
              onClick={handleStart}
              whileTap={{ scale: 0.94 }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12, ease: [...EASE_OUT_QUICK] }}
              aria-label="Record a voice note (M)"
              title="Record a voice note (M)"
              // Glass-pill button matching the top toolbar: transparent
              // chrome, white icon, hover lifts to bg-elevated. The outer
              // motion.div already provides the bg-card/95 + blur surface.
              className="text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
              style={{
                width: 40,
                height: 40,
                borderRadius: 999,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Microphone size={18} weight="regular" />
            </motion.button>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}

function LiveDot() {
  return (
    <motion.div
      animate={{ opacity: [1, 0.45, 1] }}
      transition={{
        duration: 1.4,
        ease: [...EASE_OUT_STANDARD],
        repeat: Infinity,
      }}
      style={{
        width: 9,
        height: 9,
        borderRadius: 999,
        backgroundColor: '#FF4D4F',
        boxShadow: '0 0 0 3px rgba(255, 77, 79, 0.18)',
        flexShrink: 0,
      }}
      aria-hidden
    />
  )
}

function StopButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.9 }}
      transition={{ duration: 0.12, ease: [...EASE_OUT_QUICK] }}
      aria-label="Stop recording (M)"
      title="Stop recording (M)"
      style={{
        width: 30,
        height: 30,
        borderRadius: 999,
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--bg-elevated)',
        color: '#FF4D4F',
        flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Stop size={12} weight="fill" />
    </motion.button>
  )
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function formatDuration(sec: number): string {
  const s = Math.round(Math.max(0, sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
  return `${m}:${r.toString().padStart(2, '0')}`
}

function extensionForMime(mime: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('mp4')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mpeg')) return 'mp3'
  if (mime.includes('wav')) return 'wav'
  return 'webm'
}
