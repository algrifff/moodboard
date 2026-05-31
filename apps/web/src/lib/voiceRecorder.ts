// Browser-side voice recorder. Two concerns under one hood:
//
//   1. MediaRecorder — captures the audio blob. Negotiates the best
//      supported MIME (audio/webm;codecs=opus on Chromium, audio/mp4 on
//      Safari) so playback later doesn't need a transcoder.
//   2. Web Audio + AnalyserNode — drives the live waveform. The RAF loop
//      reads frequency buckets, downsamples to BAR_COUNT bars, and tracks
//      a rolling RMS so the HUD can tint when the user gets loud.
//
// Transcription is NOT done here. We capture the blob, hand it to the
// HUD, which uploads it and asks Gemini for a cleaned-up transcript. The
// Web Speech API live-transcription path was removed because Chrome's
// cloud STT was unreliable (frequent `network` errors with no recourse)
// and Gemini gives us a higher-quality, filler-cleaned result anyway.
//
// Stop() resolves to everything the spawner needs: the blob, its MIME,
// the duration, and a snapshot of the last few level frames so the
// on-canvas card can render a static peak strip that recalls the
// recording.

export const BAR_COUNT = 18

// Frequency bins above this index sit in the harmonic-tail territory that
// reads as "silence" for a human voice. Trimming them concentrates the
// visualisation on the bands the user is actually driving.
const VOICE_BIN_CAP = 96

// Rolling-window RMS threshold for "loud enough to count as a peak."
// Calibrated by ear against typical speaking levels in a quiet room.
const PEAK_RMS_THRESHOLD = 0.32

// Hysteresis: the peak state only releases once RMS dips below this. Keeps
// the border tint from flickering when the signal hugs the threshold.
const PEAK_RELEASE_THRESHOLD = 0.22

// MediaRecorder MIME candidates in preference order. The first one the
// browser accepts wins.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const

export type RecordingResult = {
  blob: Blob
  mimeType: string
  durationSec: number
  // Last few level frames from the analyser, averaged into BAR_COUNT bars,
  // so the canvas card can render a static peak strip that mirrors what
  // was on screen at stop time. Values are 0..1.
  peakSnapshot: number[]
}

export type VoiceRecorderHandle = {
  start: () => Promise<void>
  stop: () => Promise<RecordingResult>
  cancel: () => void
}

export type VoiceRecorderOptions = {
  // Per-frame downsampled levels, 0..1, length BAR_COUNT. Pushed at RAF
  // cadence so the HUD can drive a 1:1-with-input waveform.
  onLevel?: (bars: Float32Array) => void
  // Latches true when the rolling RMS crosses PEAK_RMS_THRESHOLD; latches
  // false when it falls below PEAK_RELEASE_THRESHOLD. Hysteresis on
  // purpose so the border tint feels like sound, not LEDs.
  onPeak?: (isPeaking: boolean) => void
  // Anything that goes wrong after `start()` resolves — recorder error,
  // etc. Permission / device errors are thrown synchronously from
  // `start()` instead.
  onError?: (err: Error) => void
}

type Internals = {
  stream: MediaStream
  recorder: MediaRecorder
  mimeType: string
  chunks: Blob[]
  audioCtx: AudioContext
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  // Explicit ArrayBuffer parameterisation so getByteFrequencyData accepts
  // the field — DOM lib distinguishes Uint8Array<ArrayBuffer> from
  // <SharedArrayBuffer> via the Symbol.toStringTag.
  freqBuf: Uint8Array<ArrayBuffer>
  bars: Float32Array
  // Recent frames, kept as a circular snapshot for peakSnapshot.
  recentBars: Float32Array[]
  rafId: number
  startedAt: number
  isPeaking: boolean
}

