import { slugify, type Client } from '@moodboard/shared'
import { asc, count, eq, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, schema } from '../db'

type ClientRow = typeof schema.client.$inferSelect

function toClient(row: ClientRow, boardCount: number, kitCount: number): Client {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    boardCount,
    kitCount,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listClients(): Promise<Client[]> {
  const rows = await db
    .select({
      client: schema.client,
      boardCount: sql<number>`(SELECT count(*)::int FROM board WHERE board.client_id = ${schema.client.id})`,
      kitCount: sql<number>`(SELECT count(*)::int FROM style_kit WHERE style_kit.client_id = ${schema.client.id})`,
    })
    .from(schema.client)
    .orderBy(asc(sql`lower(${schema.client.name})`))
  return rows.map((r) => toClient(r.client, r.boardCount, r.kitCount))
}

export async function getClient(id: string): Promise<Client | null> {
  const [row] = await db.select().from(schema.client).where(eq(schema.client.id, id)).limit(1)
  if (!row) return null
  const [boards] = await db
    .select({ n: count() })
    .from(schema.board)
    .where(eq(schema.board.clientId, id))
  const [kits] = await db
    .select({ n: count() })
    .from(schema.styleKit)
    .where(eq(schema.styleKit.clientId, id))
  return toClient(row, boards?.n ?? 0, kits?.n ?? 0)
}

export async function clientExists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.client.id })
    .from(schema.client)
    .where(eq(schema.client.id, id))
    .limit(1)
  return Boolean(row)
}

// `acme`, then `acme-2`, `acme-3`… The unique index is the real guard; the
// retry covers two people creating the same name at once.
export async function createClient(name: string, userId: string): Promise<Client> {
  const base = slugify(name)
  for (let attempt = 0; attempt < 20; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`
    const id = nanoid()
    const rows = await db
      .insert(schema.client)
      .values({ id, name, slug, createdBy: userId })
      .onConflictDoNothing({ target: schema.client.slug })
      .returning({ id: schema.client.id })
    if (rows.length > 0) return (await getClient(id))!
  }
  throw new Error('Could not find a free slug for that client name')
}

export async function renameClient(id: string, name: string): Promise<Client | null> {
  const rows = await db
    .update(schema.client)
    .set({ name, updatedAt: new Date() })
    .where(eq(schema.client.id, id))
    .returning({ id: schema.client.id })
  return rows.length > 0 ? getClient(id) : null
}

export async function deleteClient(id: string): Promise<boolean> {
  const rows = await db
    .delete(schema.client)
    .where(eq(schema.client.id, id))
    .returning({ id: schema.client.id })
  return rows.length > 0
}
