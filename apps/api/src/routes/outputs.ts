import {
  createOutputRequestSchema,
  createOutputVersionRequestSchema,
  createTemplateFromOutputRequestSchema,
  fillSlots,
  outputFormatSchema,
  placeOutputRequestSchema,
  updateOutputRequestSchema,
  updateTemplateRequestSchema,
} from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { clientExists } from '../lib/clients'
import { renderHeaders } from '../lib/compose'
import {
  addOutputVersion,
  composeDoc,
  createOutput,
  deleteOutput,
  downloadName,
  getOutputDetail,
  getOutputShare,
  getSharedOutput,
  listOutputs,
  outputRenderDoc,
  placeOutputOnBoard,
  shareOutput,
  templateRenderDoc,
  unshareOutput,
  updateOutput,
  type RenderDoc,
} from '../lib/outputs'
import { rateLimit } from '../lib/rateLimit'
import { slotProposer } from '../lib/designRuns'
import { removeOutputFrames, outputThumbnail } from '../lib/outputRender'
import { applySlotEdits } from '../lib/slotProposer'
import {
  createTemplate,
  deleteTemplate,
  getTemplateDetail,
  getTemplateSummary,
  listTemplates,
  updateTemplate,
} from '../lib/templates'

type Variables = { user: AuthUser | null; session: AuthSession | null }

const requireUser = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

// Documents are text but can be large (HTML up to 400k chars + CSS).
const docBodyLimit = bodyLimit({
  maxSize: 2 * 1024 * 1024,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
})

function versionParam(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

async function boardClientId(boardId: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ clientId: schema.board.clientId })
    .from(schema.board)
    .where(eq(schema.board.id, boardId))
    .limit(1)
  return row ? row.clientId : undefined
}

// One composed document out, with the CSP it enforces as a header too. A
// pinned version never changes; "latest" must be re-fetched every time.
async function serveDoc(
  c: Context,
  doc: RenderDoc,
  opts: { editable?: boolean; download?: boolean; immutable?: boolean },
) {
  const composed = await composeDoc(doc, { editable: opts.editable })
  const headers: Record<string, string> = {
    ...renderHeaders(composed.csp),
    'Cache-Control': opts.immutable ? 'private, max-age=3600' : 'private, no-cache',
  }
  if (opts.download) {
    headers['Content-Disposition'] = `attachment; filename="${downloadName(doc.title)}"`
  }
  if (composed.missingAssets.length > 0) {
    headers['X-Missing-Assets'] = composed.missingAssets.join(',')
  }
  return c.body(composed.html, 200, headers)
}

// ---------------------------------------------------------------------------
// /api/templates
// ---------------------------------------------------------------------------

export const templates = new Hono<{ Variables: Variables }>()
templates.use('*', requireUser)

templates.get('/', async (c) => {
  const format = outputFormatSchema.safeParse(c.req.query('format'))
  const clientId = c.req.query('client')
  return c.json({
    templates: await listTemplates({
      clientId: clientId || undefined,
      format: format.success ? format.data : undefined,
    }),
  })
})

templates.get('/:id', async (c) => {
  const version = versionParam(c.req.query('version'))
  if (version === null) return c.json({ error: 'Bad version' }, 400)
  const detail = await getTemplateDetail(c.req.param('id'), version)
  if (!detail) return c.json({ error: 'Not found' }, 404)
  return c.json(detail)
})

// A template with its default content, skinned with a kit (or the house
// kit) — the template picker's previews.
templates.get('/:id/render', async (c) => {
  const version = versionParam(c.req.query('version'))
  if (version === null) return c.json({ error: 'Bad version' }, 400)
  const doc = await templateRenderDoc(c.req.param('id'), {
    version,
    kitId: c.req.query('kit') || undefined,
  })
  if (!doc) return c.json({ error: 'Not found' }, 404)
  return serveDoc(c, doc, {})
})

