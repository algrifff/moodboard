import type { CanvasObject } from '@moodboard/shared'
import { groupId } from '@moodboard/shared'
import { and, eq, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, schema } from '../db'

// Mirror table writer. The web client decides which agent or
// combination of agents to run for each group; this writes the
// resulting display state to a per-board row so the MCP get_board
// tool (and any future read-side consumer) can surface what the user
// actually sees, without depending on browser localStorage.
//
// Upsert key: (boardId, groupKey). A new run for the same group
// replaces the previous entry — there's only ever one "currently
// displayed" read per group.

export type DisplayKind = 'ad' | 'sectioned' | 'video' | 'brief'

export async function recordGroupDisplay(args: {
  boardId: string
  objects: CanvasObject[] // the group's members, in id order doesn't matter
  agentIds: string[]
  kind: DisplayKind
  data: unknown
}): Promise<void> {
  const groupKey = groupId(args.objects.map((o) => o.id))
  await db
    .insert(schema.boardGroupDisplay)
    .values({
      id: nanoid(),
      boardId: args.boardId,
      groupKey,
      kind: args.kind,
      data: args.data as object,
      agentIds: args.agentIds,
    })
    .onConflictDoUpdate({
      target: [schema.boardGroupDisplay.boardId, schema.boardGroupDisplay.groupKey],
      set: {
        kind: args.kind,
        data: args.data as object,
        agentIds: args.agentIds,
        updatedAt: new Date(),
      },
    })
}

// MCP get_board lookup — list every group display recorded for a
// board. Orphaned rows (group membership changed → new groupKey)
// linger here; the caller filters by intersecting against the
// board's current group set.
export async function listGroupDisplays(boardId: string) {
  return db
    .select()
    .from(schema.boardGroupDisplay)
    .where(eq(schema.boardGroupDisplay.boardId, boardId))
}

// Manual remove — exposed for future cleanup. Not called automatically
// because groups can re-form with their old key once an object is
// dragged back in.
export async function deleteGroupDisplay(boardId: string, groupKey: string) {
  await db
    .delete(schema.boardGroupDisplay)
    .where(
      and(
        eq(schema.boardGroupDisplay.boardId, boardId),
        eq(schema.boardGroupDisplay.groupKey, groupKey),
      ),
    )
}

// Hint the type checker that `sql` is intentionally imported — kept
// only because the schema file references it via the default clause
// on agent_ids. Removing the import here is a no-op.
void sql
