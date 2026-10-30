import type Anthropic from '@anthropic-ai/sdk'
import { kitTokensSchema } from '@moodboard/shared'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromiumAvailable } from './browser'
import type { ModelClient } from './orchestrator'
import { createFakeFigma, FAKE_FIGMA_ORIGIN, type FakeFigma } from './testing/fakeFigma'

// design_output with a Figma frame attached, end to end through the real
// tools — the frame imported from a stand-in Figma, the designer's
// get_figma_frame, the real renderer and the cache — with a scripted model.
// Needs DATABASE_URL and a Chromium; skipped otherwise.

const runnable = Boolean(process.env.DATABASE_URL) && chromiumAvailable()

type Params = Anthropic.MessageStreamParams

function designerModel() {
  const requests: Params[] = []
  const client: ModelClient = {
    async streamTurn(params) {
      requests.push(structuredClone(params))
      const prompt = params.messages[0]!.content as string
      const template = /Start from “(.+?)”/.exec(prompt)![1]!
      const turn = params.messages.filter((m) => m.role === 'assistant').length
      const script: { name: string; input: Record<string, unknown> }[] = [
        ...(prompt.includes('# Figma reference frames')
          ? [{ name: 'get_figma_frame', input: { frame: 'Hero' } }]
          : []),
        {
          name: 'create_output',
          input: { template, name: 'Hero-like', slots: { headline: 'Launch day.' } },
        },
        { name: 'render_output_frame', input: {} },
        { name: 'finish_variant', input: { name: 'Hero-like', critique: 'Follows the hero.' } },
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

describe.skipIf(!runnable)(
  'design_output with a Figma reference (real tools, scripted model)',
  () => {
    let dbMod: typeof import('../db')
    let tools: typeof import('./canvasTools')
    let closeBrowser: () => Promise<void>
    let figma: FakeFigma
    const savedEnv = { ...process.env }
    const userId = `u-${nanoid()}`
    const clientId = `c-${nanoid()}`
    const boardId = `b-${nanoid()}`
    const KEY = 'AbCdEfGhIjKlMnOpQrStUv'
    const FRAME_URL = `https://www.figma.com/design/${KEY}/Acme-Brand?node-id=12-34`
    const tool = (name: string) => tools.CANVAS_TOOLS.find((t) => t.name === name)!
    const brief = 'A card in the style of the hero. Calm, confident.'

    beforeAll(async () => {
      process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'mb-design-figma-'))
      process.env.CONNECTION_TOKEN_KEY ||= randomBytes(32).toString('hex')
      process.env.FIGMA_CLIENT_ID = 'cid'
      process.env.FIGMA_CLIENT_SECRET = 'csecret'
      process.env.FIGMA_REDIRECT_URI = 'http://localhost:5173/api/connections/figma/callback'
      process.env.FIGMA_API_BASE = FAKE_FIGMA_ORIGIN
      figma = createFakeFigma()
      vi.stubGlobal('fetch', figma.fetch)

      await (await import('./storage')).ensureDataDirs()
      dbMod = await import('../db')
      tools = await import('./canvasTools')
      closeBrowser = (await import('./browser')).closeBrowser
      const kits = await import('./kits')
      const templates = await import('./templates')
      const starters = await import('./starterTemplates')
      const { loadStarterTemplates } = await import('./starterTemplateFiles')
      const crypto = await import('./cryptoTokens')
      const { db, schema } = dbMod
      await db
        .insert(schema.user)
        .values({ id: userId, name: 'Fay', email: `${nanoid()}@team.com` })
      await db
        .insert(schema.client)
        .values({ id: clientId, name: `Acme ${nanoid(6)}`, slug: clientId })
      await db.insert(schema.board).values({ id: boardId, name: 'design figma', clientId })
      await db.insert(schema.connection).values({
        id: `conn-${nanoid()}`,
        userId,
        provider: 'figma',
        accountEmail: 'ada@acme.test',
        accessTokenEnc: crypto.encryptToken('figu_access_1'),
        refreshTokenEnc: crypto.encryptToken('figur_refresh_1'),
        expiresAt: new Date(Date.now() + 86_400_000),
        scopes: 'file_content:read',
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
        }),
      })
      await starters.syncStarterTemplates()
      // A template of the client's own, so a shared starter syncing in another
      // test file can't change this test's cache keys.
      const thumb = (await loadStarterTemplates()).find((t) => t.key === 'youtube-thumbnail')!
      await templates.createTemplate({
        name: 'Hero card',
        format: 'other',
        viewport: thumb.viewport,
        clientId,
        html: thumb.html,
        css: thumb.css,
        js: '',
        userId,
      })
      const imported = await tool('import_figma_frame').run({ boardId, userId }, { url: FRAME_URL })
      expect(imported.ok).toBe(true)
    })

    afterAll(async () => {
      vi.unstubAllGlobals()
      process.env = savedEnv
      const { eq } = await import('drizzle-orm')
      const { db, schema } = dbMod
      await db.delete(schema.designRun).where(eq(schema.designRun.clientId, clientId))
      await db.delete(schema.output).where(eq(schema.output.clientId, clientId))
      await db.delete(schema.template).where(eq(schema.template.clientId, clientId))
      await db.delete(schema.asset).where(eq(schema.asset.clientId, clientId))
      await db.delete(schema.board).where(eq(schema.board.id, boardId))
      await db.delete(schema.client).where(eq(schema.client.id, clientId))
      await db.delete(schema.connection).where(eq(schema.connection.userId, userId))
      await db.delete(schema.user).where(eq(schema.user.id, userId))
      await closeBrowser()
      await dbMod.pgClient.end()
    })

    const design = (model: ModelClient, input: Record<string, unknown> = {}) =>
      tool('design_output').run(
        { boardId, userId, model },
        { format: 'other', brief, variants: 1, ...input },
      )

    it('shows the designer the frame as a picture with its layer outline', async () => {
      const model = designerModel()
      const out = await design(model.client, { figmaFrames: ['Hero'] })
      expect(out.ok ? 'ok' : out.error).toBe('ok')
      if (!out.ok) return
      expect(out.payload.figmaFrames).toEqual(['Hero'])
      expect(out.payload.variants).toMatchObject([{ status: 'done' }])

      const prompt = model.requests[0]!.messages[0]!.content as string
      expect(prompt).toContain('# Figma reference frames')
      expect(prompt).toContain('“Hero” (Acme Brand) 1440×900')

      const afterLook = model.requests[1]!.messages.at(-1)!
        .content as Anthropic.ToolResultBlockParam[]
      const blocks = afterLook[0]!.content as Anthropic.ContentBlockParam[]
      expect(blocks[0]).toMatchObject({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png' },
      })
      const text = JSON.parse((blocks[1] as Anthropic.TextBlockParam).text) as {
        frame: string
        structure: string
      }
      expect(text.frame).toBe('Hero')
      expect(text.structure).toContain('vertical auto-layout, gap 24')
      expect(text.structure).toContain('Text “Launch day, the quiet way.”')
    })

    it('reuses the options for the same ask and frame, and re-runs once the frame changed', async () => {
      const same = designerModel()
      const reused = await design(same.client, { figmaFrames: ['Hero'] })
      expect(same.requests).toHaveLength(0)
      expect(reused.ok && reused.payload.cached).toBe(true)

      // Not attaching the frame is a different ask.
      const without = designerModel()
      const plain = await design(without.client)
      expect(without.requests.length).toBeGreaterThan(0)
      expect(plain.ok && plain.payload.figmaFrames).toEqual([])
      expect(without.requests[0]!.messages[0]!.content).not.toContain('Figma reference')

      // The file changed in Figma and the card was refreshed: a new key.
      figma.lastModified = '2026-05-01T12:00:00Z'
      const refreshed = await tool('import_figma_frame').run(
        { boardId, userId },
        { url: FRAME_URL },
      )
      expect(refreshed).toMatchObject({ ok: true, payload: { changed: true } })
      const after = designerModel()
      await design(after.client, { figmaFrames: ['Hero'] })
      expect(after.requests.length).toBeGreaterThan(0)
    })

    it('asks which frame when the name is wrong or ambiguous, before running anything', async () => {
      const model = designerModel()
      const out = await design(model.client, { figmaFrames: ['Footer'] })
      expect(out).toMatchObject({
        ok: false,
        error: expect.stringContaining('Frames on the board: “Hero”'),
      })
      expect(model.requests).toHaveLength(0)
    })
  },
)