// Save an output (a version of it) as a new template. The editor's slot
// edits are applied to the HTML; the output's filled values become the new
// template's defaults.
templates.post('/', docBodyLimit, async (c) => {
  const parsed = createTemplateFromOutputRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  )
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const req = parsed.data
  const detail = await getOutputDetail(req.outputId, req.version)
  if (!detail) return c.json({ error: 'Output not found' }, 404)
  if (req.clientId && !(await clientExists(req.clientId))) {
    return c.json({ error: 'Client not found' }, 404)
  }
  const doc = await outputRenderDoc(req.outputId, detail.version.version)
  if (!doc) return c.json({ error: 'Output not found' }, 404)
  const html = applySlotEdits(fillSlots(doc.html, doc.values), req.slots)
  const template = await createTemplate({
    name: req.name,
    format: req.format ?? detail.output.format,
    viewport: detail.output.viewport,
    clientId: req.clientId === undefined ? detail.output.clientId : req.clientId,
    html,
    css: doc.css,
    js: doc.js,
    note: `From output “${detail.output.name}” v${detail.version.version}`,
    userId: c.get('user')!.id,
  })
  return c.json({ template })
})

templates.patch('/:id', async (c) => {
  const parsed = updateTemplateRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  if (parsed.data.clientId && !(await clientExists(parsed.data.clientId))) {
    return c.json({ error: 'Client not found' }, 404)
  }
  const template = await updateTemplate(c.req.param('id'), parsed.data)
  if (!template) return c.json({ error: 'Not found' }, 404)
  return c.json({ template })
})

