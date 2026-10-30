import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  exchangeLinearCode,
  LinearApiError,
  linearApi,
  linearGraphQL,
  mapIssueDetail,
  mapIssueSummary,
  parseIssueRef,
  type FetchLike,
} from './linear'

// Hand-built in the shape Linear's GraphQL API returns (see the schema at
// https://studio.apollographql.com/public/Linear-API/variant/current/schema).
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/linear/${name}.json`, import.meta.url), 'utf8'))

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> | string }

function fakeFetch(reply: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = []
  const impl = (async (url: string, init: RequestInit) => {
    const raw = String(init.body)
    let body: Call['body']
    try {
      body = JSON.parse(raw)
    } catch {
      body = raw
    }
    const call = { url, headers: init.headers as Record<string, string>, body }
    calls.push(call)
    const { status = 200, json } = reply(call)
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchLike
  return { impl, calls }
}

const mappings = [
  { kind: 'team' as const, linearId: 'team-launch', clientId: 'client-globex' },
  { kind: 'project' as const, linearId: 'proj-rebrand', clientId: 'client-acme' },
]

describe('parseIssueRef', () => {
  it('reads identifiers and linear.app issue URLs', () => {
    expect(parseIssueRef('LIN-123')).toBe('LIN-123')
    expect(parseIssueRef('  lin-7 ')).toBe('LIN-7')
    expect(parseIssueRef('https://linear.app/acme/issue/OPS-9/refresh-the-pitch-deck')).toBe(
      'OPS-9',
    )
  })

  it('treats anything else as search text', () => {
    expect(parseIssueRef('launch video')).toBeNull()
    expect(parseIssueRef('LIN123')).toBeNull()
    expect(parseIssueRef('https://example.com/issue/LIN-1')).toBeNull()
  })
})

describe('linearApi', () => {
  it('maps assigned issues, resolving the client from the project then the team', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: fixture('assigned') }))
    const raw = await linearApi('tok_abc', impl).assigned()
    const [first, second] = raw.map((r) => mapIssueSummary(r, mappings))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.linear.app/graphql')
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok_abc')
    expect((calls[0]!.body as { query: string }).query).toContain('assignedIssues')

    expect(first).toMatchObject({
      identifier: 'LIN-123',
      title: 'Thumbnail for the launch video',
      stateName: 'In Progress',
      priorityLabel: 'High',
      assigneeName: 'Ada Lovelace',
      teamKey: 'LIN',
      projectName: 'Acme rebrand',
      clientId: 'client-acme',
    })
    // No project, no assignee, null priority, unmapped team.
    expect(second).toMatchObject({
      identifier: 'OPS-9',
      priorityLabel: 'No priority',
      assigneeName: null,
      projectId: null,
      clientId: null,
    })
  })

  it('falls back to the team mapping when the project is unmapped', async () => {
    const { impl } = fakeFetch(() => ({ json: fixture('assigned') }))
    const raw = await linearApi('t', impl).assigned()
    const onlyTeam = [mappings[0]!]
    expect(mapIssueSummary(raw[0]!, onlyTeam).clientId).toBe('client-globex')
  })

  it('maps an issue with comments oldest-first and tolerates nulls', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: fixture('issue') }))
    const raw = await linearApi('t', impl).issue('LIN-123')
    expect((calls[0]!.body as { variables: unknown }).variables).toEqual({ id: 'LIN-123' })

    const issue = mapIssueDetail(raw!, mappings)
    expect(issue.description).toContain('Show the product mid-air.')
    expect(issue.labels).toEqual(['design', 'video'])
    expect(issue.comments.map((c) => c.id)).toEqual(['c-1', 'c-2', 'c-3'])
    expect(issue.comments[0]).toMatchObject({ author: 'Someone', body: 'Reference attached.' })
    expect(issue.comments[2]!.body).toBe('')
    expect(issue.attachments).toEqual([
      {
        id: 'att-1',
        title: 'Moodboard',
        subtitle: 'Figma frame',
        url: 'https://www.figma.com/file/abc',
        sourceType: 'figma',
      },
      {
        id: 'att-2',
        title: '',
        subtitle: '',
        url: 'https://example.com/ref.png',
        sourceType: null,
      },
    ])
    expect(issue.clientId).toBe('client-acme')
  })

  it('sends the term for a search and the right query for recent', async () => {
    const { impl, calls } = fakeFetch((call) => ({
      json: (call.body as { query: string }).query.includes('searchIssues')
        ? {
            data: { searchIssues: { nodes: fixture('assigned').data.viewer.assignedIssues.nodes } },
          }
        : { data: { issues: { nodes: [] } } },
    }))
    const api = linearApi('t', impl)
    expect(await api.search('launch video')).toHaveLength(2)
    expect((calls[0]!.body as { variables: unknown }).variables).toEqual({ term: 'launch video' })
    expect(await api.recent()).toEqual([])
    expect((calls[1]!.body as { query: string }).query).toContain('issues(first: 25')
  })

  it('returns null for an issue Linear cannot find', async () => {
    const { impl } = fakeFetch(() => ({ status: 400, json: fixture('error-not-found') }))
    expect(await linearApi('t', impl).issue('LIN-9999')).toBeNull()
  })

  it('maps teams with their projects', async () => {
    const { impl } = fakeFetch(() => ({ json: fixture('teams') }))
    const teams = await linearApi('t', impl).teams()
    expect(teams).toEqual([
      {
        id: 'team-launch',
        key: 'LIN',
        name: 'Launch',
        projects: [
          { id: 'proj-rebrand', name: 'Acme rebrand' },
          { id: 'proj-site', name: 'Globex site' },
        ],
      },
      { id: 'team-ops', key: 'OPS', name: 'Operations', projects: [] },
    ])
  })

  it('reads the viewer and workspace for the connection label', async () => {
    const { impl } = fakeFetch(() => ({ json: fixture('viewer') }))
    expect(await linearApi('t', impl).viewer()).toEqual({
      id: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@acme.test',
      workspace: { id: 'org-1', name: 'Acme Studio' },
    })
  })

  it('rejects a response that does not look like issues', async () => {
    const { impl } = fakeFetch(() => ({
      json: { data: { issues: { nodes: [{ id: 'x', identifier: 'A-1' }] } } },
    }))
    await expect(linearApi('t', impl).recent()).rejects.toMatchObject({ status: 502 })
  })
})

describe('linearGraphQL errors', () => {
  it('reports an authentication error as 401', async () => {
    const { impl } = fakeFetch(() => ({ status: 401, json: fixture('error-auth') }))
    const err = (await linearGraphQL('bad', 'query { viewer { id } }', {}, impl).catch(
      (e) => e,
    )) as LinearApiError
    expect(err).toBeInstanceOf(LinearApiError)
    expect(err.status).toBe(401)
    expect(err.message).toMatch(/not authenticated/)
  })

  it('treats an auth error delivered with a 200 the same way', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, json: fixture('error-auth') }))
    await expect(linearGraphQL('bad', 'query { x }', {}, impl)).rejects.toMatchObject({
      status: 401,
    })
  })

  it('fails on an empty data payload', async () => {
    const { impl } = fakeFetch(() => ({ json: { data: null } }))
    await expect(linearGraphQL('t', 'query { x }', {}, impl)).rejects.toMatchObject({ status: 502 })
  })
})

describe('exchangeLinearCode', () => {
  it('posts the authorization-code grant form-encoded', async () => {
    const { impl, calls } = fakeFetch(() => ({
      json: { access_token: 'lin_at', refresh_token: 'lin_rt', expires_in: 86399, scope: 'read' },
    }))
    const token = await exchangeLinearCode(
      { code: 'abc', clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://x/cb' },
      impl,
    )
    expect(token).toEqual({
      accessToken: 'lin_at',
      refreshToken: 'lin_rt',
      expiresIn: 86399,
      scope: 'read',
    })
    expect(calls[0]!.url).toBe('https://api.linear.app/oauth/token')
    const form = new URLSearchParams(calls[0]!.body as string)
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'abc',
      client_id: 'cid',
      client_secret: 'sec',
      redirect_uri: 'http://x/cb',
    })
  })

  it('surfaces a rejected code', async () => {
    const { impl } = fakeFetch(() => ({ status: 400, json: { error: 'invalid_grant' } }))
    await expect(
      exchangeLinearCode({ code: 'x', clientId: 'a', clientSecret: 'b', redirectUri: 'c' }, impl),
    ).rejects.toMatchObject({ status: 400 })
  })
})
