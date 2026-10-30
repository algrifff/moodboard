import { figmaCardSize, parseFigmaUrl, type CanvasObject } from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createFakeFigma, FAKE_FIGMA_ORIGIN, type FakeFigma } from './testing/fakeFigma'

// The Figma flow against a stand-in Figma (recorded fixtures behind a fake
// fetch) and a real, migrated Postgres: token refresh, importing and
// refreshing frames into the library, kits from a file, the agent tools and
// the add_url dispatcher. Skipped without DATABASE_URL.
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('figma flow (fake Figma)', () => {
  let dbMod: typeof import('../db')
  let conn: typeof import('./figmaConnection')
  let imp: typeof import('./figmaImport')
  let kitImport: typeof import('./figmaKitImport')
  let tools: typeof import('./canvasTools')
  let objectsMod: typeof import('./boardObjects')
  let crypto: typeof import('./cryptoTokens')
  let analyzeContent: typeof import('./analyzeContent')
  let figma: FakeFigma
  let dataDir = ''
  const savedEnv = { ...process.env }
  const userId = `u-${nanoid()}`
  const strangerId = `u-${nanoid()}`
  const clientId = `c-${nanoid()}`
  const boardId = `b-${nanoid()}`
  const connectionId = `conn-${nanoid()}`
  const KEY = 'AbCdEfGhIjKlMnOpQrStUv'
  const FRAME_URL = `https://www.figma.com/design/${KEY}/Acme-Brand?node-id=12-34`
  const FILE_URL = `https://www.figma.com/design/${KEY}/Acme-Brand`
  const ctx = () => ({ boardId, userId })
  const tool = (name: string) => tools.CANVAS_TOOLS.find((t) => t.name === name)!
  const setConnection = async (patch: Partial<typeof dbMod.schema.connection.$inferInsert>) => {
    await dbMod.db
      .update(dbMod.schema.connection)
      .set(patch)
      .where(eq(dbMod.schema.connection.id, connectionId))
  }
  const readConnection = async () =>
    (
      await dbMod.db
        .select()
        .from(dbMod.schema.connection)
        .where(eq(dbMod.schema.connection.id, connectionId))
    )[0]!

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'mb-figma-'))
    process.env.DATA_DIR = dataDir
    process.env.CONNECTION_TOKEN_KEY ||= randomBytes(32).toString('hex')
    process.env.FIGMA_CLIENT_ID = 'cid'
    process.env.FIGMA_CLIENT_SECRET = 'csecret'
    process.env.FIGMA_REDIRECT_URI = 'http://localhost:5173/api/connections/figma/callback'
    process.env.FIGMA_API_BASE = FAKE_FIGMA_ORIGIN
    delete process.env.ANTHROPIC_API_KEY
    figma = createFakeFigma()
    vi.stubGlobal('fetch', figma.fetch)

    await (await import('./storage')).ensureDataDirs()
    dbMod = await import('../db')
    conn = await import('./figmaConnection')
    imp = await import('./figmaImport')
    kitImport = await import('./figmaKitImport')
    tools = await import('./canvasTools')
    objectsMod = await import('./boardObjects')
    crypto = await import('./cryptoTokens')
    analyzeContent = await import('./analyzeContent')
    const { db, schema } = dbMod
    await db.insert(schema.user).values([
      { id: userId, name: 'Fay', email: `${nanoid()}@team.com` },
      { id: strangerId, name: 'Sam', email: `${nanoid()}@team.com` },
    ])
    await db
      .insert(schema.client)
      .values({ id: clientId, name: `Acme ${nanoid(6)}`, slug: clientId })
    await db.insert(schema.board).values({ id: boardId, name: 'figma test', clientId })
    await db.insert(schema.connection).values({
      id: connectionId,
      userId,
      provider: 'figma',
      accountEmail: 'ada@acme.test',
      accessTokenEnc: crypto.encryptToken('figu_access_1'),
      refreshTokenEnc: crypto.encryptToken('figur_refresh_1'),
      expiresAt: new Date(Date.now() + 86_400_000),
      scopes: 'file_content:read',
    })
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    process.env = savedEnv
    const { db, schema } = dbMod
    await db.delete(schema.asset).where(eq(schema.asset.clientId, clientId))
    await db.delete(schema.styleKit).where(eq(schema.styleKit.clientId, clientId))
    await db.delete(schema.board).where(eq(schema.board.id, boardId))
    await db.delete(schema.client).where(eq(schema.client.id, clientId))
    await db.delete(schema.user).where(eq(schema.user.id, userId))
    await db.delete(schema.user).where(eq(schema.user.id, strangerId))
    await dbMod.pgClient.end()
  })

  describe('token refresh', () => {
    it('uses a fresh token as is, without calling Figma', async () => {
      const before = figma.calls.length
      const token = await conn.getFigmaToken(await readConnection())
      expect(token).toBe('figu_access_1')
      expect(figma.calls.length).toBe(before)
    })

    it('refreshes an expired token, stores it encrypted and keeps the refresh token', async () => {
      await setConnection({ expiresAt: new Date(Date.now() - 1000) })
      const token = await conn.getFigmaToken(await readConnection())
      expect(token).toBe('figu_refreshed_1')
      const row = await readConnection()
      expect(crypto.decryptToken(row.accessTokenEnc)).toBe('figu_refreshed_1')
      expect(crypto.decryptToken(row.refreshTokenEnc!)).toBe('figur_refresh_1')
      expect(row.accessTokenEnc).not.toContain('figu_refreshed_1')
      expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000)
      expect(figma.calls).toContain('POST /v1/oauth/refresh')
      // …and the next call is fresh again.
      const calls = figma.calls.length
      await conn.getFigmaToken(await readConnection())
      expect(figma.calls.length).toBe(calls)
    })

    it('asks to reconnect when Figma refuses the refresh or there is no refresh token', async () => {
      await setConnection({ expiresAt: new Date(Date.now() - 1000) })
      figma.refreshStatus = 400
      await expect(conn.getFigmaToken(await readConnection())).rejects.toMatchObject({
        name: 'FigmaUnavailableError',
        code: 'reconnect',
      })
      figma.refreshStatus = 200
      await setConnection({ refreshTokenEnc: null })
      await expect(conn.getFigmaToken(await readConnection())).rejects.toMatchObject({
        code: 'reconnect',
      })
      await setConnection({
        refreshTokenEnc: crypto.encryptToken('figur_refresh_1'),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    })

    it('reports unconfigured and unconnected separately', async () => {
      await expect(conn.figmaForUser(strangerId)).rejects.toMatchObject({ code: 'not-connected' })
      const id = process.env.FIGMA_CLIENT_ID
      delete process.env.FIGMA_CLIENT_ID
      await expect(conn.figmaForUser(userId)).rejects.toMatchObject({ code: 'not-configured' })
      process.env.FIGMA_CLIENT_ID = id
    })

    it('tells a rejected token from a file the person cannot open', async () => {
      const { FigmaApiError } = await import('./figma')
      expect(
        conn.isTokenRejection(new FigmaApiError(403, 'Figma refused access (Invalid token).')),
      ).toBe(true)
      expect(conn.isTokenRejection(new FigmaApiError(401, 'x'))).toBe(true)
      expect(
        conn.isTokenRejection(new FigmaApiError(403, 'Figma refused access (Forbidden).')),
      ).toBe(false)
      expect(conn.isTokenRejection(new FigmaApiError(404, 'x'))).toBe(false)
    })
  })

  describe('importing and refreshing frames', () => {
    let imported: Awaited<ReturnType<typeof imp.importFigmaFrames>>[number]

    it('browses a file’s pages and frames', async () => {
      const api = await conn.figmaForUser(userId)
      const tree = await imp.readFileTree(api, parseFigmaUrl(FILE_URL)!)
      expect(tree.name).toBe('Acme Brand')
      expect(tree.pages.map((p) => [p.name, p.frames.map((f) => f.name)])).toEqual([
        ['Brand', ['Hero', 'Empty']],
        ['Screens', ['Mobile / Home', 'Section A']],
      ])
      expect(tree.pages[0]!.frames[0]).toMatchObject({ id: '12:34', width: 1440, height: 900 })
    })

    it('renders a frame, saves it to the library and describes the card', async () => {
      const api = await conn.figmaForUser(userId)
      const frames = await imp.importFigmaFrames(api, {
        userId,
        clientId,
        fileKey: KEY,
        nodeIds: ['12:34'],
      })
      imported = frames[0]!
      expect(imported).toMatchObject({
        fileKey: KEY,
        nodeId: '12:34',
        name: 'Hero',
        fileName: 'Acme Brand',
        figmaUrl: `https://www.figma.com/design/${KEY}/Acme-Brand?node-id=12-34`,
        width: 1440,
        height: 900,
        lastModified: '2026-03-04T10:00:00Z',
      })
      expect(imported.url).toMatch(/^\/api\/files\/[\w-]+\.png$/)
      expect(imported.structure).toContain('Frame “Hero”, 1440×900, vertical auto-layout, gap 24')
      expect(existsSync(path.join(dataDir, 'uploads', imported.url.split('/').pop()!))).toBe(true)
      // The scale asked for keeps the long edge in bounds.
      expect(figma.calls.some((c) => c.includes('/v1/images/') && c.includes('scale=1.42'))).toBe(
        true,
      )

      const { db, schema } = dbMod
      const [asset] = await db
        .select()
        .from(schema.asset)
        .where(eq(schema.asset.filename, imported.url.split('/').pop()!))
      expect(asset).toMatchObject({
        clientId,
        mediaKind: 'image',
        originalName: 'Acme Brand — Hero',
        tags: ['figma', 'acme brand'],
        createdBy: userId,
      })
    })

    it('refuses what cannot be a frame, and says so for a missing or unrenderable one', async () => {
      const api = await conn.figmaForUser(userId)
      const run = (nodeIds: string[]) =>
        imp.importFigmaFrames(api, { userId, fileKey: KEY, nodeIds })
      await expect(run([])).rejects.toMatchObject({ code: 'NO_FRAME' })
      await expect(run(['not-an-id'])).rejects.toMatchObject({ code: 'BAD_LINK' })
      await expect(run(['0:1'])).rejects.toMatchObject({ code: 'NOT_RENDERABLE' })
      await expect(run(['77:7'])).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(run(['12:99'])).rejects.toMatchObject({ code: 'RENDER_FAILED' })
    })

    it('does not render again when the file has not changed', async () => {
      const api = await conn.figmaForUser(userId)
      const before = figma.calls.filter((c) => c.includes('/v1/images/')).length
      const same = await imp.refreshFigmaFrame(api, { userId, data: imported })
      expect(same.changed).toBe(false)
      expect(same.data).toEqual(imported)
      expect(figma.calls.filter((c) => c.includes('/v1/images/')).length).toBe(before)
    })

    it('re-renders when the file changed, or when forced, filing it under the same client', async () => {
      const api = await conn.figmaForUser(userId)
      figma.lastModified = '2026-03-09T09:00:00Z'
      const fresh = await imp.refreshFigmaFrame(api, { userId, data: imported })
      expect(fresh.changed).toBe(true)
      expect(fresh.data.lastModified).toBe('2026-03-09T09:00:00Z')
      expect(fresh.data.url).not.toBe(imported.url)
      expect(fresh.data.nodeId).toBe('12:34')
      const { db, schema } = dbMod
      const [asset] = await db
        .select({ clientId: schema.asset.clientId })
        .from(schema.asset)
        .where(eq(schema.asset.filename, fresh.data.url.split('/').pop()!))
      expect(asset!.clientId).toBe(clientId)

      const forced = await imp.refreshFigmaFrame(api, { userId, data: fresh.data, force: true })
      expect(forced.changed).toBe(true)
      expect(forced.data.url).not.toBe(fresh.data.url)
      figma.lastModified = '2026-03-04T10:00:00Z'
    })
  })

  describe('kit from a file', () => {
    it('previews without saving, creates a kit, then adds a version that keeps the logo', async () => {
      const api = await conn.figmaForUser(userId)
      const preview = await kitImport.figmaKitFromFile(api, { fileKey: KEY, userId, preview: true })
      expect(preview).toMatchObject({
        ok: true,
        result: { saved: false, kit: null, version: null },
      })
      if (!preview.ok) return
      expect(preview.result.report.mapped.length).toBeGreaterThan(4)
      expect(preview.result.report.variables).toBe('forbidden')

      const needsClient = await kitImport.figmaKitFromFile(api, { fileKey: KEY, userId })
      expect(needsClient).toMatchObject({ ok: false, status: 400 })

      const created = await kitImport.figmaKitFromFile(api, { fileKey: KEY, userId, clientId })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      expect(created.result).toMatchObject({ saved: true, version: { version: 1 } })
      expect(created.result.kit).toMatchObject({ name: 'Acme Brand', clientId })
      expect(created.result.tokens.fonts.display?.family).toBe('Aktiv Grotesk')
      const kitId = created.result.kit!.id

      const kits = await import('./kits')
      const base = (await kits.getKitDetail(kitId))!
      await kits.addKitVersion({
        kitId,
        userId,
        baseVersion: 1,
        note: 'logo',
        tokens: {
          ...base.version.tokens,
          logos: [{ name: 'Logo', url: '/api/files/logo.png', usage: '' }],
          voice: { ...base.version.tokens.voice, donts: ['No puns.'] },
        },
      })
      const next = await kitImport.figmaKitFromFile(api, { fileKey: KEY, userId, kitId })
      expect(next).toMatchObject({ ok: true, result: { saved: true, version: { version: 3 } } })
      const after = (await kits.getKitDetail(kitId))!
      expect(after.version.version).toBe(3)
      expect(after.version.note).toBe('Figma import: Acme Brand')
      expect(after.version.tokens.logos).toHaveLength(1)
      expect(after.version.tokens.voice.donts).toEqual(['No puns.'])
      expect(after.version.tokens.palette.length).toBeGreaterThan(3)
      expect(after.versions.map((v) => v.version)).toEqual([3, 2, 1])

      const stale = await kitImport.figmaKitFromFile(api, {
        fileKey: KEY,
        userId,
        kitId,
        baseVersion: 1,
      })
      expect(stale).toMatchObject({ ok: false, status: 409, latest: 3 })
      const missing = await kitImport.figmaKitFromFile(api, { fileKey: KEY, userId, kitId: 'nope' })
      expect(missing).toMatchObject({ ok: false, status: 404 })
    })
  })

  describe('agent tools', () => {
    const boardFrames = async () =>
      (await objectsMod.loadBoardObjects(boardId)).filter((v) => v.object.type === 'figma-frame')

    it('import_figma_frame puts a card on the board, remembering its origin', async () => {
      const out = await tool('import_figma_frame').run(ctx(), { url: FRAME_URL })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.payload.summary).toBe('Imported “Hero” from “Acme Brand”')
      const [card] = await boardFrames()
      expect(card!.object.size).toEqual(figmaCardSize(1440, 900))
      expect(card!.object.data).toMatchObject({
        fileKey: KEY,
        nodeId: '12:34',
        name: 'Hero',
        fileName: 'Acme Brand',
      })
      expect(out.effects?.objects?.[0]?.object.id).toBe(card!.object.id)
    })

    it('does not duplicate a frame already on the board, and refreshes it when the file changed', async () => {
      const again = await tool('import_figma_frame').run(ctx(), { url: FRAME_URL })
      expect(again).toMatchObject({ ok: true, payload: { alreadyOnBoard: true, changed: false } })
      expect(await boardFrames()).toHaveLength(1)

      figma.lastModified = '2026-04-01T08:00:00Z'
      const refreshed = await tool('import_figma_frame').run(ctx(), { url: FRAME_URL })
      expect(refreshed).toMatchObject({
        ok: true,
        payload: { alreadyOnBoard: true, changed: true },
      })
      if (!refreshed.ok) return
      expect(refreshed.effects?.objects?.[0]?.version).toBe(2)
      const [card] = await boardFrames()
      expect(card!.version).toBe(2)
      expect((card!.object.data as { lastModified: string }).lastModified).toBe(
        '2026-04-01T08:00:00Z',
      )
      figma.lastModified = '2026-03-04T10:00:00Z'
    })

    it('lists a file’s frames when given a file link, and takes one by name', async () => {
      const list = await tool('import_figma_frame').run(ctx(), { url: FILE_URL })
      expect(list.ok).toBe(false)
      if (list.ok) return
      expect(list.error).toContain('whole file')
      expect(list.error).toContain('Brand / Hero (1440×900)')
      expect(list.error).toContain('node-id=12-34')

      const nope = await tool('import_figma_frame').run(ctx(), { url: FILE_URL, frame: 'Zzz' })
      expect(nope).toMatchObject({ ok: false })

      const named = await tool('import_figma_frame').run(ctx(), { url: FILE_URL, frame: 'Hero' })
      expect(named).toMatchObject({ ok: true, payload: { alreadyOnBoard: true } })
    })

    it('says what is wrong for other links and for people who have not connected', async () => {
      const web = await tool('import_figma_frame').run(ctx(), { url: 'https://example.com/x' })
      expect(web).toMatchObject({ ok: false, error: 'That isn’t a Figma file or frame link.' })
      const make = await tool('import_figma_frame').run(ctx(), {
        url: `https://www.figma.com/make/${KEY}/App`,
      })
      expect(make).toMatchObject({ ok: false })
      const stranger = await tool('import_figma_frame').run(
        { boardId, userId: strangerId },
        { url: FRAME_URL },
      )
      expect(stranger).toMatchObject({
        ok: false,
        error: expect.stringContaining('isn’t connected'),
      })
    })

    it('get_figma_frame returns the outline and attaches the picture', async () => {
      const out = await tool('get_figma_frame').run(ctx(), { frame: 'Hero' })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.payload).toMatchObject({ frame: 'Hero', file: 'Acme Brand', size: '1440×900' })
      expect(out.payload.structure as string).toContain('vertical auto-layout, gap 24')
      expect(out.images).toHaveLength(1)
      expect(out.images![0]!.data.subarray(0, 4).toString('hex')).toBe('89504e47')
      // A Figma link to the same frame finds it too.
      expect((await tool('get_figma_frame').run(ctx(), { frame: FRAME_URL })).ok).toBe(true)
      const missing = await tool('get_figma_frame').run(ctx(), { frame: 'Footer' })
      expect(missing).toMatchObject({
        ok: false,
        error: expect.stringContaining('Frames on the board: “Hero”'),
      })
    })

    it('figma_kit_from_file previews, then saves for the board’s client', async () => {
      const dry = await tool('figma_kit_from_file').run(ctx(), { url: FILE_URL, dryRun: true })
      expect(dry).toMatchObject({ ok: true, payload: { saved: false } })
      if (!dry.ok) return
      expect(
        (dry.payload.mapped as string[]).some((m) => m.startsWith('Brand Primary: #1F2A44')),
      ).toBe(true)
      expect((dry.payload.skipped as string[]).some((s) => s.startsWith('Gradients/Sunset'))).toBe(
        true,
      )

      const kits = await import('./kits')
      const existing = await kits.listKits({ clientId })
      const out = await tool('figma_kit_from_file').run(ctx(), {
        url: FILE_URL,
        kit: existing[0]!.name,
      })
      expect(out).toMatchObject({ ok: true, payload: { saved: true, version: 4 } })
      const unknown = await tool('figma_kit_from_file').run(ctx(), { url: FILE_URL, kit: 'Nope' })
      expect(unknown).toMatchObject({ ok: false })
    })

    it('add_url recognises a Figma frame link', async () => {
      const { routeUrlToImporter } = await import('./mcpUrlDispatch')
      const result = await routeUrlToImporter(
        `https://www.figma.com/design/${KEY}/Acme-Brand?node-id=12-34&t=zzz`,
        userId,
      )
      expect(result).toMatchObject({ ok: true, result: { kind: 'figma-frame' } })
      const file = await routeUrlToImporter(FILE_URL, userId)
      expect(file).toMatchObject({ ok: false, error: { code: 'EXTRACT_FAILED' } })
      const stranger = await routeUrlToImporter(FRAME_URL, strangerId)
      expect(stranger).toMatchObject({
        ok: false,
        error: { code: 'CONNECTION_REQUIRED', provider: 'figma' },
      })
    })

    it('add_url puts the card on the board through the tool', async () => {
      const before = (await boardFrames()).length
      const out = await tool('add_url').run(ctx(), { url: `${FRAME_URL}&t=abc` })
      expect(out).toMatchObject({ ok: true, payload: { type: 'figma-frame' } })
      expect((await boardFrames()).length).toBe(before + 1)
    })
  })

  describe('analysis', () => {
    it('reads a Figma card as an image with its frame and file names', async () => {
      const [card] = (await objectsMod.loadBoardObjects(boardId)).filter(
        (v) => v.object.type === 'figma-frame',
      )
      const content = await analyzeContent.buildGroupContent([card!.object as CanvasObject])
      expect(content[0]).toMatchObject({ type: 'text' })
      expect((content[0] as { text: string }).text).toContain('Figma frame “Hero”')
      expect(content[1]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } })
      const texts = content.flatMap((b) => (b.type === 'text' ? [b.text] : []))
      expect(
        texts.some((t) => t.includes('Figma frame (1440×900): "Hero" from "Acme Brand"')),
      ).toBe(true)
    })
  })
})
