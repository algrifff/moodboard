import { createClientRequestSchema, updateClientRequestSchema } from '@moodboard/shared'
import { Hono } from 'hono'
import type { AuthSession, AuthUser } from '../auth'
import { createClient, deleteClient, getClient, listClients, renameClient } from '../lib/clients'

type Variables = { user: AuthUser | null; session: AuthSession | null }

// Clients are team-wide: anyone signed in can list, create, rename and
// delete them.
export const clients = new Hono<{ Variables: Variables }>()

clients.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

clients.get('/', async (c) => c.json({ clients: await listClients() }))

clients.post('/', async (c) => {
  const parsed = createClientRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  return c.json({ client: await createClient(parsed.data.name, c.get('user')!.id) })
})

clients.patch('/:id', async (c) => {
  const parsed = updateClientRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const client = await renameClient(c.req.param('id'), parsed.data.name)
  if (!client) return c.json({ error: 'Not found' }, 404)
  return c.json({ client })
})

// Boards and library assets keep existing, unassigned; the client's kits
// and Linear mappings go with it.
clients.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!(await getClient(id))) return c.json({ error: 'Not found' }, 404)
  await deleteClient(id)
  return c.json({ ok: true })
})
