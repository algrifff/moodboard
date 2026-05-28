import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { nanoid } from 'nanoid'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { processPdf } from '../lib/pdfProcessing'
import { rateLimit } from '../lib/rateLimit'
import {
  isSafeFilename,
  pdfPath,
  pdfThumbPath,
  savePdf,
  savePdfThumbnail,
  saveUpload,
  uploadPath,
} from '../lib/storage'
import {
  ALLOWED_IMAGE_MIME,
  MAX_PDF_BYTES,
  MAX_UPLOAD_BYTES,
  PDF_MIME,
  extFromMime,
  mimeFromExt,
  resolveAndCheckHost,
} from '../lib/upload-validation'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const files = new Hono<{ Variables: Variables }>()

// All file routes require an authenticated user.
files.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

const uploadRateLimit = rateLimit({ scope: 'upload', limit: 30, windowMs: 60_000 })
const proxyRateLimit = rateLimit({ scope: 'proxy', limit: 30, windowMs: 60_000 })

async function recordAsset(
  userId: string,
  filename: string,
  mimeType: string,
  size: number,
  kind: 'upload' | 'pdf' | 'pdf-thumb' = 'upload',
): Promise<void> {
  await db.insert(schema.asset).values({
    id: nanoid(),
    userId,
    filename,
    mimeType,
    size,
    kind,
  })
}

files.post(
  '/upload',
  uploadRateLimit,
  bodyLimit({
    // Per-request limit is the larger of the two; we re-check the exact
    // size below once we know whether the file is an image or a PDF.
    maxSize: MAX_PDF_BYTES + 1024 * 1024,
    onError: (c) => c.json({ error: 'File too large' }, 413),
  }),
  async (c) => {
    const user = c.get('user')!
    const body = await c.req.parseBody()
    const incoming = body.file
    if (!(incoming instanceof File)) {
      return c.json({ error: 'No file field' }, 400)
    }

    if (incoming.type === PDF_MIME) {
      if (incoming.size > MAX_PDF_BYTES) {
        return c.json({ error: 'PDF too large' }, 413)
      }
      const id = nanoid()
      const buffer = Buffer.from(await incoming.arrayBuffer())
      let result
      try {
        result = await processPdf(buffer)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'PDF processing failed'
        return c.json({ error: msg }, 400)
      }
      const savedPdf = await savePdf(buffer, id)
      await recordAsset(user.id, savedPdf.filename, PDF_MIME, savedPdf.size, 'pdf')

      let thumbnailUrl: string | undefined
      if (result.thumbnailPng) {
        const savedThumb = await savePdfThumbnail(result.thumbnailPng, id)
        await recordAsset(
          user.id,
          savedThumb.filename,
          'image/png',
          result.thumbnailPng.byteLength,
          'pdf-thumb',
        )
        thumbnailUrl = `/api/files/${savedThumb.filename}`
      }

      return c.json({
        id: savedPdf.id,
        filename: savedPdf.filename,
        url: `/api/files/${savedPdf.filename}`,
        size: savedPdf.size,
        mimeType: PDF_MIME,
        thumbnailUrl,
        extractedText: result.text,
        pageCount: result.pageCount,
      })
    }

    if (incoming.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: 'File too large' }, 413)
    }
    if (!ALLOWED_IMAGE_MIME.has(incoming.type)) {
      return c.json({ error: `Unsupported type: ${incoming.type}` }, 415)
    }
    const ext = extFromMime(incoming.type)
    if (!ext) return c.json({ error: 'Unsupported type' }, 415)

    const id = nanoid()
    const buffer = Buffer.from(await incoming.arrayBuffer())
    const saved = await saveUpload(buffer, id, ext, incoming.type)
    await recordAsset(user.id, saved.filename, saved.mimeType, saved.size, 'upload')
    return c.json({
      id: saved.id,
      filename: saved.filename,
      url: `/api/files/${saved.filename}`,
      size: saved.size,
      mimeType: saved.mimeType,
    })
  },
)

