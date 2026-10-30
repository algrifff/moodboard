import {
  resolveIssueClientId,
  type LinearIssueDetail,
  type LinearIssueSummary,
  type LinearMapping,
  type LinearTeam,
} from '@moodboard/shared'
import { z } from 'zod'

// Linear over plain GraphQL + fetch (no SDK). Nothing here touches the
// database, so response mapping, issue references and the API client are
// tested against fixture responses with a fake fetch (linear.test.ts). The
// stored connection and token refresh live in linearConnection.ts.

export const LINEAR_API = 'https://api.linear.app/graphql'
export const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize'
export const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token'
// Read-only: picking an issue never writes back until Phase 24.
export const LINEAR_SCOPES = 'read'

export type FetchLike = typeof fetch

export class LinearApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'LinearApiError'
  }
}

export function linearEnv(): {
  clientId: string
  clientSecret: string
  redirectUri: string
} | null {
  const clientId = process.env.LINEAR_CLIENT_ID
  const clientSecret = process.env.LINEAR_CLIENT_SECRET
  const redirectUri = process.env.LINEAR_REDIRECT_URI
  return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : null
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const ISSUE_SUMMARY = `
fragment IssueSummary on Issue {
  id
  identifier
  title
  url
  priorityLabel
  updatedAt
  state { name type }
  assignee { name }
  team { id key name }
  project { id name }
}`

const Q_ASSIGNED = `${ISSUE_SUMMARY}
query AssignedIssues {
  viewer {
    assignedIssues(first: 25, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { ...IssueSummary }
    }
  }
}`

const Q_RECENT = `${ISSUE_SUMMARY}
query RecentIssues {
  issues(first: 25, orderBy: updatedAt) { nodes { ...IssueSummary } }
}`

const Q_SEARCH = `${ISSUE_SUMMARY}
query SearchIssues($term: String!) {
  searchIssues(term: $term, first: 25) { nodes { ...IssueSummary } }
}`

const Q_ISSUE = `${ISSUE_SUMMARY}
query IssueDetail($id: String!) {
  issue(id: $id) {
    ...IssueSummary
    description
    labels { nodes { name } }
    comments(first: 50) { nodes { id body createdAt user { name } } }
    attachments(first: 25) { nodes { id title subtitle url sourceType } }
  }
}`

const Q_TEAMS = `
query Teams {
  teams(first: 100) {
    nodes { id key name projects(first: 100) { nodes { id name } } }
  }
}`

const Q_VIEWER = `
query Viewer {
  viewer { id name email }
  organization { id name }
}`

// ---------------------------------------------------------------------------
// Raw response shapes (only what we read; everything else is ignored)
// ---------------------------------------------------------------------------

const rawIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  priorityLabel: z.string().nullish(),
  updatedAt: z.string(),
  state: z.object({ name: z.string(), type: z.string().nullish() }).nullish(),
  assignee: z.object({ name: z.string() }).nullish(),
  team: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  project: z.object({ id: z.string(), name: z.string() }).nullish(),
})
type RawIssue = z.infer<typeof rawIssueSchema>

const rawDetailSchema = rawIssueSchema.extend({
  description: z.string().nullish(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullish(),
  comments: z
    .object({
      nodes: z.array(
        z.object({
          id: z.string(),
          body: z.string().nullish(),
          createdAt: z.string(),
          user: z.object({ name: z.string() }).nullish(),
        }),
      ),
    })
    .nullish(),
  attachments: z
    .object({
      nodes: z.array(
        z.object({
          id: z.string(),
          title: z.string().nullish(),
          subtitle: z.string().nullish(),
          url: z.string(),
          sourceType: z.string().nullish(),
        }),
      ),
    })
    .nullish(),
})

type ClientMapping = Pick<LinearMapping, 'kind' | 'linearId' | 'clientId'>

export function mapIssueSummary(raw: RawIssue, mappings: ClientMapping[]): LinearIssueSummary {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    url: raw.url,
    stateName: raw.state?.name ?? 'Unknown',
    priorityLabel: raw.priorityLabel ?? 'No priority',
    assigneeName: raw.assignee?.name ?? null,
    teamId: raw.team.id,
    teamKey: raw.team.key,
    teamName: raw.team.name,
    projectId: raw.project?.id ?? null,
    projectName: raw.project?.name ?? null,
    updatedAt: raw.updatedAt,
    clientId: resolveIssueClientId(mappings, {
      teamId: raw.team.id,
      projectId: raw.project?.id ?? null,
    }),
  }
}

