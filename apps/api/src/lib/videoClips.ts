import type { VideoClipBreakdown, VideoEditorBreakdown } from '@moodboard/shared'
import { GEMINI_VIDEO_MODEL } from './gemini'

// ── Senior Video Editor: multi-clip orchestration helpers ──────────────────
// Each video is watched by Gemini exactly once, ever — the route caches per
// clip (keyed by videoClipCacheTag + the clip's own hash), independent of the
// group. These helpers keep the cap, cache key, and assembly in one place; the
// route owns the DB reads/writes and the bounded-concurrency walk.

// Cap clips analysed per group. Beyond this they're reported as `skipped` and
// the user can re-run to fold them in — bounds worst-case spend per group.
export const MAX_VIDEO_CLIPS = 6

// How many clips to send to Gemini at once. Independent calls (unlike the
// Anthropic parallel-firing 502s), but keep it modest so a big group doesn't
// open a dozen downloads/uploads at once.
export const VIDEO_CLIP_CONCURRENCY = 3

// Per-clip cache bucket — distinct from the editor's group tag so one video
// reuses its breakdown across boards, groups, and re-runs. Bump the version
// when the per-clip prompt or stored shape changes.
export function videoClipCacheTag(): string {
  return `video-clip@${GEMINI_VIDEO_MODEL}@v1`
}

// Assemble per-clip breakdowns into the agent's output. Empty group → a clear
// hint; clips dropped by the cap → a `skipped` count the UI surfaces.
export function assembleVideoEditorBreakdown(
  clips: VideoClipBreakdown[],
  skipped: number,
): VideoEditorBreakdown {
  if (clips.length === 0) {
    return {
      clips: [],
      note: 'Group this agent with one or more video clips and it will break each one down.',
    }
  }
  return skipped > 0 ? { clips, skipped } : { clips }
}

// Bounded-concurrency map that preserves input order — the per-clip walk wants
// it, and exporting it keeps the behaviour test-friendly.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i] as T, i)
    }
  })
  await Promise.all(workers)
  return results
}
