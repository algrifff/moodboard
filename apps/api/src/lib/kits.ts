import {
  kitTokensSchema,
  kitToCss,
  type KitDetail,
  type KitSummary,
  type KitTokens,
  type KitVersionMeta,
} from '@moodboard/shared'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, schema } from '../db'

// Style kits: a named kit per client, edited by appending immutable
// versions. The kit row only points at its latest number; every version row
// is the full token document.

const kitSelect = {
  id: schema.styleKit.id,
  name: schema.styleKit.name,
  clientId: schema.styleKit.clientId,
  clientName: schema.client.name,
  clientSlug: schema.client.slug,
  latestVersion: schema.styleKit.latestVersion,
  updatedAt: schema.styleKit.updatedAt,
  tokens: schema.styleKitVersion.tokens,
}

type KitRow = {
  id: string
  name: string
  clientId: string
  clientName: string
  clientSlug: string
  latestVersion: number
  updatedAt: Date
  tokens: unknown
}

function parseTokens(raw: unknown): KitTokens {
  const parsed = kitTokensSchema.safeParse(raw)
  // A version written by a newer build shouldn't take the list down.
  return parsed.success ? parsed.data : kitTokensSchema.parse({})
}

function toSummary(row: KitRow): KitSummary {
  const tokens = parseTokens(row.tokens)
  return {
    id: row.id,
    name: row.name,
    clientId: row.clientId,
    clientName: row.clientName,
    clientSlug: row.clientSlug,
    latestVersion: row.latestVersion,
    updatedAt: row.updatedAt.toISOString(),
    preview: {
      palette: tokens.palette.slice(0, 6).map((p) => p.hex),
      display: tokens.fonts.display?.family ?? null,
      body: tokens.fonts.body?.family ?? null,
    },
  }
}

function kitsQuery() {
  return db
    .select(kitSelect)
    .from(schema.styleKit)
    .innerJoin(schema.client, eq(schema.client.id, schema.styleKit.clientId))
    .innerJoin(
      schema.styleKitVersion,
      and(
        eq(schema.styleKitVersion.kitId, schema.styleKit.id),
        eq(schema.styleKitVersion.version, schema.styleKit.latestVersion),
      ),
    )
}

export async function listKits(filter: { clientId?: string } = {}): Promise<KitSummary[]> {
  const rows = await kitsQuery()
    .where(filter.clientId ? eq(schema.styleKit.clientId, filter.clientId) : undefined)
    .orderBy(asc(sql`lower(${schema.client.name})`), asc(sql`lower(${schema.styleKit.name})`))
  return rows.map(toSummary)
}

export async function getKitSummary(id: string): Promise<KitSummary | null> {
  const [row] = await kitsQuery().where(eq(schema.styleKit.id, id)).limit(1)
  return row ? toSummary(row) : null
}

async function versionMetas(kitId: string): Promise<KitVersionMeta[]> {
  const rows = await db
    .select({
      version: schema.styleKitVersion.version,
      note: schema.styleKitVersion.note,
      createdAt: schema.styleKitVersion.createdAt,
      createdByName: schema.user.name,
    })
    .from(schema.styleKitVersion)
    .leftJoin(schema.user, eq(schema.user.id, schema.styleKitVersion.createdBy))
    .where(eq(schema.styleKitVersion.kitId, kitId))
    .orderBy(desc(schema.styleKitVersion.version))
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
}

export async function getKitDetail(id: string, version?: number): Promise<KitDetail | null> {
  const kit = await getKitSummary(id)
  if (!kit) return null
  const versions = await versionMetas(id)
  const wanted = version ?? kit.latestVersion
  const meta = versions.find((v) => v.version === wanted)
  if (!meta) return null
  const [row] = await db
    .select({ tokens: schema.styleKitVersion.tokens })
    .from(schema.styleKitVersion)
    .where(and(eq(schema.styleKitVersion.kitId, id), eq(schema.styleKitVersion.version, wanted)))
    .limit(1)
  return { kit, version: { ...meta, tokens: parseTokens(row?.tokens) }, versions }
}

export async function createKit(args: {
  clientId: string
  name: string
  tokens: KitTokens
  note?: string
  userId: string
}): Promise<KitSummary> {
  const id = nanoid()
  await db.transaction(async (tx) => {
    await tx.insert(schema.styleKit).values({
      id,
      clientId: args.clientId,
      name: args.name,
      latestVersion: 1,
      createdBy: args.userId,
    })
    await tx.insert(schema.styleKitVersion).values({
      id: nanoid(),
      kitId: id,
      version: 1,
      tokens: args.tokens,
      note: args.note ?? '',
      createdBy: args.userId,
    })
  })
  return (await getKitSummary(id))!
}

export type AddVersionResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'stale'; latest: number }

// Bumping latest_version under the row lock serialises concurrent saves, so
// two people never write the same number. A stale `baseVersion` is refused
// rather than quietly stacked on top of a teammate's edit.
export async function addKitVersion(args: {
  kitId: string
  tokens: KitTokens
  note?: string
  baseVersion?: number
  userId: string
}): Promise<AddVersionResult> {
  return db.transaction(async (tx) => {
    const [kit] = await tx
      .select({ latest: schema.styleKit.latestVersion })
      .from(schema.styleKit)
      .where(eq(schema.styleKit.id, args.kitId))
      .for('update')
    if (!kit) return { ok: false, reason: 'not-found' } as const
    if (args.baseVersion !== undefined && args.baseVersion !== kit.latest) {
      return { ok: false, reason: 'stale', latest: kit.latest } as const
    }
    const version = kit.latest + 1
    await tx.insert(schema.styleKitVersion).values({
      id: nanoid(),
      kitId: args.kitId,
      version,
      tokens: args.tokens,
      note: args.note ?? '',
      createdBy: args.userId,
    })
    await tx
      .update(schema.styleKit)
      .set({ latestVersion: version, updatedAt: new Date() })
      .where(eq(schema.styleKit.id, args.kitId))
    return { ok: true, version } as const
  })
}

export async function updateKit(
  id: string,
  patch: { name?: string; clientId?: string },
): Promise<KitSummary | null> {
  const rows = await db
    .update(schema.styleKit)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.styleKit.id, id))
    .returning({ id: schema.styleKit.id })
  return rows.length > 0 ? getKitSummary(id) : null
}

export async function deleteKit(id: string): Promise<boolean> {
  const rows = await db
    .delete(schema.styleKit)
    .where(eq(schema.styleKit.id, id))
    .returning({ id: schema.styleKit.id })
  return rows.length > 0
}

export async function getKitCss(id: string, version?: number): Promise<string | null> {
  const detail = await getKitDetail(id, version)
  return detail ? kitToCss(detail.version.tokens) : null
}
