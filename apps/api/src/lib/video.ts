// Video clip extractor — yt-dlp metadata + the platform thumbnail saved to
// /data like an upload. Lightweight: no audio download, no transcription.
//
// Pipeline (extractVideoClip):
//   1. yt-dlp -J <url>          → metadata (id, title, channel, duration, thumb)
//   2. fetch the platform thumb → saveUpload → /api/files/<id>.<ext>
//
// Deep analysis (transitions, hooks, pacing, sound, dialogue) is NOT done
// here — it's the Senior Video Editor agent's job, which sends the clip to
// Gemini at analysis time (see lib/gemini.ts). Import just lands the card.
//
// No connection / OAuth — yt-dlp handles public-content access itself. The
// URL host is checked against the private-IP guard (shared with web.ts) so a
// pasted internal URL can't turn this into an SSRF primitive. A missing
// thumbnail degrades gracefully — the import still returns the card.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { VideoClipData } from '@moodboard/shared'
import { nanoid } from 'nanoid'
import { saveUpload } from './storage'
import { isPrivateHost } from './web'

const execFileAsync = promisify(execFile)

// yt-dlp metadata probe budget.
const META_TIMEOUT_MS = 45_000
const THUMB_MAX_BYTES = 8 * 1024 * 1024

export class VideoExtractError extends Error {
  constructor(
    public code: 'BAD_URL' | 'PRIVATE_HOST' | 'YTDLP_MISSING' | 'YTDLP_FAILED' | 'TIMEOUT',
    message: string,
  ) {
    super(message)
    this.name = 'VideoExtractError'
  }
}

type YtMeta = {
  id?: string
  title?: string
  fulltitle?: string
  uploader?: string
  channel?: string
  uploader_id?: string
  duration?: number
  thumbnail?: string
  webpage_url?: string
  original_url?: string
  extractor_key?: string
  extractor?: string
  _type?: string
  entries?: YtMeta[]
}

export type VideoExtractResult = { data: VideoClipData }

export async function extractVideoClip(input: string, userId: string): Promise<VideoExtractResult> {
  const parsed = (() => {
    try {
      return new URL(input.trim())
    } catch {
      return null
    }
  })()
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new VideoExtractError('BAD_URL', 'Not a valid http(s) URL')
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new VideoExtractError('PRIVATE_HOST', 'Refusing to fetch a private/internal host')
  }

  const meta = await probeMetadata(parsed.toString())
  const fetchedAt = new Date().toISOString()
  const platform = normalisePlatform(meta.extractor_key ?? meta.extractor)
  const url = meta.webpage_url ?? meta.original_url ?? parsed.toString()
  const videoId = meta.id ?? ''
  const title = (meta.fulltitle ?? meta.title ?? '').trim()
  const channel = (meta.channel ?? meta.uploader ?? meta.uploader_id ?? '').trim()
  const durationSec = typeof meta.duration === 'number' && meta.duration > 0 ? meta.duration : 0

  // Best-effort thumbnail — a failure just leaves the card with its glyph.
  const thumbnailUrl = await saveThumbnail(meta.thumbnail, userId).catch(() => '')

  return {
    data: { platform, url, videoId, title, channel, durationSec, thumbnailUrl, fetchedAt },
  }
}

// ---------------------------------------------------------------------------
// yt-dlp
// ---------------------------------------------------------------------------

async function probeMetadata(url: string): Promise<YtMeta> {
  let stdout: string
  try {
    const res = await execFileAsync(
      'yt-dlp',
      ['-J', '--no-playlist', '--no-warnings', '--no-progress', url],
      { timeout: META_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    )
    stdout = res.stdout
  } catch (e) {
    if (isMissingBinary(e)) {
      throw new VideoExtractError('YTDLP_MISSING', 'yt-dlp is not installed on the server')
    }
    if (isTimeout(e)) {
      throw new VideoExtractError('TIMEOUT', 'yt-dlp timed out reading the video')
    }
    throw new VideoExtractError(
      'YTDLP_FAILED',
      `yt-dlp could not read this URL: ${errMsg(e).slice(0, 200)}`,
    )
  }
  let json: YtMeta
  try {
    json = JSON.parse(stdout) as YtMeta
  } catch {
    throw new VideoExtractError('YTDLP_FAILED', 'yt-dlp returned unparseable metadata')
  }
  // A playlist/multi-video URL despite --no-playlist (e.g. a channel) — take
  // the first entry so the user still gets a clip.
  if (json._type === 'playlist' && Array.isArray(json.entries) && json.entries[0]) {
    return json.entries[0]
  }
  return json
}

// ---------------------------------------------------------------------------
// Thumbnail
// ---------------------------------------------------------------------------

async function saveThumbnail(thumbUrl: string | undefined, userId: string): Promise<string> {
  if (!thumbUrl) return ''
  const parsed = (() => {
    try {
      return new URL(thumbUrl)
    } catch {
      return null
    }
  })()
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return ''
  if (isPrivateHost(parsed.hostname)) return ''
  const res = await fetch(parsed.toString(), { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) return ''
  const lenHeader = Number(res.headers.get('content-length') ?? '0')
  if (lenHeader && lenHeader > THUMB_MAX_BYTES) return ''
  const ab = await res.arrayBuffer()
  if (ab.byteLength > THUMB_MAX_BYTES || ab.byteLength === 0) return ''
  const buf = Buffer.from(ab)
  const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/jpeg'
  if (!mime.startsWith('image/')) return ''
  const ext = extForMime(mime) ?? extForUrl(parsed.pathname) ?? 'jpg'
  const id = nanoid()
  const saved = await saveUpload(buf, id, ext, mime)
  // Asset row makes GET /api/files/<filename> reachable (the route enforces
  // ownership via this table). Lazy db import mirrors web.ts so the pure
  // helpers stay importable in unit tests without a DATABASE_URL.
  const { db, schema } = await import('../db')
  await db.insert(schema.asset).values({
    id: nanoid(),
    createdBy: userId,
    filename: saved.filename,
    mimeType: mime,
    size: saved.size,
    kind: 'upload',
  })
  return `/api/files/${saved.filename}`
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// yt-dlp's extractor key → our normalised platform label. Anything we don't
// explicitly map (and there are hundreds of extractors) falls to 'other'.
export function normalisePlatform(extractor: string | undefined): string {
  const e = (extractor ?? '').toLowerCase()
  if (e.includes('youtube')) return 'youtube'
  if (e.includes('tiktok')) return 'tiktok'
  if (e.includes('instagram')) return 'instagram'
  if (e.includes('twitter') || e === 'x') return 'x'
  if (e.includes('vimeo')) return 'vimeo'
  return 'other'
}

function extForMime(mime: string): string | null {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/avif':
      return 'avif'
    default:
      return null
  }
}

function extForUrl(pathname: string): string | null {
  const m = pathname.toLowerCase().match(/\.(jpe?g|png|webp|gif|avif)(?:$|\?)/)
  if (!m) return null
  return m[1] === 'jpeg' ? 'jpg' : m[1]!
}

function isMissingBinary(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT'
}

function isTimeout(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const err = e as { killed?: boolean; signal?: string }
  return err.killed === true || err.signal === 'SIGTERM'
}

function errMsg(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const err = e as { stderr?: string; message?: string }
    if (typeof err.stderr === 'string' && err.stderr.trim()) return err.stderr.trim()
    if (typeof err.message === 'string') return err.message
  }
  return String(e)
}
