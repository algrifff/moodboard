import type { NotionPageData } from '@moodboard/shared'
import { and, desc, eq, lt } from 'drizzle-orm'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { decryptToken } from '../lib/cryptoTokens'
import { blocksToMarkdown, getPage, getPageBlocks } from '../lib/notion'
import { rateLimit } from '../lib/rateLimit'
import { loadConnection } from './connections'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const external = new Hono<{ Variables: Variables }>()

// Import + refresh both hit upstream provider APIs and run the
// blocks-to-markdown converter. 20/min/user gives generous headroom for
// adding a handful of pages at once without hitting Notion's own rate cap.
const externalImportLimit = rateLimit({ scope: 'external-import', limit: 20, windowMs: 60_000 })

// Cap of recent items kept per user. Older rows pruned on insert.
const RECENT_PER_USER_CAP = 20

external.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

// ---------------------------------------------------------------------------
// POST /api/external/notion/import
//
// Fetch a page, convert its block tree to markdown, persist a recent_external
// row, and return the wire shape the canvas will mount as a NotionPageNode.
// The frontend takes this object and calls addObject() — the connectionId on
// the data is what powers the refresh endpoint later.
// ---------------------------------------------------------------------------
external.post('/notion/import', externalImportLimit, async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => ({}))) as {
    connectionId?: unknown
    pageId?: unknown
  }
  const connectionId = typeof body.connectionId === 'string' ? body.connectionId : null
  const pageId = typeof body.pageId === 'string' ? body.pageId : null
  if (!connectionId || !pageId) {
    return c.json({ error: 'connectionId and pageId are required' }, 400)
  }

  const connectionRow = await loadConnection(user.id, connectionId)
  if (!connectionRow || connectionRow.provider !== 'notion') {
    return c.json({ error: 'Connection not found' }, 404)
  }

  try {
    const data = await importNotionPage({ userId: user.id, connectionRow, pageId })
    return c.json({ data })
  } catch (e) {
    if (e instanceof TokenDecryptError) {
      return c.json({ error: 'Connection unavailable' }, 503)
    }
    throw e
  }
})

// ---------------------------------------------------------------------------
// POST /api/external/refresh
//
// Pull a fresh snapshot for an existing canvas object. The client passes the
// object's id + the board id; we look the object up in the stored board
// data, grab its provider + externalId + connectionId, and re-import. We
// don't mutate the board state on the server — that's the client's job via
// the existing autosave on canvas store mutation, which keeps refresh as a
// pure read.
// ---------------------------------------------------------------------------
external.post('/refresh', externalImportLimit, async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => ({}))) as {
    boardId?: unknown
    objectId?: unknown
  }
  const boardId = typeof body.boardId === 'string' ? body.boardId : null
  const objectId = typeof body.objectId === 'string' ? body.objectId : null
  if (!boardId || !objectId) {
    return c.json({ error: 'boardId and objectId are required' }, 400)
  }

  const [boardRow] = await db
    .select({ data: schema.board.data })
    .from(schema.board)
    .where(and(eq(schema.board.id, boardId), eq(schema.board.userId, user.id)))
    .limit(1)
  if (!boardRow) return c.json({ error: 'Board not found' }, 404)

  const object = findObject(boardRow.data, objectId)
  if (!object) return c.json({ error: 'Object not found on board' }, 404)

  if (object.type === 'notion-page') {
    const d = object.data as Partial<NotionPageData>
    if (!d.connectionId || !d.pageId) {
      return c.json({ error: 'Object has no connection metadata' }, 400)
    }
    const connectionRow = await loadConnection(user.id, d.connectionId)
    if (!connectionRow || connectionRow.provider !== 'notion') {
      return c.json({ error: 'Connection no longer available' }, 409)
    }
    try {
      const data = await importNotionPage({
        userId: user.id,
        connectionRow,
        pageId: d.pageId,
      })
      return c.json({ data })
    } catch (e) {
      if (e instanceof TokenDecryptError) {
        return c.json({ error: 'Connection unavailable' }, 503)
      }
      throw e
    }
  }

  return c.json({ error: 'Unsupported object type for refresh' }, 400)
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Thrown when a connection's stored token can't be decrypted (key rotated,
// row corrupted). The handler turns this into a 503 so the client can show
// a "connection no longer available" message rather than a 500.
class TokenDecryptError extends Error {
  constructor() {
    super('TokenDecryptError')
    this.name = 'TokenDecryptError'
  }
}

async function importNotionPage(args: {
  userId: string
  connectionRow: { id: string; accessTokenEnc: string; workspaceId: string | null }
  pageId: string
}): Promise<NotionPageData> {
  let token: string
  try {
    token = decryptToken(args.connectionRow.accessTokenEnc)
  } catch {
    throw new TokenDecryptError()
  }
  const [page, blocks] = await Promise.all([
    getPage({ token, pageId: args.pageId }),
    getPageBlocks({ token, pageId: args.pageId }),
  ])
  const markdown = blocksToMarkdown(blocks)
  const fetchedAt = new Date().toISOString()

  await db
    .update(schema.connection)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.connection.id, args.connectionRow.id))

  await upsertRecent({
    userId: args.userId,
    connectionId: args.connectionRow.id,
    externalId: args.pageId,
    kind: 'page',
    title: page.title,
    iconUrl: page.iconUrl,
  })

  const data: NotionPageData = {
    connectionId: args.connectionRow.id,
    pageId: page.id,
    workspaceId: args.connectionRow.workspaceId ?? '',
    title: page.title,
    url: page.url,
    markdown,
    fetchedAt,
  }
  if (page.iconEmoji) data.iconEmoji = page.iconEmoji
  if (page.iconUrl) data.iconUrl = page.iconUrl
  if (page.coverUrl) data.coverUrl = page.coverUrl
  if (page.lastEditedTime) data.lastEditedAt = page.lastEditedTime
  return data
}