templates.delete('/:id', async (c) => {
  const result = await deleteTemplate(c.req.param('id'))
  if (result === 'not-found') return c.json({ error: 'Not found' }, 404)
  if (result === 'starter') return c.json({ error: 'Starter templates can’t be deleted' }, 400)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// /api/outputs
// ---------------------------------------------------------------------------

export const outputs = new Hono<{ Variables: Variables }>()
outputs.use('*', requireUser)

outputs.get('/', async (c) => {
  const client = c.req.query('client')
  return c.json({
    outputs: await listOutputs({
      clientId: client === 'none' ? null : client || undefined,
      boardId: c.req.query('board') || undefined,
    }),
  })
})

outputs.post('/', docBodyLimit, async (c) => {
  const parsed = createOutputRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const req = parsed.data
  const template = await getTemplateSummary(req.templateId)
  if (!template) return c.json({ error: 'Template not found' }, 404)
  let boardClient: string | null | undefined
  if (req.boardId) {
    boardClient = await boardClientId(req.boardId)
    if (boardClient === undefined) return c.json({ error: 'Board not found' }, 404)
  }
  const clientId =
    req.clientId !== undefined ? req.clientId : (boardClient ?? template.clientId ?? null)
  if (clientId && !(await clientExists(clientId))) {
    return c.json({ error: 'Client not found' }, 404)
  }
  const result = await createOutput({
    templateId: template.id,
    clientId,
    kitId: req.kitId ?? null,
    name: req.name,
    slotValues: req.slotValues,
    boardId: req.boardId ?? null,
    userId: c.get('user')!.id,
  })
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json({ output: result.output })
})

outputs.get('/:id', async (c) => {
  const version = versionParam(c.req.query('version'))
  if (version === null) return c.json({ error: 'Bad version' }, 400)
  const detail = await getOutputDetail(c.req.param('id'), version)
  if (!detail) return c.json({ error: 'Not found' }, 404)
  return c.json(detail)
})

// The markers save-as-template starts from: proposed over the document as
// it will be saved (values filled in), so candidate refs line up with the
// save below. A model pass when ANTHROPIC_API_KEY is set.
const proposeLimit = rateLimit({ scope: 'slot-proposer', limit: 20, windowMs: 60_000 })

outputs.get('/:id/proposed-slots', proposeLimit, async (c) => {
  const version = versionParam(c.req.query('version'))
  if (version === null) return c.json({ error: 'Bad version' }, 400)
  const doc = await outputRenderDoc(c.req.param('id') as string, version)
  if (!doc) return c.json({ error: 'Not found' }, 404)
  const html = fillSlots(doc.html, doc.values)
  return c.json({ slots: await slotProposer()({ html, css: doc.css }) })
})

outputs.post('/:id/versions', docBodyLimit, async (c) => {
  const parsed = createOutputVersionRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const id = c.req.param('id')
  const result = await addOutputVersion({
    outputId: id,
    patch: parsed.data,
    userId: c.get('user')!.id,
  })
  if (!result.ok) {
    return c.json(
      { error: result.error, ...(result.latest ? { latest: result.latest } : {}) },
      result.status,
    )
  }
  return c.json((await getOutputDetail(id, result.version))!)
})

outputs.patch('/:id', async (c) => {
  const parsed = updateOutputRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  if (parsed.data.clientId && !(await clientExists(parsed.data.clientId))) {
    return c.json({ error: 'Client not found' }, 404)
  }
  const output = await updateOutput(c.req.param('id'), parsed.data)
  if (!output) return c.json({ error: 'Not found' }, 404)
  return c.json({ output })
})

outputs.delete('/:id', async (c) => {
  if (!(await deleteOutput(c.req.param('id')))) return c.json({ error: 'Not found' }, 404)
  await removeOutputFrames(c.req.param('id') as string)
  return c.json({ ok: true })
})

// The rendered end-state frame (PNG) of a version — variant cards, Linear.
// Rendered once per version, then served from the volume.
const thumbnailLimit = rateLimit({ scope: 'output-thumbnail', limit: 120, windowMs: 60_000 })

outputs.get('/:id/thumbnail', thumbnailLimit, async (c) => {
  const version = versionParam(c.req.query('version'))
  if (version === null) return c.json({ error: 'Bad version' }, 400)
  const thumb = await outputThumbnail(c.req.param('id') as string, version).catch((e) => {
    console.error('thumbnail render failed', e)
    return undefined
  })
  if (thumb === undefined) return c.json({ error: 'Render failed' }, 500)
  if (!thumb) return c.json({ error: 'Not found' }, 404)
  return c.body(new Uint8Array(thumb.png), 200, {
    'Content-Type': 'image/png',
    'Cache-Control':
      version !== undefined ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
})

outputs.get('/:id/render', async (c) => {
  const version = versionParam(c.req.query('version'))
  if (version === null) return c.json({ error: 'Bad version' }, 400)
  const doc = await outputRenderDoc(c.req.param('id'), version)
  if (!doc) return c.json({ error: 'Not found' }, 404)
  return serveDoc(c, doc, {
    editable: c.req.query('edit') === '1',
    download: c.req.query('download') === '1',
    immutable: version !== undefined,
  })
})

outputs.post('/:id/place', async (c) => {
  const parsed = placeOutputRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const result = await placeOutputOnBoard({
    outputId: c.req.param('id'),
    boardId: parsed.data.boardId,
    userId: c.get('user')!.id,
    at: parsed.data.position,
  })
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json(result.added)
})

outputs.get('/:id/share', async (c) => {
  const share = await getOutputShare(c.req.param('id'))
  if (!share) return c.json({ error: 'Not found' }, 404)
  return c.json({ share })
})

// Create, or move the existing link to the latest version.
outputs.post('/:id/share', async (c) => {
  const share = await shareOutput(c.req.param('id'), c.get('user')!.id)
  if (!share) return c.json({ error: 'Not found' }, 404)
  return c.json({ share })
})

outputs.delete('/:id/share', async (c) => {
  if (!(await unshareOutput(c.req.param('id')))) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// /api/output-shares — public, token-gated
// ---------------------------------------------------------------------------

export const outputShares = new Hono<{ Variables: Variables }>()

const shareViewRateLimit = rateLimit({ scope: 'output-share-view', limit: 240, windowMs: 60_000 })

outputShares.get('/:token', shareViewRateLimit, async (c) => {
  const shared = await getSharedOutput(c.req.param('token') as string)
  if (!shared) return c.json({ error: 'Not found' }, 404)
  return c.json({ share: shared.view })
})

outputShares.get('/:token/render', shareViewRateLimit, async (c) => {
  const shared = await getSharedOutput(c.req.param('token') as string)
  if (!shared) return c.json({ error: 'Not found' }, 404)
  const doc = await outputRenderDoc(shared.outputId, shared.view.version)
  if (!doc) return c.json({ error: 'Not found' }, 404)
  return serveDoc(c, doc, { download: c.req.query('download') === '1' })
})
