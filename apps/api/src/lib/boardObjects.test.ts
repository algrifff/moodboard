import type { CanvasObject } from '@moodboard/shared'
import { nanoid } from 'nanoid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Runs against a real, migrated Postgres when DATABASE_URL is set (CI
// provides one); skipped otherwise. The db module throws at import without
// DATABASE_URL, so it's imported lazily.
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('saveBoardObjects', () => {
  let mod: typeof import('./boardObjects')
  let dbMod: typeof import('../db')
  const boardId = `test-${nanoid()}`

  const sticky = (id: string, text: string, zIndex = 0): CanvasObject => ({
    id,
    type: 'sticky',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 200 },
    rotation: 0,
    zIndex,
    data: { text, color: '#FEF3C7' },
  })
  const upsert = (object: CanvasObject, baseVersion: number | null) => ({
    object: object as unknown as CanvasObject & { data: Record<string, unknown> },
    baseVersion,
  })

  beforeAll(async () => {
    mod = await import('./boardObjects')
    dbMod = await import('../db')
    await dbMod.db.insert(dbMod.schema.board).values({ id: boardId, name: 'test' })
  })

  afterAll(async () => {
    const { eq } = await import('drizzle-orm')
    await dbMod.db.delete(dbMod.schema.board).where(eq(dbMod.schema.board.id, boardId))
    await dbMod.pgClient.end()
  })

  it('creates objects at version 1 and bumps on update', async () => {
    const created = await mod.saveBoardObjects(
      boardId,
      { upserts: [upsert(sticky('a', 'one'), null)], deletes: [] },
      null,
    )
    expect(created).toEqual({ versions: { a: 1 }, conflicts: [] })

    const updated = await mod.saveBoardObjects(
      boardId,
      { upserts: [upsert(sticky('a', 'two'), 1)], deletes: [] },
      null,
    )
    expect(updated).toEqual({ versions: { a: 2 }, conflicts: [] })
  })

  it('rejects a stale write and returns the server copy', async () => {
    const stale = await mod.saveBoardObjects(
      boardId,
      { upserts: [upsert(sticky('a', 'stale'), 1)], deletes: [] },
      null,
    )
    expect(stale.versions).toEqual({})
    expect(stale.conflicts).toHaveLength(1)
    expect(stale.conflicts[0]!.version).toBe(2)
    expect((stale.conflicts[0]!.object!.data as { text: string }).text).toBe('two')
  })

  it('treats creating an id that already exists as a conflict', async () => {
    const dup = await mod.saveBoardObjects(
      boardId,
      { upserts: [upsert(sticky('a', 'dup'), null)], deletes: [] },
      null,
    )
    expect(dup.conflicts[0]!.version).toBe(2)
  })

  it('reports an update to a deleted object as a conflict with null', async () => {
    await mod.saveBoardObjects(
      boardId,
      { upserts: [upsert(sticky('b', 'b'), null)], deletes: [] },
      null,
    )
    await mod.saveBoardObjects(
      boardId,
      { upserts: [], deletes: [{ id: 'b', baseVersion: 1 }] },
      null,
    )
    const res = await mod.saveBoardObjects(
      boardId,
      { upserts: [upsert(sticky('b', 'edit'), 1)], deletes: [] },
      null,
    )
    expect(res.conflicts).toEqual([{ id: 'b', object: null, version: null }])
  })

  it('refuses to delete a newer copy, ignores deleting a missing one', async () => {
    const res = await mod.saveBoardObjects(
      boardId,
      {
        upserts: [],
        deletes: [
          { id: 'a', baseVersion: 1 },
          { id: 'missing', baseVersion: 1 },
        ],
      },
      null,
    )
    expect(res.conflicts.map((c) => c.id)).toEqual(['a'])
    expect(await mod.loadBoardObject(boardId, 'a')).not.toBeNull()
  })

  it('loads objects in zIndex then creation order', async () => {
    await mod.saveBoardObjects(
      boardId,
      {
        upserts: [upsert(sticky('c', 'c', 5), null), upsert(sticky('d', 'd', 1), null)],
        deletes: [],
      },
      null,
    )
    const ids = (await mod.loadBoardObjects(boardId)).map((o) => o.object.id)
    expect(ids).toEqual(['a', 'd', 'c'])
  })
})
