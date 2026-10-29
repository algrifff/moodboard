import { groupId, proximityGroups, type CanvasObject } from '@moodboard/shared'
import { nanoid } from 'nanoid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Runs against a real, migrated Postgres when DATABASE_URL is set (CI
// provides one); skipped otherwise. db-backed modules are imported lazily
// because the db module throws at import without DATABASE_URL.
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('canvas tools + agent threads', () => {
  let tools: typeof import('./canvasTools')
  let objectsMod: typeof import('./boardObjects')
  let threads: typeof import('./agentThreads')
  let dbMod: typeof import('../db')
  const boardId = `test-${nanoid()}`
  const ctx = { boardId, userId: '' }

  const sticky = (id: string, x: number, y: number): CanvasObject => ({
    id,
    type: 'sticky',
    position: { x, y },
    size: { width: 200, height: 200 },
    rotation: 0,
    zIndex: 0,
    data: { text: `note ${id}`, color: '#FEF3C7' },
  })
  const tool = (name: string) => tools.CANVAS_TOOLS.find((t) => t.name === name)!

  beforeAll(async () => {
    tools = await import('./canvasTools')
    objectsMod = await import('./boardObjects')
    threads = await import('./agentThreads')
    dbMod = await import('../db')
    const [u] = await dbMod.db
      .insert(dbMod.schema.user)
      .values({ id: `u-${nanoid()}`, name: 'Tester', email: `${nanoid()}@team.com` })
      .returning()
    ctx.userId = u!.id
    await dbMod.db.insert(dbMod.schema.board).values({ id: boardId, name: 'tools test' })
    await objectsMod.saveBoardObjects(
      boardId,
      {
        upserts: [sticky('a', 0, 0), sticky('b', 1500, 900), sticky('c', 3000, 0)].map((o) => ({
          object: o as unknown as CanvasObject & { data: Record<string, unknown> },
          baseVersion: null,
        })),
        deletes: [],
      },
      null,
    )
  })

  afterAll(async () => {
    const { eq } = await import('drizzle-orm')
    await dbMod.db.delete(dbMod.schema.board).where(eq(dbMod.schema.board.id, boardId))
    await dbMod.db.delete(dbMod.schema.user).where(eq(dbMod.schema.user.id, ctx.userId))
    await dbMod.pgClient.end()
  })

  it('get_board lists items and groups', async () => {
    const out = await tool('get_board').run(ctx, {})
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.payload.items).toHaveLength(3)
    expect(out.payload.groups).toEqual([])
    expect(out.payload.summary).toBe('Read the board — 3 items, 0 groups')
  })

  it('group_objects forms exactly that group with versioned writes', async () => {
    const out = await tool('group_objects').run(ctx, { objectIds: ['a', 'b'] })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.payload.groupKey).toBe(groupId(['a', 'b']))
    expect(out.effects?.objects?.map((o) => [o.object.id, o.version]).sort()).toEqual([
      ['a', 2],
      ['b', 2],
    ])
    const stored = (await objectsMod.loadBoardObjects(boardId)).map((v) => v.object)
    expect(proximityGroups(stored).map((g) => [...g].sort())).toEqual([['a', 'b']])
  })

  it('a teammate saving a stale copy after an agent move gets a conflict', async () => {
    const stale = sticky('b', 1500, 900)
    const res = await objectsMod.saveBoardObjects(
      boardId,
      {
        upserts: [
          {
            object: stale as unknown as CanvasObject & { data: Record<string, unknown> },
            baseVersion: 1,
          },
        ],
        deletes: [],
      },
      null,
    )
    expect(res.conflicts.map((c) => [c.id, c.version])).toEqual([['b', 2]])
  })

  it('move_objects reports unknown ids instead of writing', async () => {
    const out = await tool('move_objects').run(ctx, { moves: [{ id: 'nope', x: 0, y: 0 }] })
    expect(out).toEqual({ ok: false, error: 'No objects with ids: nope' })
  })

  it('analyze_group refuses items that are not grouped', async () => {
    const out = await tool('analyze_group').run(ctx, {
      objectIds: ['c'],
      agents: ['art-director', 'copywriter'],
    })
    expect(out.ok).toBe(false)
  })

  it('analyze_group serves a cached brief and records it for the panel', async () => {
    const { analysisHash } = await import('./analysisHash')
    const { synthesisModelTag, DEFAULT_DEPTH } = await import('./modelTags')
    const items = (await objectsMod.loadBoardObjects(boardId))
      .map((v) => v.object)
      .filter((o) => o.id === 'a' || o.id === 'b')
    const brief = { throughline: 'Cached throughline', palette: [{ hex: '#112233' }] }
    await dbMod.db
      .insert(dbMod.schema.groupAnalysis)
      .values({
        cacheKey: analysisHash(
          items,
          synthesisModelTag(['art-director', 'copywriter'], DEFAULT_DEPTH),
        ),
        model: 'test',
        analysis: brief,
      })
      .onConflictDoNothing()

    const out = await tool('analyze_group').run(ctx, {
      objectIds: ['b'],
      agents: ['copywriter', 'art-director'],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.payload).toMatchObject({
      summary: 'Brief ready',
      cached: true,
      groupKey: groupId(['a', 'b']),
      display: { kind: 'brief', data: brief },
    })
    expect(out.effects?.groups).toEqual([
      expect.objectContaining({
        groupKey: groupId(['a', 'b']),
        agentIds: ['art-director', 'copywriter'],
        aiPalette: ['#112233'],
      }),
    ])
  })

  it('threads persist messages in order and resume', async () => {
    const thread = await threads.createThread(boardId, ctx.userId)
    expect(thread).toMatchObject({ title: 'New thread', createdByName: 'Tester' })
    await threads.appendMessage(thread.id, 'user', [{ type: 'text', text: 'hi' }])
    await threads.appendMessage(thread.id, 'assistant', [
      { type: 'tool_use', id: 'tu1', name: 'get_board', input: {} },
    ])
    await threads.appendMessage(thread.id, 'user', [
      { type: 'tool_result', tool_use_id: 'tu1', content: '{"summary":"ok"}' },
    ])
    await threads.appendMessage(thread.id, 'assistant', [{ type: 'text', text: 'oops' }], true)
    const messages = await threads.listMessages(thread.id)
    expect(messages.map((m) => [m.role, m.content[0]!.type, m.isError])).toEqual([
      ['user', 'text', false],
      ['assistant', 'tool_use', false],
      ['user', 'tool_result', false],
      ['assistant', 'text', true],
    ])
    const listed = await threads.listThreads(boardId)
    expect(listed[0]!.id).toBe(thread.id)
  })
})
