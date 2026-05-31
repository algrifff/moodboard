// Video clip extractor — yt-dlp metadata + audio, OpenAI Whisper transcript,
// platform thumbnail saved to /data like an upload.
//
// Pipeline (extractVideoClip):
//   1. yt-dlp -J <url>            → metadata (id, title, channel, duration, thumb)
//   2. yt-dlp -x (mp3, 16k mono)  → audio to a temp dir   [only if transcribing]
//   3. OpenAI whisper-1           → transcript
//   4. fetch the platform thumb   → saveUpload → /api/files/<id>.<ext>
//   5. delete the temp audio
//
// No connection / OAuth — yt-dlp handles public-content access itself. The
// URL host is checked against the private-IP guard (shared with web.ts) so a
// pasted internal URL can't turn this into an SSRF primitive.
//
// Everything past metadata degrades gracefully: missing OPENAI_API_KEY, an
// over-long video, an oversized or failed audio download, or a missing
// thumbnail each just drop that piece — the import still returns the card.

import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { VideoClipData } from '@moodboard/shared'
import { nanoid } from 'nanoid'
import { saveUpload } from './storage'
import { isPrivateHost } from './web'

const execFileAsync = promisify(execFile)

// yt-dlp metadata probe budget. The audio download gets its own longer
// budget since it actually pulls bytes.
const META_TIMEOUT_MS = 45_000
const DOWNLOAD_TIMEOUT_MS = 120_000
const WHISPER_TIMEOUT_MS = 120_000

// Videos longer than this skip transcription (cost + Whisper's 25 MB file
// cap). Metadata + thumbnail still import. 16 kHz mono mp3 ≈ 0.5 MB/min, so
// 40 min stays comfortably under the cap.
const MAX_TRANSCRIBE_SEC = 40 * 60
// Whisper rejects files > 25 MB; stay under with headroom.
const AUDIO_MAX_BYTES = 24 * 1024 * 1024
const THUMB_MAX_BYTES = 8 * 1024 * 1024

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'

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

  // Thumbnail + transcript are independent best-effort enrichments.
  const [thumbnailUrl, transcript] = await Promise.all([
    saveThumbnail(meta.thumbnail, userId).catch(() => ''),
    maybeTranscribe(parsed.toString(), durationSec).catch((e) => {
      console.warn('[video] transcription failed, continuing without:', errMsg(e))
      return ''
    }),
  ])

  return {
    data: {
      platform,
      url,
      videoId,
      title,
      channel,
      durationSec,
      thumbnailUrl,
      transcript,
      fetchedAt,
    },
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

async function maybeTranscribe(url: string, durationSec: number): Promise<string> {
  const key = process.env.OPENAI_API_KEY
  if (!key) return '' // transcription is opt-in via the key
  if (durationSec > 0 && durationSec > MAX_TRANSCRIBE_SEC) return '' // too long — skip
  const dir = await mkdtemp(path.join(tmpdir(), 'mb-video-'))
  try {
    // Pull just the audio, transcoded to 16 kHz mono mp3 — ideal for speech
    // recognition and small enough to stay under Whisper's 25 MB cap.
    await execFileAsync(
      'yt-dlp',
      [
        '-x',
        '--audio-format',
        'mp3',
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        '--postprocessor-args',
        'ffmpeg:-ar 16000 -ac 1 -b:a 64k',
        '-o',
        path.join(dir, 'audio.%(ext)s'),
        url,
      ],
      { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    )
    const files = await readdir(dir)
    const mp3 = files.find((f) => f.endsWith('.mp3'))
    if (!mp3) return ''
    const buf = await readFile(path.join(dir, mp3))
    if (buf.byteLength > AUDIO_MAX_BYTES) return '' // would 413 at Whisper
    return await transcribeWithOpenAI(buf, key)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function transcribeWithOpenAI(audio: Buffer, key: string): Promise<string> {
  const form = new FormData()
  // Buffer → Uint8Array view keeps the Blob constructor happy under TS.
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'audio.mp3')
  form.append('model', 'whisper-1')
  form.append('response_format', 'text')
  const res = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new Error(`Whisper ${res.status}: ${body.slice(0, 200)}`)
  }
  // response_format=text returns the transcript as the raw body.
  return (await res.text()).trim()
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
    userId,
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
