import { createReadStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  collectAssetFilenames,
  createShareRequestSchema,
  type ShareResponse,
  type ShareView,
} from '@moodboard/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { nanoid } from 'nanoid'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { renderSharePdf } from '../lib/pdfRender'
import { rateLimit } from '../lib/rateLimit'
import { externalPath, isSafeFilename, pdfPath, pdfThumbPath, uploadPath } from '../lib/storage'
import { mimeFromExt } from '../lib/upload-validation'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const shares = new Hono<{ Variables: Variables }>()

const TOKEN_LENGTH = 32

// Limits — protect against snapshot-storm + PDF-render flooding.
const snapshotBodyLimit = bodyLimit({
  // Snapshots can be large — many images, long briefs. Still bounded
  // so a hostile client can't fill jsonb. ~4MB is generous; a board
  // with 100 images + briefs serialises to ~200KB in practice.
  maxSize: 4 * 1024 * 1024,
  onError: (c) => c.json({ error: 'Snapshot too large' }, 413),
})
const shareCreateRateLimit = rateLimit({ scope: 'share-create', limit: 30, windowMs: 60_000 })
const sharePdfRateLimit = rateLimit({ scope: 'share-pdf', limit: 20, windowMs: 60_000 })
const shareViewRateLimit = rateLimit({ scope: 'share-view', limit: 240, windowMs: 60_000 })
// Public file streams are higher-volume — a single viewer page can pull
// 30+ images in parallel.
const shareFileRateLimit = rateLimit({ scope: 'share-file', limit: 600, windowMs: 60_000 })

type ShareRow = typeof schema.share.$inferSelect

