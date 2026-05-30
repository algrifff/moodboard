// One-shot data cleanup.
//
// Background: prior to the asset-row fix in lib/web.ts, the web-page
// importer saved logo image files to /data/uploads/ via saveUpload() but
// skipped the corresponding `INSERT INTO asset`. Those files exist on
// disk but GET /api/files/:filename rejects them with 404 because the
// handler's ownership check (route at apps/api/src/routes/files.ts:316)
// requires a matching asset row. The board still references the dead
// URLs in its `data` JSONB → every page load fires a 404, which the
// browser logs.
//
// This script walks every board's `data.objects[]`, finds any
// `image` / `pdf` / `notion-page` / `drive-file` / `drive-folder` /
// `web-page` object whose data.url (or data.thumbnailUrl, etc.) points
// at an `/api/files/<filename>` path that has no matching row in the
// asset table for that board's user. It removes the offending canvas
// objects from the array and writes the board back.
//
// Idempotent: re-running on an already-clean board is a no-op (it
// computes the same filter, finds nothing to drop).
//
// Usage:
//   pnpm --filter @moodboard/api tsx --env-file=.env src/scripts/cleanOrphanRefs.ts
//
// or with --dry-run to preview without writing:
//   pnpm --filter @moodboard/api tsx --env-file=.env src/scripts/cleanOrphanRefs.ts --dry-run

import { and, eq } from 'drizzle-orm'
import { db, pgClient, schema } from '../db'

type CanvasObjectLike = {
  id: string
  type: string
  data?: Record<string, unknown>
}

type BoardDataLike = {
  objects?: CanvasObjectLike[]
  groups?: unknown[]
  [k: string]: unknown
}

// Extract every `/api/files/<filename>` reference an object carries.
// Different types stash URLs in different fields; we look at all the
// shapes the canvas types use.
function urlsFromObject(o: CanvasObjectLike): string[] {
  const out: string[] = []
  const d = o.data ?? {}
  const probe = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('/api/files/')) out.push(v)
  }
  probe(d.url)
  probe(d.thumbnailUrl)
  // Web-page logos themselves are spawned as independent `image` objects,
  // so their URLs land via the `url` probe above. Notion icon/cover and
  // Drive thumbnails are stable external CDN URLs and don't go through
  // /api/files/, so no special-casing needed.
  return out
}

function filenameFromApiFilesUrl(url: string): string | null {
  const m = url.match(/^\/api\/files\/([^/?#]+)/)
  return m?.[1] ?? null
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  console.log(dryRun ? '[dry-run] no writes' : '[live] will update boards')

  const boards = await db
    .select({ id: schema.board.id, userId: schema.board.userId, data: schema.board.data })
    .from(schema.board)

  console.log(`Scanning ${boards.length} board(s)…`)

  let totalRemoved = 0
  let boardsTouched = 0

  for (const row of boards) {
    const data = (row.data ?? {}) as BoardDataLike
    if (!Array.isArray(data.objects) || data.objects.length === 0) continue

    // Build the set of `/api/files/<filename>` paths referenced by this
    // board's objects, then do a single DB lookup to find which of those
    // filenames have an asset row owned by this user. Anything missing
    // from the resulting set is orphaned.
    const allUrls = new Set<string>()
    for (const o of data.objects) {
      for (const u of urlsFromObject(o)) allUrls.add(u)
    }
    if (allUrls.size === 0) continue

    const filenames = [...allUrls]
      .map(filenameFromApiFilesUrl)
      .filter((f): f is string => !!f)
    if (filenames.length === 0) continue

    const rows = await db
      .select({ filename: schema.asset.filename })
      .from(schema.asset)
      .where(and(eq(schema.asset.userId, row.userId)))
    const known = new Set(rows.map((r) => r.filename))

    const orphanFilenames = new Set(filenames.filter((f) => !known.has(f)))
    if (orphanFilenames.size === 0) continue

    // Filter the objects array. An object is orphaned if EVERY one of its
    // /api/files/ urls is missing — partially-orphaned objects (e.g. a
    // PDF with valid url but missing thumbnail) keep their slot; the
    // existing render paths already tolerate missing thumbnails.
    const survivors: CanvasObjectLike[] = []
    const removed: { id: string; type: string; urls: string[] }[] = []
    for (const o of data.objects) {
      const urls = urlsFromObject(o)
      if (urls.length === 0) {
        survivors.push(o)
        continue
      }
      const allOrphan = urls.every((u) => {
        const fn = filenameFromApiFilesUrl(u)
        return fn !== null && orphanFilenames.has(fn)
      })
      if (allOrphan) {
        removed.push({ id: o.id, type: o.type, urls })
      } else {
        survivors.push(o)
      }
    }

    if (removed.length === 0) continue

    console.log(`\nboard ${row.id} (user ${row.userId}): removing ${removed.length} orphan object(s)`)
    for (const r of removed) {
      console.log(`  - ${r.type} ${r.id} → ${r.urls.join(', ')}`)
    }
    totalRemoved += removed.length
    boardsTouched += 1

    if (!dryRun) {
      const nextData: BoardDataLike = { ...data, objects: survivors }
      await db
        .update(schema.board)
        .set({ data: nextData, updatedAt: new Date() })
        .where(eq(schema.board.id, row.id))
    }
  }

  console.log(
    `\nDone. ${totalRemoved} orphan(s) across ${boardsTouched} board(s).${
      dryRun ? ' (no writes — re-run without --dry-run to apply)' : ''
    }`,
  )
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await pgClient.end({ timeout: 5 })
  })
