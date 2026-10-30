import { kitTokensSchema, outputDetailSchema } from '@moodboard/shared'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Runs against a real, migrated Postgres when DATABASE_URL is set (CI
// provides one); skipped otherwise. db-backed modules are imported lazily.
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('templates + outputs', () => {
  let dbMod: typeof import('../db')
  let outputs: typeof import('./outputs')
  let templates: typeof import('./templates')
  let starters: typeof import('./starterTemplates')
  let files: typeof import('./starterTemplateFiles')
  let tools: typeof import('./canvasTools')
  let routes: typeof import('../routes/outputs')

  const userId = `u-${nanoid()}`
  const clientId = `c-${nanoid()}`
  const boardId = `b-${nanoid()}`
  const ctx = { boardId, userId }
  let kitId = ''
  let thumbnailId = ''
  let outputId = ''
  const createdTemplates: string[] = []

  const tool = (name: string) => tools.CANVAS_TOOLS.find((t) => t.name === name)!

  beforeAll(async () => {
    dbMod = await import('../db')
    outputs = await import('./outputs')
    templates = await import('./templates')
    starters = await import('./starterTemplates')
    files = await import('./starterTemplateFiles')
    tools = await import('./canvasTools')
    routes = await import('../routes/outputs')
    const kits = await import('./kits')
    const { db, schema } = dbMod
    await db.insert(schema.user).values({ id: userId, name: 'Tess', email: `${nanoid()}@team.com` })
    await db.insert(schema.client).values({ id: clientId, name: 'Outputs Co', slug: clientId })
    await db.insert(schema.board).values({ id: boardId, name: 'outputs test', clientId })
    const kit = await kits.createKit({
      clientId,
      name: 'Main',
      userId,
      tokens: kitTokensSchema.parse({
        palette: [
          { role: 'background', hex: '#111111' },
          { role: 'primary', hex: '#FF0066' },
        ],
      }),
    })
    kitId = kit.id
    await starters.syncStarterTemplates()
    thumbnailId = (await templates.listTemplates()).find(
      (t) => t.starter && t.format === 'thumbnail',
    )!.id
  })

  afterAll(async () => {
    const { eq, inArray } = await import('drizzle-orm')
    const { db, schema } = dbMod
    await db.delete(schema.output).where(eq(schema.output.clientId, clientId))
    if (createdTemplates.length > 0) {
      await db.delete(schema.template).where(inArray(schema.template.id, createdTemplates))
    }
    await db.delete(schema.board).where(eq(schema.board.id, boardId))
    await db.delete(schema.client).where(eq(schema.client.id, clientId))
    await db.delete(schema.user).where(eq(schema.user.id, userId))
    await dbMod.pgClient.end()
  })

  it('starter sync is idempotent and versions changed files', async () => {
    expect(await starters.syncStarterTemplates()).toEqual({ created: [], updated: [] })
    const shipped = await files.loadStarterTemplates()
    const before = (await templates.getTemplateSummary(thumbnailId))!
    const edited = shipped.map((s) =>
      s.key === 'youtube-thumbnail' ? { ...s, css: `${s.css}\n/* test */` } : s,
    )
    expect(await starters.syncStarterTemplates(edited)).toEqual({
      created: [],
      updated: ['youtube-thumbnail'],
    })
    // Back to the shipped files: one more version, never a rewrite.
    await starters.syncStarterTemplates(shipped)
    const after = (await templates.getTemplateDetail(thumbnailId))!
    expect(after.template.latestVersion).toBe(before.latestVersion + 2)
    expect(after.version.css).toBe(shipped[0]!.css)
    expect(after.versions.map((v) => v.note)).toContain('Starter template updated')
  })

  it('creates an output from a template, pinned to the kit version', async () => {
    const res = await outputs.createOutput({
      templateId: thumbnailId,
      clientId,
      kitId,
      slotValues: { headline: 'Hello <world>' },
      boardId,
      userId,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    outputId = res.output.id
    expect(res.output).toMatchObject({ format: 'thumbnail', kitName: 'Main', latestVersion: 1 })
    const detail = outputDetailSchema.parse(await outputs.getOutputDetail(outputId))
    expect(detail.version.kitVersion).toBe(1)
    const headline = detail.version.slots.find((s) => s.name === 'headline')!
    expect(headline).toMatchObject({ kind: 'text', label: 'Headline', value: 'Hello <world>' })
    expect(detail.version.slots.find((s) => s.name === 'kicker')!.value).toBeNull()
  })

  it('rejects image slots that are not library files', async () => {
    const res = await outputs.createOutput({
      templateId: thumbnailId,
      clientId,
      kitId: null,
      slotValues: { hero: 'https://evil.test/x.png' },
      userId,
    })
    expect(res).toMatchObject({ ok: false, status: 400 })
  })

  it('appends versions: merges slots, resets with null, refuses a stale base', async () => {
    const v2 = await outputs.addOutputVersion({
      outputId,
      userId,
      patch: { baseVersion: 1, slotValues: { kicker: 'Live', headline: null } },
    })
    expect(v2).toEqual({ ok: true, version: 2 })
    const detail = (await outputs.getOutputDetail(outputId))!
    expect(detail.version.slotValues).toEqual({ kicker: 'Live' })
    expect(detail.version.note).toBe('Edited Kicker, Headline')
    const stale = await outputs.addOutputVersion({
      outputId,
      userId,
      patch: { baseVersion: 1, slotValues: { kicker: 'Lost' } },
    })
    expect(stale).toMatchObject({ ok: false, status: 409, latest: 2 })
  })

  it('switches kit (no kit = house style) and restores an old version as a new one', async () => {
    const v3 = await outputs.addOutputVersion({
      outputId,
      userId,
      patch: { baseVersion: 2, kitId: null },
    })
    expect(v3).toEqual({ ok: true, version: 3 })
    expect((await outputs.getOutputDetail(outputId))!.version).toMatchObject({
      kitId: null,
      note: 'No kit',
    })
    const v4 = await outputs.addOutputVersion({
      outputId,
      userId,
      patch: { baseVersion: 3, restoreVersion: 1 },
    })
    expect(v4).toEqual({ ok: true, version: 4 })
    const restored = (await outputs.getOutputDetail(outputId))!
    expect(restored.version).toMatchObject({
      kitId,
      kitVersion: 1,
      note: 'Restored v1',
      slotValues: { headline: 'Hello <world>' },
    })
    expect(restored.versions.map((v) => v.version)).toEqual([4, 3, 2, 1])
  })

  it('composes the pinned version standalone, with the kit stylesheet', async () => {
    const doc = (await outputs.outputRenderDoc(outputId))!
    const composed = await outputs.composeDoc(doc)
    expect(composed.html).toContain('--kit-color-primary: #FF0066;')
    expect(composed.html).toContain('Hello &lt;world&gt;')
    expect(composed.html).not.toContain('/api/files/')
    const house = await outputs.composeDoc((await outputs.outputRenderDoc(outputId, 3))!)
    expect(house.html).toContain('--kit-color-accent: #FF5A36;')
  })

  it('serves renders with the document CSP, sandbox, framing and nosniff headers', async () => {
    const app = new Hono<{ Variables: { user: unknown; session: unknown } }>()
    app.use('*', async (c, next) => {
      c.set('user', c.req.header('x-test-anon') ? null : { id: userId })
      await next()
    })
    app.route('/outputs', routes.outputs)
    app.route('/output-shares', routes.outputShares)

    const res = await app.request(`/outputs/${outputId}/render?version=2`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const csp = res.headers.get('content-security-policy')!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).not.toContain('allow-same-origin')
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
    const body = await res.text()
    expect(body).toContain('<meta http-equiv="Content-Security-Policy"')
    expect(body).not.toContain('contenteditable')

    const edit = await app.request(`/outputs/${outputId}/render?edit=1`)
    expect(edit.headers.get('cache-control')).toBe('private, no-cache')
    expect(await edit.text()).toContain('plaintext-only')

    const dl = await app.request(`/outputs/${outputId}/render?download=1`)
    expect(dl.headers.get('content-disposition')).toBe(
      'attachment; filename="YouTube thumbnail.html"',
    )

    expect(
      (await app.request(`/outputs/${outputId}/render`, { headers: { 'x-test-anon': '1' } }))
        .status,
    ).toBe(401)

    // Share: public, pinned to the version at share time.
    const share = (await outputs.shareOutput(outputId, userId))!
    expect(share.version).toBe(4)
    const shared = await app.request(`/output-shares/${share.token}/render`, {
      headers: { 'x-test-anon': '1' },
    })
    expect(shared.status).toBe(200)
    expect(shared.headers.get('content-security-policy')).toContain('sandbox allow-scripts')
    expect(await shared.text()).toContain('Hello &lt;world&gt;')
    expect((await app.request(`/output-shares/nope/render`)).status).toBe(404)
  })

  it('moving a share keeps its token', async () => {
    const first = (await outputs.getOutputShare(outputId))!
    await outputs.addOutputVersion({
      outputId,
      userId,
      patch: { baseVersion: 4, slotValues: { tag: 'Ep. 13' } },
    })
    const moved = (await outputs.shareOutput(outputId, userId))!
    expect(moved).toMatchObject({ token: first.token, version: 5 })
    expect((await outputs.getSharedOutput(first.token))!.view.version).toBe(5)
  })

  it('places a live card on a board', async () => {
    const res = await outputs.placeOutputOnBoard({ outputId, boardId, userId })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.added.object).toMatchObject({
      type: 'output',
      size: { width: 360, height: 237 },
      data: { outputId, name: 'YouTube thumbnail', format: 'thumbnail', width: 1280, height: 720 },
    })
  })

  it('saves an output as a template with renamed / dropped / labelled slots', async () => {
    const doc = (await outputs.outputRenderDoc(outputId))!
    const { fillSlots, findSlots } = await import('@moodboard/shared')
    const html = templates.applySlotEdits(fillSlots(doc.html, doc.values), [
      { from: 'headline', to: 'title', label: 'Big title' },
      { from: 'tag', to: null },
    ])
    const t = await templates.createTemplate({
      name: 'Show thumbnail',
      format: 'thumbnail',
      viewport: { kind: 'fixed', width: 1280, height: 720 },
      clientId,
      html,
      css: doc.css,
      js: doc.js,
      userId,
    })
    createdTemplates.push(t.id)
    expect(t.slots.find((s) => s.name === 'title')).toEqual({
      name: 'title',
      kind: 'text',
      label: 'Big title',
    })
    expect(t.slots.some((s) => s.name === 'tag' || s.name === 'headline')).toBe(false)
    const title = findSlots(html).find((s) => s.name === 'title')!
    expect(title.defaultValue).toBe('Hello <world>')
    expect(await templates.deleteTemplate(thumbnailId)).toBe('starter')
  })

  it('agent tools create, read, edit and place outputs as versioned writes', async () => {
    const list = await tool('list_templates').run(ctx, { format: 'social' })
    expect(list.ok && (list.payload.templates as unknown[]).length).toBeGreaterThan(0)

    const created = await tool('create_output').run(ctx, {
      template: 'Social post',
      slots: { headline: 'Agent copy' },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const ref = created.payload.output as { id: string; client: string; kit: string }
    expect(ref).toMatchObject({ client: 'Outputs Co', kit: 'Main' })

    const read = await tool('get_output').run(ctx, { output: ref.id })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect((read.payload.document as { composedBytes: number }).composedBytes).toBeGreaterThan(1000)
    expect(read.payload.html).toBeUndefined()

    const edited = await tool('update_output_slots').run(ctx, {
      output: ref.id,
      slots: { cta: 'Shop now', headline: null },
    })
    expect(edited.ok && edited.payload.version).toBe(2)
    const stale = await tool('update_output_slots').run(ctx, {
      output: ref.id,
      slots: { cta: 'x' },
      baseVersion: 1,
    })
    expect(stale.ok).toBe(false)
    const bad = await tool('update_output_slots').run(ctx, {
      output: ref.id,
      slots: { image: 'javascript:alert(1)' },
    })
    expect(bad.ok).toBe(false)

    const placed = await tool('place_output_on_board').run(ctx, { output: ref.id, x: 0, y: 0 })
    expect(placed.ok).toBe(true)
    if (!placed.ok) return
    expect(placed.effects?.objects?.[0]?.object.type).toBe('output')
  })
})