async function fetchUpstreamSafely(initialUrl: URL, maxHops = 3): Promise<Response> {
  let current = initialUrl
  for (let hop = 0; hop < maxHops; hop++) {
    const check = await resolveAndCheckHost(current.hostname)
    if (!check.ok) {
      throw new Error(`Host not allowed: ${check.reason}`)
    }
    const upstream = await fetch(current.toString(), {
      redirect: 'manual',
      // Bound the upstream wait time so we can't be tarpitted.
      signal: AbortSignal.timeout(15_000),
    })
    if (upstream.status >= 300 && upstream.status < 400) {
      const next = upstream.headers.get('location')
      if (!next) throw new Error('Redirect without Location')
      const nextUrl = new URL(next, current)
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        throw new Error('Redirect to non-http(s) scheme')
      }
      // discard body before continuing
      try {
        await upstream.body?.cancel()
      } catch {
        // ignore
      }
      current = nextUrl
      continue
    }
    return upstream
  }
  throw new Error('Too many redirects')
}

files.get('/proxy', proxyRateLimit, async (c) => {
  const user = c.get('user')!
  const url = c.req.query('url')
  if (!url) return c.json({ error: 'Missing url' }, 400)

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return c.json({ error: 'Invalid url' }, 400)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return c.json({ error: 'Only http(s) urls allowed' }, 400)
  }

  let upstream: Response
  try {
    upstream = await fetchUpstreamSafely(parsed)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'fetch failed'
    if (msg.startsWith('Host not allowed')) return c.json({ error: msg }, 400)
    return c.json({ error: 'Upstream fetch failed' }, 502)
  }
  if (!upstream.ok) {
    try {
      await upstream.body?.cancel()
    } catch {
      // ignore
    }
    return c.json({ error: `Upstream ${upstream.status}` }, 502)
  }

  const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
  if (!ALLOWED_IMAGE_MIME.has(contentType)) {
    try {
      await upstream.body?.cancel()
    } catch {
      // ignore
    }
    return c.json({ error: `Unsupported type: ${contentType || 'unknown'}` }, 415)
  }
  const contentLength = upstream.headers.get('content-length')
  if (contentLength && Number(contentLength) > MAX_UPLOAD_BYTES) {
    try {
      await upstream.body?.cancel()
    } catch {
      // ignore
    }
    return c.json({ error: 'File too large' }, 413)
  }

  // Stream into a buffer, but abort once we cross the size threshold so we
  // can't be drowned by an upstream that lies about Content-Length.
  const reader = upstream.body?.getReader()
  if (!reader) return c.json({ error: 'Upstream produced no body' }, 502)
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
        return c.json({ error: 'File too large' }, 413)
      }
      chunks.push(value)
    }
  }
  const buffer = Buffer.concat(chunks)

  const ext = extFromMime(contentType)
  if (!ext) return c.json({ error: 'Unsupported type' }, 415)
  const id = nanoid()
  const saved = await saveUpload(buffer, id, ext, contentType)
  await recordAsset(user.id, saved.filename, saved.mimeType, saved.size)
  return c.json({
    id: saved.id,
    filename: saved.filename,
    url: `/api/files/${saved.filename}`,
    size: saved.size,
    mimeType: contentType,
  })
})

files.get('/files/:filename', async (c) => {
  const user = c.get('user')!
  const filename = c.req.param('filename')
  if (!isSafeFilename(filename)) {
    return c.json({ error: 'Bad filename' }, 400)
  }
  // Enforce ownership: only the user who uploaded the asset can serve it.
  const [row] = await db
    .select()
    .from(schema.asset)
    .where(and(eq(schema.asset.filename, filename), eq(schema.asset.userId, user.id)))
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)

  const fullPath =
    row.kind === 'pdf'
      ? pdfPath(filename)
      : row.kind === 'pdf-thumb'
        ? pdfThumbPath(filename)
        : uploadPath(filename)
  let s
  try {
    s = await stat(fullPath)
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
  if (!s.isFile()) return c.json({ error: 'Not found' }, 404)

  const ext = path.extname(filename).slice(1)
  const mimeType = row.mimeType || mimeFromExt(ext)
  const webStream = Readable.toWeb(createReadStream(fullPath)) as ReadableStream
  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(s.size),
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})