// Maintain a per-user / per-connection recents row. Updates lastUsedAt if a
// row for the same external resource already exists, inserts otherwise.
// After insert, prunes the user's recents back to RECENT_PER_USER_CAP newest.
async function upsertRecent(args: {
  userId: string
  connectionId: string
  externalId: string
  kind: 'page' | 'file' | 'folder'
  title: string
  iconUrl?: string
}) {
  const existing = await db
    .select({ id: schema.recentExternal.id })
    .from(schema.recentExternal)
    .where(
      and(
        eq(schema.recentExternal.userId, args.userId),
        eq(schema.recentExternal.connectionId, args.connectionId),
        eq(schema.recentExternal.externalId, args.externalId),
      ),
    )
    .limit(1)

  if (existing[0]) {
    await db
      .update(schema.recentExternal)
      .set({ lastUsedAt: new Date(), title: args.title, iconUrl: args.iconUrl ?? null })
      .where(eq(schema.recentExternal.id, existing[0].id))
  } else {
    await db.insert(schema.recentExternal).values({
      id: nanoid(),
      userId: args.userId,
      connectionId: args.connectionId,
      externalId: args.externalId,
      kind: args.kind,
      title: args.title,
      iconUrl: args.iconUrl ?? null,
    })
  }

  // Prune. Order by lastUsedAt desc, find the cap-th newest, delete anything
  // older than its lastUsedAt for this user. Two-step because Drizzle's
  // delete doesn't take a correlated subquery directly. Best-effort —
  // failing a prune shouldn't fail the import.
  const newest = await db
    .select({ lastUsedAt: schema.recentExternal.lastUsedAt })
    .from(schema.recentExternal)
    .where(eq(schema.recentExternal.userId, args.userId))
    .orderBy(desc(schema.recentExternal.lastUsedAt))
    .limit(RECENT_PER_USER_CAP)
  if (newest.length === RECENT_PER_USER_CAP) {
    const cutoff = newest[RECENT_PER_USER_CAP - 1]!.lastUsedAt
    await db
      .delete(schema.recentExternal)
      .where(
        and(
          eq(schema.recentExternal.userId, args.userId),
          lt(schema.recentExternal.lastUsedAt, cutoff),
        ),
      )
      .catch(() => {
        // Swallow — older rows can be pruned next time.
      })
  }
}

// Walk a stored board.data jsonb for the object with matching id. Loose
// typing — the stored shape is opaque to the API and we only need a couple
// of fields to dispatch on.
function findObject(
  data: unknown,
  objectId: string,
): { type: string; data: Record<string, unknown> } | null {
  if (!data || typeof data !== 'object') return null
  const objects = (data as { objects?: unknown[] }).objects
  if (!Array.isArray(objects)) return null
  for (const o of objects) {
    if (!o || typeof o !== 'object') continue
    const obj = o as { id?: unknown; type?: unknown; data?: unknown }
    if (
      obj.id === objectId &&
      typeof obj.type === 'string' &&
      obj.data &&
      typeof obj.data === 'object'
    ) {
      return { type: obj.type, data: obj.data as Record<string, unknown> }
    }
  }
  return null
}
