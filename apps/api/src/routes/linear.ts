import {
  linearViewSchema,
  putLinearMappingRequestSchema,
  type LinearStatus,
} from '@moodboard/shared'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { clientExists } from '../lib/clients'
import { LinearApiError, linearEnv } from '../lib/linear'
import {
  clientNameFor,
  getIssueDetail,
  getLinearConnection,
  linearForUser,
  LinearUnavailableError,
  listIssues,
  listLinearMappings,
} from '../lib/linearConnection'
import { rateLimit } from '../lib/rateLimit'

type Variables = { user: AuthUser | null; session: AuthSession | null }

// Linear as the brief source. Everything here acts as the signed-in user's
// own Linear connection; the team/project ↔ client mapping is team-wide.
export const linear = new Hono<{ Variables: Variables }>()

linear.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

const linearLimit = rateLimit({ scope: 'linear', limit: 40, windowMs: 60_000 })

// 409 for "set up / reconnect Linear first" (the UI shows a prompt, not an
// error), 502 when Linear itself misbehaves.
function linearError(c: Context, e: unknown) {
  if (e instanceof LinearUnavailableError) return c.json({ error: e.message, code: e.code }, 409)
  if (e instanceof LinearApiError) {
    console.warn('[linear] api error', e.status, e.message)
    return c.json({ error: `Linear: ${e.message}` }, 502)
  }
  throw e
}

linear.get('/status', async (c) => {
  const row = await getLinearConnection(c.get('user')!.id)
  const status: LinearStatus = {
    configured: linearEnv() !== null,
    connection: row
      ? { id: row.id, accountEmail: row.accountEmail, workspaceName: row.workspaceName }
      : null,
  }
  return c.json(status)
})

linear.get('/issues', linearLimit, async (c) => {
  const view = linearViewSchema.catch('assigned').parse(c.req.query('view'))
  const query = c.req.query('q')?.slice(0, 200)
  try {
    return c.json({ issues: await listIssues(c.get('user')!.id, { query, view }) })
  } catch (e) {
    return linearError(c, e)
  }
})

linear.get('/issues/:ref', linearLimit, async (c) => {
  try {
    const issue = await getIssueDetail(c.get('user')!.id, c.req.param('ref') as string)
    if (!issue) return c.json({ error: 'Issue not found' }, 404)
    return c.json({ issue, clientName: await clientNameFor(issue.clientId) })
  } catch (e) {
    return linearError(c, e)
  }
})

// Saved mappings, plus the viewer's live teams/projects to map. `teams` is
// null when Linear can't be reached so saved mappings still show.
linear.get('/mappings', linearLimit, async (c) => {
  const mappings = await listLinearMappings()
  let teams = null
  try {
    teams = await (await linearForUser(c.get('user')!.id)).teams()
  } catch (e) {
    if (!(e instanceof LinearUnavailableError || e instanceof LinearApiError)) throw e
  }
  return c.json({ mappings, teams })
})

linear.put('/mappings', async (c) => {
  const parsed = putLinearMappingRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const { kind, linearId, linearName, clientId } = parsed.data
  const key = and(eq(schema.linearMapping.kind, kind), eq(schema.linearMapping.linearId, linearId))
  if (clientId === null) {
    await db.delete(schema.linearMapping).where(key)
  } else {
    if (!(await clientExists(clientId))) return c.json({ error: 'Client not found' }, 404)
    await db
      .insert(schema.linearMapping)
      .values({
        id: nanoid(),
        kind,
        linearId,
        linearName,
        clientId,
        createdBy: c.get('user')!.id,
      })
      .onConflictDoUpdate({
        target: [schema.linearMapping.kind, schema.linearMapping.linearId],
        set: { clientId, linearName },
      })
  }
  return c.json({ mappings: await listLinearMappings() })
})
