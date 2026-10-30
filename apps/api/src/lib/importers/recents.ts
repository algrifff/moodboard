import { and, desc, eq, lt } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, schema } from '../../db'

// Cap of recent items kept per user. Older rows pruned on insert.
const RECENT_PER_USER_CAP = 20

// Maintain a per-user / per-connection recents row. Updates lastUsedAt if a
// row for the same external resource already exists, inserts otherwise.
// After insert, prunes the user's recents back to RECENT_PER_USER_CAP newest.
export async function upsertRecent(args: {
  userId: string
  connectionId: string
  externalId: string
  kind: 'page' | 'file' | 'folder'
  title: string
  iconUrl?: string
  mimeType?: string
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
      .set({
        lastUsedAt: new Date(),
        title: args.title,
        iconUrl: args.iconUrl ?? null,
        mimeType: args.mimeType ?? null,
      })
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
      mimeType: args.mimeType ?? null,
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
