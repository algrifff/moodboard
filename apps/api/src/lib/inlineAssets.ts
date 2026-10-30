import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { inArray } from 'drizzle-orm'
import { db, schema } from '../db'
import { isSafeFilename, pdfPath, pdfThumbPath, uploadPath } from './storage'
import { mimeFromExt } from './upload-validation'

// Reads the files a composed document references and returns them as data:
// URIs. Only recorded assets are read (the row also says which directory a
// file lives in). Files are immutable once written — names are fresh ids —
// so a small in-memory cache is always valid.

// Bigger files are left out (the composer swaps in a blank) rather than
// bloating every render of the document.
export const MAX_INLINE_BYTES = 12 * 1024 * 1024
const CACHE_BUDGET_BYTES = 96 * 1024 * 1024

const cache = new Map<string, string>()
let cachedBytes = 0

function remember(filename: string, uri: string) {
  cache.set(filename, uri)
  cachedBytes += uri.length
  for (const [key, value] of cache) {
    if (cachedBytes <= CACHE_BUDGET_BYTES) break
    cache.delete(key)
    cachedBytes -= value.length
  }
}

export async function loadInlineAssets(filenames: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const wanted = filenames.filter(isSafeFilename)
  const misses: string[] = []
  for (const f of wanted) {
    const hit = cache.get(f)
    if (hit) {
      // Refresh recency: Map iteration order is insertion order.
      cache.delete(f)
      cache.set(f, hit)
      out.set(f, hit)
    } else misses.push(f)
  }
  if (misses.length === 0) return out

  const rows = await db
    .select({
      filename: schema.asset.filename,
      kind: schema.asset.kind,
      mimeType: schema.asset.mimeType,
    })
    .from(schema.asset)
    .where(inArray(schema.asset.filename, misses))
  await Promise.all(
    rows.map(async (row) => {
      const fullPath =
        row.kind === 'pdf'
          ? pdfPath(row.filename)
          : row.kind === 'pdf-thumb'
            ? pdfThumbPath(row.filename)
            : uploadPath(row.filename)
      try {
        const s = await stat(fullPath)
        if (!s.isFile() || s.size > MAX_INLINE_BYTES) return
        const bytes = await readFile(fullPath)
        const mime = row.mimeType || mimeFromExt(path.extname(row.filename).slice(1))
        const uri = `data:${mime};base64,${bytes.toString('base64')}`
        remember(row.filename, uri)
        out.set(row.filename, uri)
      } catch {
        // Missing on disk: the composer reports it and renders a blank.
      }
    }),
  )
  return out
}
