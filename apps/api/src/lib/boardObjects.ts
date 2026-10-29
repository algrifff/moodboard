import type {
  CanvasObject,
  SaveBoardObjectsRequest,
  SaveBoardObjectsResponse,
} from '@moodboard/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '../db'

type Executor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>

export type VersionedObject = { object: CanvasObject; version: number }

// Stacking order: zIndex first, then creation order (the backfill offsets
// created_at by array position, and new objects append).
export async function loadBoardObjects(
  boardId: string,
  executor: Executor = db,
): Promise<VersionedObject[]> {
  const rows = await executor
    .select({ object: schema.boardObject.object, version: schema.boardObject.version })
    .from(schema.boardObject)
    .where(eq(schema.boardObject.boardId, boardId))
    .orderBy(
      sql`(${schema.boardObject.object}->>'zIndex')::float8 NULLS FIRST`,
      asc(schema.boardObject.createdAt),
      asc(schema.boardObject.id),
    )
  return rows.map((r) => ({ object: r.object as CanvasObject, version: r.version }))
}

export async function loadObjectsByBoard(boardIds: string[]): Promise<Map<string, CanvasObject[]>> {
  const out = new Map<string, CanvasObject[]>()
  if (boardIds.length === 0) return out
  const rows = await db
    .select({ boardId: schema.boardObject.boardId, object: schema.boardObject.object })
    .from(schema.boardObject)
    .where(inArray(schema.boardObject.boardId, boardIds))
    .orderBy(asc(schema.boardObject.createdAt))
  for (const r of rows) {
    const list = out.get(r.boardId) ?? []
    list.push(r.object as CanvasObject)
    out.set(r.boardId, list)
  }
  return out
}

export async function loadBoardObject(
  boardId: string,
  objectId: string,
  executor: Executor = db,
): Promise<VersionedObject | null> {
  const [row] = await executor
    .select({ object: schema.boardObject.object, version: schema.boardObject.version })
    .from(schema.boardObject)
    .where(and(eq(schema.boardObject.boardId, boardId), eq(schema.boardObject.id, objectId)))
    .limit(1)
  return row ? { object: row.object as CanvasObject, version: row.version } : null
}

// Server-side append (MCP tools). A fresh id can't collide, so no version
// check is needed — and unlike the old blob rewrite, it can't clobber a
// concurrent editor's changes to other objects.
export async function insertBoardObject(
  boardId: string,
  object: CanvasObject,
  userId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(schema.boardObject).values({
      boardId,
      id: object.id,
      type: object.type,
      object,
      updatedBy: userId,
    })
    await touchBoard(tx, boardId)
  })
}

export async function saveBoardObjects(
  boardId: string,
  request: SaveBoardObjectsRequest,
  userId: string | null,
): Promise<SaveBoardObjectsResponse> {
  return db.transaction(async (tx) => {
    let changed = false
    const versions: Record<string, number> = {}
    const conflicts: SaveBoardObjectsResponse['conflicts'] = []
    const conflictWithCurrent = async (id: string) => {
      const current = await loadBoardObject(boardId, id, tx)
      conflicts.push({ id, object: current?.object ?? null, version: current?.version ?? null })
    }

    for (const { object, baseVersion } of request.upserts) {
      const o = object as unknown as CanvasObject
      const now = new Date()
      const [row] =
        baseVersion === null
          ? await tx
              .insert(schema.boardObject)
              .values({ boardId, id: o.id, type: o.type, object: o, updatedBy: userId })
              .onConflictDoNothing()
              .returning({ version: schema.boardObject.version })
          : await tx
              .update(schema.boardObject)
              .set({
                type: o.type,
                object: o,
                version: sql`${schema.boardObject.version} + 1`,
                updatedBy: userId,
                updatedAt: now,
              })
              .where(
                and(
                  eq(schema.boardObject.boardId, boardId),
                  eq(schema.boardObject.id, o.id),
                  eq(schema.boardObject.version, baseVersion),
                ),
              )
              .returning({ version: schema.boardObject.version })
      if (row) {
        versions[o.id] = row.version
        changed = true
      } else {
        await conflictWithCurrent(o.id)
      }
    }

    for (const { id, baseVersion } of request.deletes) {
      const [row] = await tx
        .delete(schema.boardObject)
        .where(
          and(
            eq(schema.boardObject.boardId, boardId),
            eq(schema.boardObject.id, id),
            eq(schema.boardObject.version, baseVersion),
          ),
        )
        .returning({ id: schema.boardObject.id })
      if (row) {
        changed = true
        continue
      }
      // Already gone is the outcome the client wanted; only a newer copy
      // is a conflict.
      const current = await loadBoardObject(boardId, id, tx)
      if (current) conflicts.push({ id, object: current.object, version: current.version })
    }

    if (changed) await touchBoard(tx, boardId)
    return { versions, conflicts }
  })
}

async function touchBoard(executor: Executor, boardId: string): Promise<void> {
  await executor
    .update(schema.board)
    .set({ updatedAt: new Date() })
    .where(eq(schema.board.id, boardId))
}