export function mapIssueDetail(
  raw: z.infer<typeof rawDetailSchema>,
  mappings: ClientMapping[],
): LinearIssueDetail {
  return {
    ...mapIssueSummary(raw, mappings),
    description: raw.description ?? '',
    labels: (raw.labels?.nodes ?? []).map((l) => l.name),
    comments: (raw.comments?.nodes ?? [])
      .map((c) => ({
        id: c.id,
        author: c.user?.name ?? 'Someone',
        body: c.body ?? '',
        createdAt: c.createdAt,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    attachments: (raw.attachments?.nodes ?? []).map((a) => ({
      id: a.id,
      title: a.title ?? '',
      subtitle: a.subtitle ?? '',
      url: a.url,
      sourceType: a.sourceType ?? null,
    })),
  }
}

// "LIN-123", "lin-123", or a linear.app issue URL → "LIN-123". Anything else
// is a free-text search.
export function parseIssueRef(input: string): string | null {
  const text = input.trim()
  const fromUrl = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/.exec(text)
  const m = fromUrl ?? /^([A-Za-z][A-Za-z0-9]*-\d+)$/.exec(text)
  return m ? m[1]!.toUpperCase() : null
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const gqlResponseSchema = z.object({
  data: z.unknown().nullish(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        extensions: z.object({ type: z.string().nullish() }).passthrough().nullish(),
      }),
    )
    .nullish(),
})

export async function linearGraphQL(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const res = await fetchImpl(LINEAR_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = gqlResponseSchema.safeParse(await res.json().catch(() => null))
  const errors = body.success ? (body.data.errors ?? []) : []
  if (res.status === 401 || errors.some((e) => /authentication/i.test(e.extensions?.type ?? ''))) {
    throw new LinearApiError(401, errors[0]?.message ?? 'Linear rejected the credentials')
  }
  if (!res.ok || errors.length > 0) {
    throw new LinearApiError(
      res.ok ? 502 : res.status,
      errors.map((e) => e.message).join('; ') || res.statusText || 'Linear request failed',
    )
  }
  if (!body.success || body.data.data == null)
    throw new LinearApiError(502, 'Empty response from Linear')
  return body.data.data
}

function nodes(data: unknown, path: string[]): unknown[] {
  let cur: unknown = data
  for (const key of path) cur = (cur as Record<string, unknown> | null | undefined)?.[key]
  const list = (cur as { nodes?: unknown } | null | undefined)?.nodes
  if (!Array.isArray(list)) throw new LinearApiError(502, 'Unexpected response from Linear')
  return list
}

function parseIssues(list: unknown[]): RawIssue[] {
  return list.map((n) => {
    const parsed = rawIssueSchema.safeParse(n)
    if (!parsed.success) throw new LinearApiError(502, 'Unexpected issue shape from Linear')
    return parsed.data
  })
}

export function linearApi(token: string, fetchImpl: FetchLike = fetch) {
  const run = (query: string, variables?: Record<string, unknown>) =>
    linearGraphQL(token, query, variables, fetchImpl)
  return {
    async viewer(): Promise<{
      id: string
      name: string
      email: string
      workspace: { id: string; name: string }
    }> {
      const data = (await run(Q_VIEWER)) as {
        viewer?: { id: string; name: string; email: string }
        organization?: { id: string; name: string }
      }
      if (!data.viewer || !data.organization)
        throw new LinearApiError(502, 'Unexpected viewer response')
      return { ...data.viewer, workspace: data.organization }
    },
    async assigned(): Promise<RawIssue[]> {
      return parseIssues(nodes(await run(Q_ASSIGNED), ['viewer', 'assignedIssues']))
    },
    async recent(): Promise<RawIssue[]> {
      return parseIssues(nodes(await run(Q_RECENT), ['issues']))
    },
    async search(term: string): Promise<RawIssue[]> {
      return parseIssues(nodes(await run(Q_SEARCH, { term }), ['searchIssues']))
    },
    async issue(idOrIdentifier: string): Promise<z.infer<typeof rawDetailSchema> | null> {
      let data: { issue?: unknown }
      try {
        data = (await run(Q_ISSUE, { id: idOrIdentifier })) as { issue?: unknown }
      } catch (e) {
        // Linear answers a missing issue with a GraphQL "not found" error.
        if (e instanceof LinearApiError && /not found|entity not found/i.test(e.message))
          return null
        throw e
      }
      if (!data.issue) return null
      const parsed = rawDetailSchema.safeParse(data.issue)
      if (!parsed.success) throw new LinearApiError(502, 'Unexpected issue shape from Linear')
      return parsed.data
    },
    async teams(): Promise<LinearTeam[]> {
      return nodes(await run(Q_TEAMS), ['teams']).map((n) => {
        const t = n as {
          id: string
          key: string
          name: string
          projects?: { nodes?: { id: string; name: string }[] }
        }
        return {
          id: t.id,
          key: t.key,
          name: t.name,
          projects: (t.projects?.nodes ?? []).map((p) => ({ id: p.id, name: p.name })),
        }
      })
    },
  }
}

// ---------------------------------------------------------------------------
// OAuth + stored connection
// ---------------------------------------------------------------------------

export type LinearTokenResponse = {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  scope?: string
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
})

export async function tokenRequest(
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<LinearTokenResponse> {
  const res = await fetchImpl(LINEAR_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText)
    throw new LinearApiError(res.status, `Linear token request failed: ${detail}`)
  }
  const parsed = tokenResponseSchema.safeParse(await res.json().catch(() => null))
  if (!parsed.success) throw new LinearApiError(502, 'Unexpected token response from Linear')
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresIn: parsed.data.expires_in,
    scope: parsed.data.scope,
  }
}

export function exchangeLinearCode(
  args: { code: string; clientId: string; clientSecret: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
): Promise<LinearTokenResponse> {
  return tokenRequest(
    {
      grant_type: 'authorization_code',
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
    },
    fetchImpl,
  )
}
