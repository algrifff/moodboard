import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { listKits } from './kits'

// Per-run facts for the orchestrator's system prompt: the client this board
// belongs to and its kits, so "use our kit" resolves without a lookup.
export async function boardContext(boardId: string): Promise<string> {
  const [row] = await db
    .select({ id: schema.client.id, name: schema.client.name, slug: schema.client.slug })
    .from(schema.board)
    .innerJoin(schema.client, eq(schema.client.id, schema.board.clientId))
    .where(eq(schema.board.id, boardId))
    .limit(1)
  if (!row) return 'This board is not assigned to a client.'
  const kits = await listKits({ clientId: row.id })
  const kitLine =
    kits.length === 0
      ? 'It has no style kits yet.'
      : `Its style kits: ${kits.map((k) => `“${k.name}” (v${k.latestVersion})`).join(', ')}.`
  return `This board belongs to the client ${row.name} (slug: ${row.slug}). ${kitLine}`
}
