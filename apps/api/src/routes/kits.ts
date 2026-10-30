import {
  createKitRequestSchema,
  createKitVersionRequestSchema,
  emptyKitTokens,
  updateKitRequestSchema,
} from '@moodboard/shared'
import { Hono } from 'hono'
import type { AuthSession, AuthUser } from '../auth'
import { clientExists } from '../lib/clients'
import {
  addKitVersion,
  createKit,
  deleteKit,
  getKitCss,
  getKitDetail,
  listKits,
  updateKit,
} from '../lib/kits'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const kits = new Hono<{ Variables: Variables }>()

kits.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

kits.get('/', async (c) => {
  const clientId = c.req.query('client')
  return c.json({ kits: await listKits(clientId ? { clientId } : {}) })
})

kits.post('/', async (c) => {
  const parsed = createKitRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const { clientId, name, tokens, note } = parsed.data
  if (!(await clientExists(clientId))) return c.json({ error: 'Client not found' }, 404)
  const kit = await createKit({
    clientId,
    name,
    tokens: tokens ?? emptyKitTokens(),
    note,
    userId: c.get('user')!.id,
  })
  return c.json({ kit })
})

function versionParam(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

kits.get('/:id', async (c) => {
  const version = versionParam(c.req.query('version'))
  if (version === null) return c.json({ error: 'Bad version' }, 400)
  const detail = await getKitDetail(c.req.param('id'), version)
  if (!detail) return c.json({ error: 'Not found' }, 404)
  return c.json(detail)
})

// The compiled --kit-* stylesheet for a version (default: latest).
kits.get('/:id/css', async (c) => {
  const version = versionParam(c.req.query('version'))
  if (version === null) return c.json({ error: 'Bad version' }, 400)
  const css = await getKitCss(c.req.param('id'), version)
  if (css === null) return c.json({ error: 'Not found' }, 404)
  return c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8' })
})

kits.patch('/:id', async (c) => {
  const parsed = updateKitRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  if (parsed.data.clientId && !(await clientExists(parsed.data.clientId))) {
    return c.json({ error: 'Client not found' }, 404)
  }
  const kit = await updateKit(c.req.param('id'), parsed.data)
  if (!kit) return c.json({ error: 'Not found' }, 404)
  return c.json({ kit })
})

kits.post('/:id/versions', async (c) => {
  const parsed = createKitVersionRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const id = c.req.param('id')
  const result = await addKitVersion({
    kitId: id,
    tokens: parsed.data.tokens,
    note: parsed.data.note,
    baseVersion: parsed.data.baseVersion,
    userId: c.get('user')!.id,
  })
  if (!result.ok) {
    if (result.reason === 'not-found') return c.json({ error: 'Not found' }, 404)
    return c.json(
      { error: 'A teammate saved a newer version while you were editing', latest: result.latest },
      409,
    )
  }
  return c.json((await getKitDetail(id, result.version))!)
})

kits.delete('/:id', async (c) => {
  if (!(await deleteKit(c.req.param('id')))) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})
