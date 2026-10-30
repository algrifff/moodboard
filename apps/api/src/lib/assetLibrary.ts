import {
  mediaKindFromMime,
  type AssetMediaKind,
  type LibraryAsset,
  type LibraryQuery,
  type UpdateAssetRequest,
} from '@moodboard/shared'
import { and, desc, eq, getTableColumns, ne, sql, type SQL } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, schema } from '../db'
import { enrichAsset } from './assetEnrich'
import { buildTsQuery, thumbnailFor } from './assetSearch'

// The asset library: recording, searching and editing the metadata on every
// upload/import. File bytes still live on the volume and stream through
// /api/files; this is the catalogue over them.

export type AssetStorageKind = 'upload' | 'pdf' | 'pdf-thumb'

// The single place an asset row is written. Images are enriched straight
// away in the background; the maintenance tick covers anything this misses.
export async function recordAsset(
  userId: string | null,
  filename: string,
  mimeType: string,
  size: number,
  kind: AssetStorageKind = 'upload',
  extra: { originalName?: string | null; clientId?: string | null; tags?: string[] } = {},
): Promise<string> {
  const id = nanoid()
  const mediaKind = mediaKindFromMime(mimeType)
  await db.insert(schema.asset).values({
    id,
    createdBy: userId,
    filename,
    mimeType,
    size,
    kind,
    mediaKind,
    originalName: extra.originalName?.trim().slice(0, 200) || null,
    clientId: extra.clientId ?? null,
    ...(extra.tags && extra.tags.length > 0 ? { tags: extra.tags } : {}),
    // Nothing to extract from these; keep them out of the enrichment backlog.
    ...(mediaKind !== 'image' || kind === 'pdf-thumb' ? { enrichedAt: new Date() } : {}),
  })
  if (mediaKind === 'image' && kind === 'upload') {
    void enrichAsset(id).catch((e) => console.warn('[library] enrich failed', id, e))
  }
  return id
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const libraryColumns = {
  ...getTableColumns(schema.asset),
  clientName: schema.client.name,
  createdByName: schema.user.name,
}
type LibraryRow = Omit<typeof schema.asset.$inferSelect, 'search'> & {
  clientName: string | null
  createdByName: string | null
}

export function toLibraryAsset(row: LibraryRow): LibraryAsset {
  return {
    id: row.id,
    url: `/api/files/${row.filename}`,
    thumbnailUrl: thumbnailFor(row),
    name: row.originalName ?? row.filename,
    mimeType: row.mimeType,
    size: row.size,
    kind: row.mediaKind as AssetMediaKind,
    width: row.width,
    height: row.height,
    colors: row.colors,
    caption: row.caption,
    tags: row.tags,
    clientId: row.clientId,
    clientName: row.clientName,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
  }
}

function libraryQuery() {
  const { search: _search, ...columns } = libraryColumns
  return db
    .select(columns)
    .from(schema.asset)
    .leftJoin(schema.client, eq(schema.client.id, schema.asset.clientId))
    .leftJoin(schema.user, eq(schema.user.id, schema.asset.createdBy))
}

export async function searchAssets(
  query: Partial<LibraryQuery> & { limit: number; offset: number },
): Promise<{ assets: LibraryAsset[]; nextOffset: number | null }> {
  // A PDF's page render is bookkeeping, not an asset in its own right.
  const where: SQL[] = [ne(schema.asset.kind, 'pdf-thumb')]
  if (query.kind) where.push(eq(schema.asset.mediaKind, query.kind))
  if (query.client === 'none') where.push(sql`${schema.asset.clientId} IS NULL`)
  else if (query.client) where.push(eq(schema.asset.clientId, query.client))
  if (query.tag) where.push(sql`${query.tag.toLowerCase()} = ANY(${schema.asset.tags})`)

  const tsq = query.q ? buildTsQuery(query.q) : null
  if (tsq) where.push(sql`${schema.asset.search} @@ to_tsquery('english', ${tsq})`)

  const rows = await libraryQuery()
    .where(and(...where))
    .orderBy(
      ...(tsq ? [sql`ts_rank(${schema.asset.search}, to_tsquery('english', ${tsq})) DESC`] : []),
      desc(schema.asset.createdAt),
    )
    .limit(query.limit + 1)
    .offset(query.offset)
  const page = rows.slice(0, query.limit).map(toLibraryAsset)
  return { assets: page, nextOffset: rows.length > query.limit ? query.offset + query.limit : null }
}

export async function getLibraryAsset(id: string): Promise<LibraryAsset | null> {
  const [row] = await libraryQuery().where(eq(schema.asset.id, id)).limit(1)
  return row ? toLibraryAsset(row) : null
}

export async function getAssetRow(id: string) {
  const [row] = await db.select().from(schema.asset).where(eq(schema.asset.id, id)).limit(1)
  return row ?? null
}

export async function updateAsset(
  id: string,
  patch: UpdateAssetRequest,
): Promise<LibraryAsset | null> {
  const set: Partial<typeof schema.asset.$inferInsert> = {}
  if (patch.name !== undefined) set.originalName = patch.name
  if (patch.caption !== undefined) set.caption = patch.caption || null
  if (patch.tags !== undefined) set.tags = [...new Set(patch.tags)]
  if (patch.clientId !== undefined) set.clientId = patch.clientId
  if (Object.keys(set).length > 0) {
    const rows = await db
      .update(schema.asset)
      .set(set)
      .where(eq(schema.asset.id, id))
      .returning({ id: schema.asset.id })
    if (rows.length === 0) return null
  }
  return getLibraryAsset(id)
}
