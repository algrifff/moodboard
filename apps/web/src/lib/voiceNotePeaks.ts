// Short-lived cache for the waveform peak strip a voice-note card shows.
//
// The peak snapshot only exists for the lifetime of the page session — we
// deliberately do NOT persist it on the canvas object (see plan: the
// trade-off is decoding on every hydrate vs accepting a flat placeholder
// for rehydrated cards). The HUD stashes the snapshot here right before
// it calls addObject; the card reads it on mount.
//
// Anything not found falls back to a stylised placeholder rendered from
// the object id, so the strip never looks empty.

const peakCache = new Map<string, number[]>()

export function rememberPeaks(objectId: string, peaks: number[]): void {
  peakCache.set(objectId, peaks)
}

export function getPeaks(objectId: string): number[] | undefined {
  return peakCache.get(objectId)
}

// Deterministic stylised waveform for cards we have no snapshot for.
// Seeded by the object id so the same card always looks the same. Shape
// is a soft mid-rise / mid-fall — reads as "this is a voice note" without
// pretending to be the real signal.
export function placeholderPeaks(seed: string, count: number): number[] {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i++) {
    hash = (hash ^ seed.charCodeAt(i)) >>> 0
    hash = Math.imul(hash, 16777619) >>> 0
  }
  const random = () => {
    hash = (hash + 0x6d2b79f5) >>> 0
    let t = hash
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = new Array<number>(count)
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1)
    // Smooth bell from 0.25 to ~0.65 at the centre, falling back to 0.3
    // at the tails. Plus a small jitter so adjacent bars vary.
    const bell = 0.3 + 0.35 * Math.sin(Math.PI * t)
    const jitter = (random() - 0.5) * 0.18
    out[i] = Math.max(0.15, Math.min(0.85, bell + jitter))
  }
  return out
}
