import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { decryptToken, encryptToken } from './cryptoTokens'
import {
  FigmaApiError,
  figmaApi,
  figmaEnv,
  refreshFigmaToken,
  type FetchLike,
  type FigmaApi,
} from './figma'

// The signed-in user's Figma connection: the stored (encrypted) token, its
// refresh, and the "why can't I use Figma right now" errors the routes and
// agent tools turn into words. The connection is personal; what it reads is
// whatever that person's Figma account can open.

type ConnectionRow = typeof schema.connection.$inferSelect

export class FigmaUnavailableError extends Error {
  constructor(
    public code: 'not-configured' | 'not-connected' | 'reconnect',
    message: string,
  ) {
    super(message)
    this.name = 'FigmaUnavailableError'
  }
}

export const FIGMA_NOT_CONFIGURED =
  'Figma isn’t configured on this server (FIGMA_CLIENT_ID / FIGMA_CLIENT_SECRET / FIGMA_REDIRECT_URI).'
export const FIGMA_NOT_CONNECTED =
  'Figma isn’t connected. Connect it from the Sources drawer or Settings.'
const RECONNECT = 'The Figma connection has expired — reconnect it.'

export async function getFigmaConnection(userId: string): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(schema.connection)
    .where(and(eq(schema.connection.userId, userId), eq(schema.connection.provider, 'figma')))
    .orderBy(desc(schema.connection.createdAt))
    .limit(1)
  return row ?? null
}

// Same contract as drive.ts and linear: refresh a minute early and persist
// the new token. Figma's refresh answers with an access token only, so the
// stored refresh token is kept.
export async function getFigmaToken(
  row: Pick<ConnectionRow, 'id' | 'accessTokenEnc' | 'refreshTokenEnc' | 'expiresAt'>,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const access = decryptToken(row.accessTokenEnc)
  const fresh = !row.expiresAt || row.expiresAt.getTime() - 60_000 > Date.now()
  if (fresh) return access
  if (!row.refreshTokenEnc) throw new FigmaUnavailableError('reconnect', RECONNECT)
  const env = figmaEnv()
  if (!env) throw new FigmaUnavailableError('not-configured', FIGMA_NOT_CONFIGURED)
  let refreshed
  try {
    refreshed = await refreshFigmaToken(
      {
        refreshToken: decryptToken(row.refreshTokenEnc),
        clientId: env.clientId,
        clientSecret: env.clientSecret,
      },
      fetchImpl,
    )
  } catch (e) {
    if (e instanceof FigmaApiError && (e.status === 400 || e.status === 401 || e.status === 403)) {
      throw new FigmaUnavailableError('reconnect', RECONNECT)
    }
    throw e
  }
  await db
    .update(schema.connection)
    .set({
      accessTokenEnc: encryptToken(refreshed.accessToken),
      ...(refreshed.refreshToken ? { refreshTokenEnc: encryptToken(refreshed.refreshToken) } : {}),
      expiresAt: refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000) : null,
      lastUsedAt: new Date(),
    })
    .where(eq(schema.connection.id, row.id))
  return refreshed.accessToken
}

// A ready API client for this user, or a FigmaUnavailableError saying which
// step is missing.
export async function figmaForUser(
  userId: string,
  fetchImpl: FetchLike = fetch,
): Promise<FigmaApi> {
  if (!figmaEnv()) throw new FigmaUnavailableError('not-configured', FIGMA_NOT_CONFIGURED)
  const row = await getFigmaConnection(userId)
  if (!row) throw new FigmaUnavailableError('not-connected', FIGMA_NOT_CONNECTED)
  return figmaApi(await getFigmaToken(row, fetchImpl), fetchImpl)
}

// A token Figma rejects mid-request means the same as a failed refresh. A 403
// about the file ("no access") is the person's problem, not the connection's.
export function isTokenRejection(e: unknown): boolean {
  return (
    e instanceof FigmaApiError &&
    (e.status === 401 || (e.status === 403 && /token/i.test(e.message)))
  )
}

export function asUnavailable(e: unknown): never {
  if (isTokenRejection(e)) throw new FigmaUnavailableError('reconnect', RECONNECT)
  throw e
}