function toShareView(row: ShareRow): ShareView {
  return {
    token: row.token,
    boardName: row.name,
    snapshot: row.snapshot as ShareView['snapshot'],
    capturedAt: row.capturedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Owner endpoints — POST + DELETE, mounted under /api/boards/:boardId/share
// ---------------------------------------------------------------------------

export const boardShare = new Hono<{ Variables: Variables }>()

boardShare.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

// Create-or-update. Token stays stable across updates so existing
// recipients keep their URL. `assetFilenames` is recomputed server-side
// from the incoming snapshot — never trusted from the client — and
// every name is checked against the owner's `asset` table to ensure
// they aren't pointing the share at files they don't own.
boardShare.post('/', shareCreateRateLimit, snapshotBodyLimit, async (c) => {
  const user = c.get('user')!
  const boardId = c.req.param('boardId') as string

  // Ownership check on the board before we accept a snapshot for it.
  const [boardRow] = await db
    .select({ id: schema.board.id, name: schema.board.name })
    .from(schema.board)
    .where(and(eq(schema.board.id, boardId), eq(schema.board.userId, user.id)))
    .limit(1)
  if (!boardRow) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json().catch(() => null)
  const parsed = createShareRequestSchema.safeParse(body)
  if (!parsed.success) {
    console.error('share create: snapshot validation failed', {
      boardId,
      issues: parsed.error.issues,
    })
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  }
  const { snapshot } = parsed.data

  const assetFilenames = collectAssetFilenames(snapshot)
  if (assetFilenames.length > 0) {
    // Every referenced filename must belong to this user. Otherwise an
    // attacker who controls a victim's board could mint a share that
    // exposes the victim's other files — even though they'd already
    // have access to the originals through the editor, the share URL
    // makes them public.
    const owned = await db
      .select({ filename: schema.asset.filename })
      .from(schema.asset)
      .where(eq(schema.asset.userId, user.id))
    const ownedSet = new Set(owned.map((r) => r.filename))
    for (const f of assetFilenames) {
      if (!ownedSet.has(f)) {
        return c.json({ error: `Unknown asset: ${f}` }, 400)
      }
    }
  }

  const now = new Date()
  const [existing] = await db
    .select()
    .from(schema.share)
    .where(and(eq(schema.share.boardId, boardId), eq(schema.share.userId, user.id)))
    .limit(1)

  let row: ShareRow
  if (existing) {
    // Updating an existing share invalidates the cached PDF. Delete
    // the file too so the volume doesn't accumulate orphans.
    if (existing.pdfFilename) {
      try {
        await unlink(pdfPath(existing.pdfFilename))
      } catch {
        // already gone — fine
      }
    }
    const [updated] = await db
      .update(schema.share)
      .set({
        name: boardRow.name,
        snapshot,
        assetFilenames,
        pdfFilename: null,
        pdfGeneratedAt: null,
        capturedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.share.token, existing.token))
      .returning()
    if (!updated) return c.json({ error: 'Update failed' }, 500)
    row = updated
  } else {
    const [inserted] = await db
      .insert(schema.share)
      .values({
        token: nanoid(TOKEN_LENGTH),
        boardId,
        userId: user.id,
        name: boardRow.name,
        snapshot,
        assetFilenames,
        capturedAt: now,
        updatedAt: now,
      })
      .returning()
    if (!inserted) return c.json({ error: 'Insert failed' }, 500)
    row = inserted
  }

  const response: ShareResponse = { share: toShareView(row) }
  return c.json(response)
})

boardShare.delete('/', async (c) => {
  const user = c.get('user')!
  const boardId = c.req.param('boardId') as string
  const [existing] = await db
    .select({ token: schema.share.token, pdfFilename: schema.share.pdfFilename })
    .from(schema.share)
    .where(and(eq(schema.share.boardId, boardId), eq(schema.share.userId, user.id)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.pdfFilename) {
    try {
      await unlink(pdfPath(existing.pdfFilename))
    } catch {
      // already gone — fine
    }
  }
  await db.delete(schema.share).where(eq(schema.share.token, existing.token))
  return c.json({ ok: true })
})

// Lets the owner peek at the current share without minting a new one —
// powers the ShareDialog's "open with existing share" state.
boardShare.get('/', async (c) => {
  const user = c.get('user')!
  const boardId = c.req.param('boardId') as string
  const [row] = await db
    .select()
    .from(schema.share)
    .where(and(eq(schema.share.boardId, boardId), eq(schema.share.userId, user.id)))
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const response: ShareResponse = { share: toShareView(row) }
  return c.json(response)
})

// ---------------------------------------------------------------------------
// Public endpoints — mounted at /api/shares
// ---------------------------------------------------------------------------

// Look up a share by token — public. Snapshot blob + metadata, no
// owner-side fields (assetFilenames, pdfFilename) leak out.
shares.get('/:token', shareViewRateLimit, async (c) => {
  const token = c.req.param('token') as string
  const [row] = await db.select().from(schema.share).where(eq(schema.share.token, token)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const response: ShareResponse = { share: toShareView(row) }
  return c.json(response)
})

// Stream an asset gated by the share's allowlist. Same on-disk routing
// rules as the auth'd files route — we just substitute the
// share.assetFilenames check for the user-ownership check.
shares.get('/:token/files/:filename', shareFileRateLimit, async (c) => {
  const token = c.req.param('token') as string
  const filename = c.req.param('filename') as string
  if (!isSafeFilename(filename)) {
    return c.json({ error: 'Bad filename' }, 400)
  }
  const [shareRow] = await db
    .select({ assetFilenames: schema.share.assetFilenames })
    .from(schema.share)
    .where(eq(schema.share.token, token))
    .limit(1)
  if (!shareRow) return c.json({ error: 'Not found' }, 404)
  if (!shareRow.assetFilenames.includes(filename)) {
    return c.json({ error: 'Not found' }, 404)
  }
  // Look up the asset row to find its on-disk kind (uploads / pdfs /
  // pdf-thumbs / external-*). Doesn't enforce ownership — that was
  // baked in at share creation when assetFilenames was set.
  const [assetRow] = await db
    .select()
    .from(schema.asset)
    .where(eq(schema.asset.filename, filename))
    .limit(1)
  if (!assetRow) return c.json({ error: 'Not found' }, 404)

  const fullPath =
    assetRow.kind === 'pdf'
      ? pdfPath(filename)
      : assetRow.kind === 'pdf-thumb'
        ? pdfThumbPath(filename)
        : assetRow.kind === 'external-notion'
          ? externalPath('notion', filename)
          : assetRow.kind === 'external-drive'
            ? externalPath('drive', filename)
            : uploadPath(filename)

  let s
  try {
    s = await stat(fullPath)
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
  if (!s.isFile()) return c.json({ error: 'Not found' }, 404)

  const ext = path.extname(filename).slice(1)
  const mimeType = assetRow.mimeType || mimeFromExt(ext)
  const webStream = Readable.toWeb(createReadStream(fullPath)) as ReadableStream
  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(s.size),
      // Public; freeze is permanent for the lifetime of this share, so
      // long max-age is safe. If the owner re-snapshots the asset set,
      // the URL stays the same and asset content doesn't change either.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

// Cached PDF download. Generates on first request after a snapshot
// change, then serves the cached file until the next `Update snapshot`
// nulls `pdfFilename`.
shares.get('/:token/pdf', sharePdfRateLimit, async (c) => {
  const token = c.req.param('token') as string
  const [shareRow] = await db
    .select()
    .from(schema.share)
    .where(eq(schema.share.token, token))
    .limit(1)
  if (!shareRow) return c.json({ error: 'Not found' }, 404)

  let pdfFilename = shareRow.pdfFilename
  if (!pdfFilename) {
    // First request after creation or an update.
    const baseUrl = process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'
    let buffer: Buffer
    try {
      buffer = await renderSharePdf(token, baseUrl)
    } catch (e) {
      console.error('PDF render failed', { token, error: e })
      const msg = e instanceof Error ? e.message : String(e)
      return c.json({ error: `PDF render failed: ${msg}` }, 502)
    }
    pdfFilename = `share-${token}.pdf`
    const { writeFile } = await import('node:fs/promises')
    await writeFile(pdfPath(pdfFilename), buffer)
    const now = new Date()
    await db
      .update(schema.share)
      .set({ pdfFilename, pdfGeneratedAt: now })
      .where(eq(schema.share.token, token))
  }

  const fullPath = pdfPath(pdfFilename)
  let s
  try {
    s = await stat(fullPath)
  } catch {
    // File on volume vanished — clear the cached pointer and tell the
    // client to retry. The next call will regenerate.
    await db
      .update(schema.share)
      .set({ pdfFilename: null, pdfGeneratedAt: null })
      .where(eq(schema.share.token, token))
    return c.json({ error: 'PDF unavailable — retry' }, 503)
  }

  const safeName = shareRow.name.replace(/[^a-zA-Z0-9 _.-]/g, '').slice(0, 80) || 'moodboard'
  const webStream = Readable.toWeb(createReadStream(fullPath)) as ReadableStream
  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(s.size),
      'Content-Disposition': `attachment; filename="${safeName}.pdf"`,
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})
