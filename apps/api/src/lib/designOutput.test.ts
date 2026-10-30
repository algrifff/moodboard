import type Anthropic from '@anthropic-ai/sdk'
import { kitTokensSchema, type DesignProgress } from '@moodboard/shared'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromiumAvailable } from './browser'
import type { ModelClient } from './orchestrator'

// design_output end to end through the real tools — outputs in Postgres,
// frames from the real renderer, the design_run row and the cache — with a
// scripted model. Needs DATABASE_URL and a Chromium; skipped otherwise.

const runnable = Boolean(process.env.DATABASE_URL) && chromiumAvailable()

type Params = Anthropic.MessageStreamParams

// Builds, renders, (option 2 also tweaks its CSS and re-renders), finishes.
function designerModel() {
  const requests: Params[] = []
  const client: ModelClient = {
    async streamTurn(params) {
      requests.push(params)
      const prompt = params.messages[0]!.content as string
      const option = Number(/option (\d) of/.exec(prompt)![1])
      const template = /Start from “(.+?)”/.exec(prompt)![1]!
      const turn = params.messages.filter((m) => m.role === 'assistant').length
      const script: { name: string; input: Record<string, unknown> }[] = [
        {
          name: 'create_output',
          input: {
            template,
            name: `Launch ${option}`,
            slots: { headline: `Liftoff ${option}`, kicker: 'Launch', tag: 'Out now' },
          },
        },
        { name: 'render_output_frame', input: {} },
        ...(option === 2
          ? [
              {
                name: 'update_output_html',
                input: { css: [{ find: '.thumb {', replace: '.thumb { outline: 0;' }] },
              },
              { name: 'render_output_frame', input: {} },
            ]
          : []),
        { name: 'finish_variant', input: { name: `Launch ${option}`, critique: 'Reads fast.' } },
      ]
      const step = script[Math.min(turn, script.length - 1)]!
      return {
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'fake',
        content: [{ type: 'tool_use', id: `tu_${nanoid()}`, name: step.name, input: step.input }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      } as unknown as Anthropic.Message
    },
  }
  return { client, requests }
}

describe.skipIf(!runnable)('design_output (real tools, scripted model)', () => {
  let dbMod: typeof import('../db')
  let tools: typeof import('./canvasTools')
  let runs: typeof import('./designRuns')
  let closeBrowser: () => Promise<void>
  const userId = `u-${nanoid()}`
  const clientId = `c-${nanoid()}`
  const boardId = `b-${nanoid()}`
  const clientName = `Acme ${nanoid(6)}`
  const assetFile = `${nanoid()}.png`
  let dataDir = ''

  const tool = (name: string) => tools.CANVAS_TOOLS.find((t) => t.name === name)!

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'mb-design-'))
    process.env.DATA_DIR = dataDir
    dbMod = await import('../db')
    tools = await import('./canvasTools')
    runs = await import('./designRuns')
    closeBrowser = (await import('./browser')).closeBrowser
    const kits = await import('./kits')
    const starters = await import('./starterTemplates')
    const { db, schema } = dbMod
    await db.insert(schema.user).values({ id: userId, name: 'Dee', email: `${nanoid()}@team.com` })
    await db.insert(schema.client).values({ id: clientId, name: clientName, slug: clientId })
    await db.insert(schema.board).values({ id: boardId, name: 'design test', clientId })
    await db.insert(schema.asset).values({
      id: `a-${nanoid()}`,
      filename: assetFile,
      mimeType: 'image/png',
      size: 10,
      kind: 'upload',
      mediaKind: 'image',
      clientId,
      enrichedAt: new Date(),
    })
    await kits.createKit({
      clientId,
      name: 'Night',
      userId,
      tokens: kitTokensSchema.parse({
        palette: [
          { role: 'background', hex: '#0B0B0F' },
          { role: 'text', hex: '#F4F1EA' },
          { role: 'primary', hex: '#E4572E' },
        ],
        voice: { donts: ['No exclamation marks'] },
      }),
    })
    await starters.syncStarterTemplates()
  })

  afterAll(async () => {
    const { eq } = await import('drizzle-orm')
    const { db, schema } = dbMod
    await db.delete(schema.designRun).where(eq(schema.designRun.clientId, clientId))
    await db.delete(schema.output).where(eq(schema.output.clientId, clientId))
    await db.delete(schema.asset).where(eq(schema.asset.clientId, clientId))
    await db.delete(schema.board).where(eq(schema.board.id, boardId))
    await db.delete(schema.client).where(eq(schema.client.id, clientId))
    await db.delete(schema.user).where(eq(schema.user.id, userId))
    await closeBrowser()
    await dbMod.pgClient.end()
  })

  const brief = 'Thumbnail for the launch video. Punchy, dark.'
  let firstRun: { runId: string; variants: { outputId: string; version: number }[] }

  it('makes three rendered options, records the run, and streams progress', async () => {
    const model = designerModel()
    const progress: DesignProgress[] = []
    const outcome = await tool('design_output').run(
      { boardId, userId, model: model.client, onProgress: (p) => progress.push(p) },
      { format: 'thumbnail', brief, linearIssue: 'lin-123' },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const payload = outcome.payload as unknown as {
      runId: string
      linearIssue: string
      kit: string
      variants: {
        status: string
        outputId: string
        version: number
        renders: number
        thumbnailUrl: string
      }[]
    }
    expect(outcome.payload.summary).toBe(`3 thumbnail options for ${clientName}`)
    expect(payload.kit).toBe('Night v1')
    expect(payload.linearIssue).toBe('LIN-123')
    expect(payload.variants.map((v) => [v.status, v.version, v.renders])).toEqual([
      ['done', 1, 1],
      ['done', 2, 2],
      ['done', 1, 1],
    ])
    for (const v of payload.variants) {
      expect(existsSync(path.join(dataDir, 'outputs', `${v.outputId}@v${v.version}.png`))).toBe(
        true,
      )
      expect(v.thumbnailUrl).toBe(`/api/outputs/${v.outputId}/thumbnail?version=${v.version}`)
    }
    // The model saw its renders; the kit's don'ts were in its brief.
    const sawImage = model.requests.some((r) =>
      r.messages.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some(
            (b) =>
              b.type === 'tool_result' &&
              Array.isArray(b.content) &&
              b.content.some((c) => c.type === 'image'),
          ),
      ),
    )
    expect(sawImage).toBe(true)
    expect(model.requests[0]!.messages[0]!.content).toContain('No exclamation marks')
    expect(new Set(progress.map((p) => p.stage))).toEqual(
      new Set(['queued', 'template', 'filling', 'rendering', 'critique', 'revising', 'done']),
    )

    const run = (await runs.getDesignRun(payload.runId))!
    expect(run).toMatchObject({ format: 'thumbnail', linearIssue: 'LIN-123', chosenOutputId: null })
    expect(run.variants).toHaveLength(3)
    firstRun = payload
  })

  it('reuses the options for an identical brief without calling the model', async () => {
    const model = designerModel()
    const outcome = await tool('design_output').run(
      { boardId, userId, model: model.client },
      { format: 'thumbnail', brief: `  ${brief} `, linearIssue: 'LIN-123' },
    )
    expect(model.requests).toHaveLength(0)
    expect(outcome.ok && outcome.payload.cached).toBe(true)
    const ids = outcome.ok
      ? (outcome.payload.variants as { outputId: string }[]).map((v) => v.outputId)
      : []
    expect(ids).toEqual(firstRun.variants.map((v) => v.outputId))

    const fresh = designerModel()
    const again = await tool('design_output').run(
      { boardId, userId, model: fresh.client },
      { format: 'thumbnail', brief, variants: 1, regenerate: true },
    )
    expect(again.ok).toBe(true)
    expect(fresh.requests.length).toBeGreaterThan(0)
  })

  it('only lets a picked option go to Linear', async () => {
    const [first, second] = firstRun.variants
    const post = (output: string) =>
      tool('post_linear_comment').run({ boardId, userId }, { output })
    expect(await post(first!.outputId)).toEqual({
      ok: false,
      error: expect.stringMatching(/Nothing has been picked yet/),
    })
    const picked = await tool('pick_design_variant').run(
      { boardId, userId },
      { output: second!.outputId },
    )
    expect(picked.ok).toBe(true)
    expect(await post(first!.outputId)).toEqual({
      ok: false,
      error: expect.stringMatching(/wasn’t the one picked/),
    })
    // Past the gate, the user's Linear connection is the next requirement.
    const linear = await post(second!.outputId)
    expect(linear.ok).toBe(false)
    expect(!linear.ok && linear.error).toMatch(/Linear/)
  })

  it('says what is missing instead of guessing', async () => {
    const outcome = await tool('design_output').run(
      { boardId, userId, model: designerModel().client },
      { format: 'thumbnail', brief, client: 'Nobody Inc' },
    )
    expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/No client matches/) })
  })

  it('edits output HTML/CSS as plain text, within the document rules', async () => {
    const output = firstRun.variants[0]!.outputId
    const edit = (input: Record<string, unknown>) =>
      tool('update_output_html').run({ boardId, userId }, { output, ...input })
    expect(
      await edit({
        html: [
          { find: '<main class="thumb">', replace: '<main class="thumb"><script>x()</script>' },
        ],
      }),
    ).toEqual({ ok: false, error: expect.stringMatching(/No <script>/) })
    expect(await edit({ css: [{ find: 'nowhere-at-all', replace: 'x' }] })).toEqual({
      ok: false,
      error: expect.stringMatching(/isn’t in the document/),
    })
    const ok = await edit({ css: [{ find: '.thumb {', replace: '.thumb { outline: 0;' }] })
    expect(ok.ok && ok.payload.version).toBe(2)
  })

  it('lays a library asset out on the board', async () => {
    const outcome = await tool('add_asset_to_board').run(
      { boardId, userId },
      { asset: `/api/files/${assetFile}` },
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.effects?.objects?.[0]?.object).toMatchObject({
        type: 'image',
        data: { url: `/api/files/${assetFile}` },
      })
    }
  })
})
