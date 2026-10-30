import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

// Streams a file from the volume, with byte-range support — a <video>
// element can't seek (or start quickly) without it.

export type ByteRange = { start: number; end: number }

// `bytes=a-b`, `bytes=a-`, `bytes=-n`. Null means "send it all"; 'invalid'
// means unsatisfiable (416). Multi-range requests get the whole file.
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, first, last] = m
  if (first === '' && last === '') return null
  if (first === '') {
    const n = Number(last)
    if (n === 0) return 'invalid'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(first)
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (start >= size || start > end) return 'invalid'
  return { start, end }
}

export async function serveFile(
  filePath: string,
  opts: {
    contentType: string
    rangeHeader?: string
    headers?: Record<string, string>
  },
): Promise<Response | null> {
  const info = await stat(filePath).catch(() => null)
  if (!info?.isFile()) return null
  const headers: Record<string, string> = {
    'Content-Type': opts.contentType,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    ...opts.headers,
  }
  const range = parseRange(opts.rangeHeader, info.size)
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
  }
  const body = (r?: ByteRange) =>
    Readable.toWeb(createReadStream(filePath, r)) as unknown as ReadableStream
  if (!range) {
    return new Response(body(), {
      status: 200,
      headers: { ...headers, 'Content-Length': String(info.size) },
    })
  }
  return new Response(body(range), {
    status: 206,
    headers: {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
      'Content-Length': String(range.end - range.start + 1),
    },
  })
}