export function createVoiceRecorder(opts: VoiceRecorderOptions = {}): VoiceRecorderHandle {
  let state: Internals | null = null

  const start = async (): Promise<void> => {
    if (state) return
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is not supported in this browser')
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mimeType = pickSupportedMime()
    if (!mimeType) {
      stopStream(stream)
      throw new Error('No supported audio codec for recording')
    }

    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, { mimeType })
    } catch (e) {
      stopStream(stream)
      throw e instanceof Error ? e : new Error(String(e))
    }

    const audioCtx = new AudioContext()
    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.6
    source.connect(analyser)

    // Bound to an explicit ArrayBuffer so getByteFrequencyData accepts it —
    // newer DOM lib parameterises Uint8Array by its backing buffer kind.
    const freqBuf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
    const bars = new Float32Array(BAR_COUNT)
    const recentBars: Float32Array[] = []
    const chunks: Blob[] = []

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    }
    recorder.onerror = (e) => {
      const err = (e as unknown as { error?: unknown }).error
      opts.onError?.(err instanceof Error ? err : new Error('MediaRecorder error'))
    }
    recorder.start(250)

    const startedAt = performance.now()
    state = {
      stream,
      recorder,
      mimeType,
      chunks,
      audioCtx,
      source,
      analyser,
      freqBuf,
      bars,
      recentBars,
      rafId: 0,
      startedAt,
      isPeaking: false,
    }

    const loop = () => {
      if (!state) return
      state.analyser.getByteFrequencyData(state.freqBuf)
      // Concentrate on the voice band — anything past VOICE_BIN_CAP is
      // mostly noise and produces flat bars that read as "broken."
      const usable = Math.min(state.freqBuf.length, VOICE_BIN_CAP)
      const bucketSize = usable / BAR_COUNT
      let rmsSum = 0
      let rmsCount = 0
      for (let i = 0; i < BAR_COUNT; i++) {
        const lo = Math.floor(i * bucketSize)
        const hi = Math.floor((i + 1) * bucketSize)
        let acc = 0
        let count = 0
        for (let j = lo; j < hi; j++) {
          const v = state.freqBuf[j]
          if (v === undefined) continue
          acc += v
          count += 1
        }
        const avg = count > 0 ? acc / count / 255 : 0
        state.bars[i] = avg
        rmsSum += avg * avg
        rmsCount += 1
      }
      const rms = rmsCount > 0 ? Math.sqrt(rmsSum / rmsCount) : 0
      opts.onLevel?.(state.bars)

      if (!state.isPeaking && rms >= PEAK_RMS_THRESHOLD) {
        state.isPeaking = true
        opts.onPeak?.(true)
      } else if (state.isPeaking && rms <= PEAK_RELEASE_THRESHOLD) {
        state.isPeaking = false
        opts.onPeak?.(false)
      }

      // Keep ~12 recent frames around (~200ms at 60fps) so peakSnapshot
      // averages over a moment, not a single frame.
      const snap = new Float32Array(state.bars)
      state.recentBars.push(snap)
      if (state.recentBars.length > 12) state.recentBars.shift()

      state.rafId = requestAnimationFrame(loop)
    }
    state.rafId = requestAnimationFrame(loop)
  }

  const finalise = async (): Promise<RecordingResult> => {
    if (!state) throw new Error('Recorder is not running')
    const s = state
    state = null

    cancelAnimationFrame(s.rafId)

    const blob = await new Promise<Blob>((resolve, reject) => {
      s.recorder.onstop = () => resolve(new Blob(s.chunks, { type: s.mimeType }))
      s.recorder.onerror = (e) => {
        const err = (e as unknown as { error?: unknown }).error
        reject(err instanceof Error ? err : new Error('MediaRecorder error'))
      }
      try {
        if (s.recorder.state !== 'inactive') s.recorder.stop()
        else resolve(new Blob(s.chunks, { type: s.mimeType }))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })

    try {
      s.source.disconnect()
      await s.audioCtx.close()
    } catch {
      // best-effort
    }
    stopStream(s.stream)

    const durationSec = Math.max(0, Math.round((performance.now() - s.startedAt) / 1000))
    const peakSnapshot = averageRecent(s.recentBars)

    return {
      blob,
      mimeType: s.mimeType,
      durationSec,
      peakSnapshot,
    }
  }

  const cancel = (): void => {
    if (!state) return
    const s = state
    state = null
    cancelAnimationFrame(s.rafId)
    try {
      if (s.recorder.state !== 'inactive') s.recorder.stop()
    } catch {
      // ignore
    }
    try {
      s.source.disconnect()
      s.audioCtx.close().catch(() => undefined)
    } catch {
      // ignore
    }
    stopStream(s.stream)
  }

  return { start, stop: finalise, cancel }
}

function pickSupportedMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  // No reported support — let the browser pick its default by passing
  // through an empty string at the call site.
  return ''
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // ignore
    }
  }
}

function averageRecent(frames: Float32Array[]): number[] {
  if (frames.length === 0) return Array.from({ length: BAR_COUNT }, () => 0)
  const out = new Array<number>(BAR_COUNT).fill(0)
  for (const f of frames) {
    for (let i = 0; i < BAR_COUNT; i++) out[i] = (out[i] ?? 0) + (f[i] ?? 0)
  }
  for (let i = 0; i < BAR_COUNT; i++) out[i] = (out[i] ?? 0) / frames.length
  return out
}
