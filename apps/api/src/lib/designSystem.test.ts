import { emptyKitTokens, kitTokensSchema } from '@moodboard/shared'
import { eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Clients, kits, the asset library and the agent tools that read them, against
// a real migrated Postgres (CI provides one; skipped without DATABASE_URL).
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('clients, kits, library and tools', () => {
  let dbMod: typeof import('../db')
  let clientsMod: typeof import('./clients')
  let kitsMod: typeof import('./kits')
  let libMod: typeof import('./assetLibrary')
  let tools: typeof import('./canvasTools')

  const run = nanoid(6).toLowerCase()
  const userId = `u-${run}`
  const boardId = `b-${run}`
  const clientIds: string[] = []
  const assetIds: string[] = []
  let acme: { id: string; slug: string }
  let globex: { id: string; slug: string }
  const ctx = () => ({ boardId, userId })

  const callTool = async (name: string, input: unknown) => {
    const tool = tools.CANVAS_TOOLS.find((t) => t.name === name)!
    return tool.run(ctx(), input)
  }

  beforeAll(async () => {
    dbMod = await import('../db')
    clientsMod = await import('./clients')
    kitsMod = await import('./kits')
    libMod = await import('./assetLibrary')
    tools = await import('./canvasTools')
    const { db, schema } = dbMod
    await db.insert(schema.user).values({ id: userId, name: 'Ada', email: `${userId}@team.test` })
    acme = await clientsMod.createClient(`Acme ${run}`, userId)
    globex = await clientsMod.createClient(`Globex ${run}`, userId)
    clientIds.push(acme.id, globex.id)
    await db.insert(schema.board).values({ id: boardId, name: 'test', clientId: acme.id })
  })

  afterAll(async () => {
    const { db, schema } = dbMod
    await db.delete(schema.asset).where(inArray(schema.asset.id, assetIds))
    await db.delete(schema.board).where(eq(schema.board.id, boardId))
    await db.delete(schema.client).where(inArray(schema.client.id, clientIds))
    await db.delete(schema.user).where(eq(schema.user.id, userId))
    await dbMod.pgClient.end()
  })

  describe('clients', () => {
    it('gives a repeated name a distinct slug', async () => {
      const again = await clientsMod.createClient(`Acme ${run}`, userId)
      clientIds.push(again.id)
      expect(again.slug).toBe(`${acme.slug}-2`)
    })

    it('counts boards and kits, and detaches boards when a client is deleted', async () => {
      const temp = await clientsMod.createClient(`Temp ${run}`, userId)
      clientIds.push(temp.id)
      const { db, schema } = dbMod
      const tempBoard = `tb-${run}`
      await db.insert(schema.board).values({ id: tempBoard, name: 't', clientId: temp.id })
      await kitsMod.createKit({ clientId: temp.id, name: 'k', tokens: emptyKitTokens(), userId })
      expect(await clientsMod.getClient(temp.id)).toMatchObject({ boardCount: 1, kitCount: 1 })

      await clientsMod.deleteClient(temp.id)
      const [board] = await db.select().from(schema.board).where(eq(schema.board.id, tempBoard))
      expect(board!.clientId).toBeNull()
      await db.delete(schema.board).where(eq(schema.board.id, tempBoard))
    })
  })

  describe('kits', () => {
    const tokens = (hex: string) =>
      kitTokensSchema.parse({
        summary: 'Quiet utility',
        palette: [
          { role: 'paper', hex: '#F4EFE6' },
          { role: 'primary', hex },
        ],
        fonts: { display: { family: 'Aktiv Grotesk', weights: [700] } },
      })

    it('appends immutable versions and points the kit at the latest', async () => {
      const kit = await kitsMod.createKit({
        clientId: acme.id,
        name: `Brand ${run}`,
        tokens: tokens('#111111'),
        userId,
      })
      expect(kit.latestVersion).toBe(1)

      const v2 = await kitsMod.addKitVersion({
        kitId: kit.id,
        tokens: tokens('#222222'),
        note: 'darker',
        userId,
      })
      expect(v2).toEqual({ ok: true, version: 2 })

      const latest = await kitsMod.getKitDetail(kit.id)
      expect(latest!.version.version).toBe(2)
      expect(latest!.version.tokens.palette[1]!.hex).toBe('#222222')
      expect(latest!.versions.map((v) => v.version)).toEqual([2, 1])
      expect(latest!.versions[0]).toMatchObject({ note: 'darker', createdByName: 'Ada' })

      const first = await kitsMod.getKitDetail(kit.id, 1)
      expect(first!.version.tokens.palette[1]!.hex).toBe('#111111')
      expect(first!.kit.latestVersion).toBe(2)
    })

    it('refuses a save based on an out-of-date version', async () => {
      const kit = await kitsMod.createKit({
        clientId: acme.id,
        name: `Stale ${run}`,
        tokens: tokens('#111111'),
        userId,
      })
      await kitsMod.addKitVersion({ kitId: kit.id, tokens: tokens('#333333'), userId })
      const stale = await kitsMod.addKitVersion({
        kitId: kit.id,
        tokens: tokens('#444444'),
        baseVersion: 1,
        userId,
      })
      expect(stale).toEqual({ ok: false, reason: 'stale', latest: 2 })
      expect((await kitsMod.getKitDetail(kit.id))!.version.version).toBe(2)
    })

    it('hands out unique version numbers to concurrent saves', async () => {
      const kit = await kitsMod.createKit({
        clientId: acme.id,
        name: `Race ${run}`,
        tokens: tokens('#111111'),
        userId,
      })
      const results = await Promise.all(
        [1, 2, 3, 4].map((n) =>
          kitsMod.addKitVersion({ kitId: kit.id, tokens: tokens(`#00000${n}`), userId }),
        ),
      )
      const versions = results.map((r) => (r.ok ? r.version : -1)).sort()
      expect(versions).toEqual([2, 3, 4, 5])
    })

    it('compiles a stored version to --kit-* css', async () => {
      const kit = await kitsMod.createKit({
        clientId: globex.id,
        name: `Css ${run}`,
        tokens: tokens('#ABCDEF'),
        userId,
      })
      const css = await kitsMod.getKitCss(kit.id)
      expect(css).toContain('--kit-color-primary: #ABCDEF;')
      expect(css).toContain('--kit-font-display: "Aktiv Grotesk"')
      expect(await kitsMod.getKitCss('missing')).toBeNull()
    })
  })

  describe('asset library', () => {
    const record = async (name: string, extra: { clientId?: string } = {}) => {
      const id = await libMod.recordAsset(
        userId,
        `${nanoid(10)}.woff2`,
        'font/woff2',
        100,
        'upload',
        { originalName: name, ...extra },
      )
      assetIds.push(id)
      return id
    }

    it('finds assets by name words, prefixes and tags, ranked, and filters by client/kind', async () => {
      const a = await record(`${run}_Brand-Logo_v2.woff2`, { clientId: acme.id })
      const b = await record(`${run}_hero_photo.woff2`, { clientId: globex.id })
      await libMod.updateAsset(b, {
        tags: ['warm tones', 'portrait'],
        caption: 'A warm studio portrait',
      })

      const page = { limit: 20, offset: 0 }
      const byName = await libMod.searchAssets({ ...page, q: `${run} logo` })
      expect(byName.assets.map((x) => x.id)).toEqual([a])

      const prefix = await libMod.searchAssets({ ...page, q: `${run} por` })
      expect(prefix.assets.map((x) => x.id)).toEqual([b])

      const byCaption = await libMod.searchAssets({ ...page, q: `${run} studio` })
      expect(byCaption.assets.map((x) => x.id)).toEqual([b])

      const byClient = await libMod.searchAssets({ ...page, q: run, client: acme.id })
      expect(byClient.assets.map((x) => x.id)).toEqual([a])

      const byTag = await libMod.searchAssets({ ...page, q: run, tag: 'portrait' })
      expect(byTag.assets.map((x) => x.id)).toEqual([b])

      const wrongKind = await libMod.searchAssets({ ...page, q: run, kind: 'image' })
      expect(wrongKind.assets).toEqual([])
      const fonts = await libMod.searchAssets({ ...page, q: run, kind: 'font' })
      expect(fonts.assets).toHaveLength(2)
    })

    it('pages results and reports the next offset', async () => {
      const found = await libMod.searchAssets({ q: run, limit: 1, offset: 0 })
      expect(found.assets).toHaveLength(1)
      expect(found.nextOffset).toBe(1)
      const last = await libMod.searchAssets({ q: run, limit: 1, offset: 1 })
      expect(last.nextOffset).toBeNull()
    })

    it('hides the page renders recorded alongside pdfs and can list unassigned assets', async () => {
      const thumb = await libMod.recordAsset(
        userId,
        `${nanoid(10)}.png`,
        'image/png',
        5,
        'pdf-thumb',
        {
          originalName: `${run} thumb`,
        },
      )
      assetIds.push(thumb)
      const none = await libMod.searchAssets({ q: run, client: 'none', limit: 20, offset: 0 })
      expect(none.assets.map((x) => x.id)).not.toContain(thumb)
    })

    it('records the library kind from the mime type', async () => {
      const id = await record(`${run} kind`)
      expect((await libMod.getLibraryAsset(id))!.kind).toBe('font')
    })
  })

  describe('agent tools', () => {
    it('list_clients reports this board’s client', async () => {
      const out = await callTool('list_clients', {})
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.payload.boardClient).toMatchObject({ id: acme.id })
      expect((out.payload.clients as { id: string }[]).map((c) => c.id)).toEqual(
        expect.arrayContaining([acme.id, globex.id]),
      )
    })

    it('get_style_kit resolves “the <client> kit” and returns tokens plus css', async () => {
      const solo = await clientsMod.createClient(`Solo ${run}`, userId)
      clientIds.push(solo.id)
      const kit = await kitsMod.createKit({
        clientId: solo.id,
        name: `Only ${run}`,
        tokens: kitTokensSchema.parse({ palette: [{ role: 'accent', hex: '#FF0066' }] }),
        userId,
      })
      const out = await callTool('get_style_kit', { client: `solo ${run}` })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(out.payload.kit).toMatchObject({ id: kit.id, version: 1 })
      expect(out.payload.css).toContain('--kit-color-accent: #FF0066;')
    })

    it('get_style_kit asks which kit when a client has several, and which client when unknown', async () => {
      const many = await clientsMod.createClient(`Many ${run}`, userId)
      clientIds.push(many.id)
      for (const name of ['Alpha', 'Beta']) {
        await kitsMod.createKit({ clientId: many.id, name, tokens: emptyKitTokens(), userId })
      }
      const several = await callTool('get_style_kit', { client: many.slug })
      expect(several).toMatchObject({ ok: false })
      expect(!several.ok && several.error).toMatch(/2 kits \(Alpha, Beta\)/)

      const picked = await callTool('get_style_kit', { client: many.slug, kit: 'beta' })
      expect(picked.ok && picked.payload.kit).toMatchObject({ name: 'Beta' })

      const unknown = await callTool('get_style_kit', { client: 'nobody-here' })
      expect(!unknown.ok && unknown.error).toMatch(/No client matches/)
    })

    it('get_style_kit with no arguments uses the board’s client', async () => {
      const out = await callTool('get_style_kit', {})
      // Acme has several kits from the kit tests above.
      expect(out.ok).toBe(false)
      expect(!out.ok && out.error).toMatch(/kits \(/)
    })

    it('list_kits scopes to a client', async () => {
      const out = await callTool('list_kits', { client: acme.slug })
      expect(
        out.ok &&
          (out.payload.kits as { clientSlug: string }[]).every((k) => k.clientSlug === acme.slug),
      ).toBe(true)
    })

    it('search_assets resolves the client by name and returns asset urls', async () => {
      const out = await callTool('search_assets', { query: run, client: acme.slug })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const assets = out.payload.assets as { name: string; url: string; client: string }[]
      expect(assets).toHaveLength(1)
      expect(assets[0]!.name).toContain('Brand-Logo')
      expect(assets[0]!.url).toMatch(/^\/api\/files\//)
    })

    it('get_linear_issue explains that Linear is not set up', async () => {
      const out = await callTool('get_linear_issue', { issue: 'LIN-1' })
      expect(out.ok).toBe(false)
    })

    it('rejects malformed input before running', async () => {
      const out = await callTool('search_assets', { limit: 500 })
      expect(out.ok).toBe(false)
    })
  })
})
