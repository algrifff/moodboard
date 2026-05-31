import type { ImageData } from '@moodboard/shared'
import { nanoid } from 'nanoid'
import { db, schema } from '../db'
import { saveUpload } from './storage'
import {
  ALLOWED_IMAGE_MIME,
  extFromMime,
  MAX_UPLOAD_BYTES,
  resolveAndCheckHost,
} from './upload-validation'

// MCP-side image importer. The dispatcher hits this when the user
// passes an image URL into `add_url` or `add_image`. Mirrors the SSRF
// + size guards the public /api/proxy route applies (lib/files.ts) —
// kept here as a thin wrapper so the MCP doesn't depend on Hono
// request shapes. Returns an ImageData carrying a `/api/files/...`
// URL the canvas can render directly.

const FETCH_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 3

export class ImageImportError extends Error {
  constructor(
    public code:
      | 'BAD_URL'
      | 'PRIVATE_HOST'
      | 'FETCH_FAILED'
      | 'TIMEOUT'
      | 'TOO_LARGE'
      | 'UNSUPPORTED_TYPE'
      | 'TOO_MANY_REDIRECTS',
    message: string,
  ) {
    super(message)
    this.name = 'ImageImportError'
  }
}

async function fetchSafely(initial: URL): Promise<Response> {
  let current = initial
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const check = await resolveAndCheckHost(current.hostname)
    if (!check.ok) {
      throw new ImageImportError('PRIVATE_HOST', `Host not allowed: ${check.reason}`)
    }
    let upstream: Response
    try {
      upstream = await fetch(current.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      if (name === 'TimeoutError') {
        throw new ImageImportError('TIMEOUT', 'Upstream fetch timed out')
      }
      throw new ImageImportError('FETCH_FAILED', 'Upstream fetch failed')
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      const next = upstream.headers.get('location')
      if (!next) throw new ImageImportError('FETCH_FAILED', 'Redirect without Location')
      const nextUrl = new URL(next, current)
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        throw new ImageImportError('FETCH_FAILED', 'Redirect to non-http(s) scheme')
      }
      try {
        await upstream.body?.cancel()
      } catch {
        // ignore
      }
      current = nextUrl
      continue
    }
    if (!upstream.ok) {
      throw new ImageImportError('FETCH_FAILED', `Upstream ${upstream.status}`)
    }
    return upstream
  }
  throw new ImageImportError('TOO_MANY_REDIRECTS', 'Too many redirects')
}

export async function saveImageFromUrl(url: string, userId: string): Promise<ImageData> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ImageImportError('BAD_URL', 'Not a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ImageImportError('BAD_URL', 'Only http(s) URLs allowed')
  }

  const upstream = await fetchSafely(parsed)

  const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
  if (!ALLOWED_IMAGE_MIME.has(contentType)) {
    try {
      await upstream.body?.cancel()
    } catch {
      // ignore
    }
    throw new ImageImportError('UNSUPPORTED_TYPE', `Unsupported type: ${contentType || 'unknown'}`)
  }

  const contentLength = upstream.headers.get('content-length')
  if (contentLength && Number(contentLength) > MAX_UPLOAD_BYTES) {
    try {
      await upstream.body?.cancel()
    } catch {
      // ignore
    }
    throw new ImageImportError('TOO_LARGE', 'Image exceeds size cap')
  }

  // Stream into a buffer with a size guard — Content-Length can lie.
  const reader = upstream.body?.getReader()
  if (!reader) throw new ImageImportError('FETCH_FAILED', 'Upstream produced no body')
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      received += value.byteLength
      if (received > MAX_UPLOAD_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // ignore
        }
        throw new ImageImportError('TOO_LARGE', 'Image exceeds size cap')
      }
      chunks.push(value)
    }
  }
  const buffer = Buffer.concat(chunks)

  const ext = extFromMime(contentType)
  if (!ext) throw new ImageImportError('UNSUPPORTED_TYPE', `No extension for ${contentType}`)

  const id = nanoid()
  const saved = await saveUpload(buffer, id, ext, contentType)
  await db.insert(schema.asset).values({
    id: nanoid(),
    userId,
    filename: saved.filename,
    mimeType: saved.mimeType,
    size: saved.size,
    kind: 'upload',
  })
  return { url: `/api/files/${saved.filename}` }
}
