import {
  type LinearIssueDetail,
  type LinearIssueSummary,
  type LinearMapping,
  type LinearView,
} from '@moodboard/shared'
import { desc, eq, and } from 'drizzle-orm'
import { db, schema } from '../db'
import { decryptToken, encryptToken } from './cryptoTokens'
import {
  LinearApiError,
  linearApi,
  linearEnv,
  mapIssueDetail,
  mapIssueSummary,
  parseIssueRef,
  tokenRequest,
  type FetchLike,
} from './linear'

// The signed-in user's Linear connection and everything that needs the
// database: token refresh, team/project ↔ client mappings, and the
// issue lookups the routes and the agent tool share.

type ConnectionRow = typeof schema.connection.$inferSelect

// Why Linear can't be used right now, in words that can go straight to a
// person (or the model).
export class LinearUnavailableError extends Error {
  constructor(
    public code: 'not-configured' | 'not-connected' | 'reconnect',
    message: string,
  ) {
    super(message)
    this.name = 'LinearUnavailableError'
  }
}

export async function getLinearConnection(userId: string): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(schema.connection)
    .where(and(eq(schema.connection.userId, userId), eq(schema.connection.provider, 'linear')))
    .orderBy(desc(schema.connection.createdAt))
    .limit(1)
  return row ?? null
}

// Same contract as drive.ts: refresh a minute early, persist the new token.
export async function getLinearToken(
  row: Pick<ConnectionRow, 'id' | 'accessTokenEnc' | 'refreshTokenEnc' | 'expiresAt'>,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const access = decryptToken(row.accessTokenEnc)
  const fresh = !row.expiresAt || row.expiresAt.getTime() - 60_000 > Date.now()
  if (fresh || !row.refreshTokenEnc) return access
  const env = linearEnv()
  if (!env)
    throw new LinearUnavailableError('not-configured', 'Linear isn’t configured on this server.')
  const refreshed = await tokenRequest(
    {
      grant_type: 'refresh_token',
      refresh_token: decryptToken(row.refreshTokenEnc),
      client_id: env.clientId,
      client_secret: env.clientSecret,
    },
    fetchImpl,
  )
  await db
    .update(schema.connection)
    .set({
      accessTokenEnc: encryptToken(refreshed.accessToken),
      // Linear rotates refresh tokens; keep the new one when it sends one.
      ...(refreshed.refreshToken ? { refreshTokenEnc: encryptToken(refreshed.refreshToken) } : {}),
      expiresAt: refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000) : null,
      lastUsedAt: new Date(),
    })
    .where(eq(schema.connection.id, row.id))
  return refreshed.accessToken
}

export async function listLinearMappings(): Promise<LinearMapping[]> {
  const rows = await db.select().from(schema.linearMapping)
  return rows.map((r) => ({
    kind: r.kind as LinearMapping['kind'],
    linearId: r.linearId,
    linearName: r.linearName,
    clientId: r.clientId,
  }))
}

// A ready API client for this user, or a LinearUnavailableError saying
// which step is missing.
export async function linearForUser(userId: string) {
  if (!linearEnv()) {
    throw new LinearUnavailableError(
      'not-configured',
      'Linear isn’t configured on this server (LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET / LINEAR_REDIRECT_URI).',
    )
  }
  const row = await getLinearConnection(userId)
  if (!row) {
    throw new LinearUnavailableError(
      'not-connected',
      'Linear isn’t connected. Connect it from the Sources drawer or Settings.',
    )
  }
  try {
    return linearApi(await getLinearToken(row))
  } catch (e) {
    if (e instanceof LinearApiError && (e.status === 400 || e.status === 401)) {
      throw new LinearUnavailableError(
        'reconnect',
        'The Linear connection has expired — reconnect it.',
      )
    }
    throw e
  }
}

// Authentication failures mid-request mean the same thing as a failed refresh.
function asUnavailable(e: unknown): never {
  if (e instanceof LinearApiError && e.status === 401) {
    throw new LinearUnavailableError(
      'reconnect',
      'The Linear connection has expired — reconnect it.',
    )
  }
  throw e
}

export async function listIssues(
  userId: string,
  opts: { query?: string; view?: LinearView },
): Promise<LinearIssueSummary[]> {
  const api = await linearForUser(userId)
  const mappings = await listLinearMappings()
  try {
    const query = opts.query?.trim() ?? ''
    if (query) {
      const ref = parseIssueRef(query)
      if (ref) {
        const issue = await api.issue(ref)
        if (issue) return [mapIssueSummary(issue, mappings)]
      }
      return (await api.search(query)).map((i) => mapIssueSummary(i, mappings))
    }
    const raw = opts.view === 'recent' ? await api.recent() : await api.assigned()
    return raw.map((i) => mapIssueSummary(i, mappings))
  } catch (e) {
    return asUnavailable(e)
  }
}

export async function getIssueDetail(
  userId: string,
  idOrIdentifier: string,
): Promise<LinearIssueDetail | null> {
  const api = await linearForUser(userId)
  const mappings = await listLinearMappings()
  try {
    const ref = parseIssueRef(idOrIdentifier) ?? idOrIdentifier
    const raw = await api.issue(ref)
    return raw ? mapIssueDetail(raw, mappings) : null
  } catch (e) {
    return asUnavailable(e)
  }
}

export async function clientNameFor(clientId: string | null): Promise<string | null> {
  if (!clientId) return null
  const [row] = await db
    .select({ name: schema.client.name })
    .from(schema.client)
    .where(eq(schema.client.id, clientId))
    .limit(1)
  return row?.name ?? null
}
