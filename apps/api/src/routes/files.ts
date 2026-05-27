import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import { saveUpload, uploadPath, isSafeFilename } from '../lib/storage'
import {
  ALLOWED_IMAGE_MIME,
  MAX_UPLOAD_BYTES,
  extFromMime,
  isLikelySsrfTarget,
  mimeFromExt,
} from '../lib/upload-validation'

export const files = new Hono()

files.post('/upload', async (c) => {
  const body = await c.req.parseBody()
  const incoming = body.file
  if (!(incoming instanceof File)) {
    return c.json({ error: 'No file field' }, 400)
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
  return c.json({
    id: saved.id,
    filename: saved.filename,
    url: `/api/files/${saved.filename}`,
    size: saved.size,
    mimeType: saved.mimeType,
  })
})

files.get('/proxy', async (c) => {
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
  if (isLikelySsrfTarget(parsed.hostname)) {
    return c.json({ error: 'Host not allowed' }, 400)
  }

  let upstream: Response
  try {
    upstream = await fetch(url, { redirect: 'follow' })
  } catch {
    return c.json({ error: 'Upstream fetch failed' }, 502)
  }
  if (!upstream.ok) {
    return c.json({ error: `Upstream ${upstream.status}` }, 502)
  }

  const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
  if (!ALLOWED_IMAGE_MIME.has(contentType)) {
    return c.json({ error: `Unsupported type: ${contentType || 'unknown'}` }, 415)
  }
  const contentLength = upstream.headers.get('content-length')
  if (contentLength && Number(contentLength) > MAX_UPLOAD_BYTES) {
    return c.json({ error: 'File too large' }, 413)
  }

  const buffer = Buffer.from(await upstream.arrayBuffer())
  if (buffer.length > MAX_UPLOAD_BYTES) {
    return c.json({ error: 'File too large' }, 413)
  }

  const ext = extFromMime(contentType)
  if (!ext) return c.json({ error: 'Unsupported type' }, 415)
  const id = nanoid()
  const saved = await saveUpload(buffer, id, ext, contentType)
  return c.json({
    id: saved.id,
    filename: saved.filename,
    url: `/api/files/${saved.filename}`,
    size: saved.size,
    mimeType: saved.mimeType,
  })
})

files.get('/files/:filename', async (c) => {
  const filename = c.req.param('filename')
  if (!isSafeFilename(filename)) {
    return c.json({ error: 'Bad filename' }, 400)
  }
  const fullPath = uploadPath(filename)
  let s
  try {
    s = await stat(fullPath)
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
  if (!s.isFile()) return c.json({ error: 'Not found' }, 404)

  const ext = path.extname(filename).slice(1)
  const mimeType = mimeFromExt(ext)
  const webStream = Readable.toWeb(createReadStream(fullPath)) as ReadableStream
  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(s.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})
