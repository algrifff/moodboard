import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  downloadRender,
  exchangeFigmaCode,
  FigmaApiError,
  figmaApi,
  figmaEnv,
  FIGMA_DEFAULT_SCOPES,
  refreshFigmaToken,
  type FetchLike,
} from './figma'

// Hand-built in the shape Figma's REST API returns
// (https://www.figma.com/developers/api).
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/figma/${name}.json`, import.meta.url), 'utf8'))

type Call = {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

function fakeFetch(
  reply: (call: Call) => {
    status?: number
    json?: unknown
    body?: BodyInit
    headers?: Record<string, string>
  },
) {
  const calls: Call[] = []
  const impl = (async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body == null ? null : String(init.body),
    }
    calls.push(call)
    const { status = 200, json, body, headers } = reply(call)
    return new Response(body ?? JSON.stringify(json), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })
  }) as unknown as FetchLike
  return { impl, calls }
}

const BASE = 'https://api.figma.com'

describe('figmaEnv', () => {
  it('is null unless all three variables are set, and defaults to read-only scopes', () => {
    const saved = { ...process.env }
    try {
      delete process.env.FIGMA_CLIENT_ID
      delete process.env.FIGMA_CLIENT_SECRET
      delete process.env.FIGMA_REDIRECT_URI
      delete process.env.FIGMA_SCOPES
      expect(figmaEnv()).toBeNull()
      process.env.FIGMA_CLIENT_ID = 'id'
      process.env.FIGMA_CLIENT_SECRET = 'secret'
      expect(figmaEnv()).toBeNull()
      process.env.FIGMA_REDIRECT_URI = 'http://localhost:5173/api/connections/figma/callback'
      expect(figmaEnv()).toMatchObject({ clientId: 'id', scopes: FIGMA_DEFAULT_SCOPES })
      expect(FIGMA_DEFAULT_SCOPES).not.toMatch(/write|:edit|webhooks/)
    } finally {
      process.env = saved
    }
  })
})

describe('figmaApi', () => {
  it('reads the file with a bearer token', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: fixture('file') }))
    const file = await figmaApi('tok', impl, BASE).file('KEY12345', { depth: 2 })
    expect(calls[0]!.url).toBe(`${BASE}/v1/files/KEY12345?depth=2`)
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok')
    expect(file.name).toBe('Acme Brand')
    expect(file.document.children?.map((c) => c.name)).toEqual(['Brand', 'Screens'])
    expect(file.styles?.['1:100']?.name).toBe('Colors/Brand/Primary')
  })

  it('asks for nodes and images by id', async () => {
    const { impl, calls } = fakeFetch((c) =>
      c.url.includes('/images/') ? { json: fixture('images') } : { json: fixture('nodes-hero') },
    )
    const api = figmaApi('tok', impl, BASE)
    const nodes = await api.nodes('KEY12345', ['12:34', '12:35'], { depth: 8 })
    expect(calls[0]!.url).toBe(`${BASE}/v1/files/KEY12345/nodes?ids=12%3A34%2C12%3A35&depth=8`)
    expect(nodes.nodes['12:34']!.document.name).toBe('Hero')

    const images = await api.images('KEY12345', ['12:34'], { scale: 1.42 })
    expect(calls[1]!.url).toBe(`${BASE}/v1/images/KEY12345?ids=12%3A34&format=png&scale=1.42`)
    expect(images['12:34']).toMatch(/^https:\/\//)
    expect(images['12:99']).toBeNull()
  })

  it('reports an images error as a failure', async () => {
    const { impl } = fakeFetch(() => ({ json: { err: 'Render timeout', images: {} } }))
    await expect(
      figmaApi('t', impl, BASE).images('K12345678', ['1:2'], { scale: 1 }),
    ).rejects.toThrow(/Render timeout/)
  })

  it('maps errors to words a person can read', async () => {
    const notFound = fakeFetch(() => ({ status: 404, json: fixture('error-not-found') }))
    const forbidden = fakeFetch(() => ({ status: 403, json: fixture('error-forbidden') }))
    const limited = fakeFetch(() => ({ status: 429, json: {}, headers: { 'Retry-After': '30' } }))
    const e404 = await figmaApi('t', notFound.impl, BASE)
      .file('K12345678')
      .catch((e) => e)
    expect(e404).toBeInstanceOf(FigmaApiError)
    expect(e404).toMatchObject({ status: 404 })
    expect(e404.message).toMatch(/couldn’t find/)
    const e403 = await figmaApi('t', forbidden.impl, BASE)
      .localVariables('K12345678')
      .catch((e) => e)
    expect(e403).toMatchObject({ status: 403 })
    expect(e403.message).toMatch(/Invalid token/)
    const e429 = await figmaApi('t', limited.impl, BASE)
      .me()
      .catch((e) => e)
    expect(e429).toMatchObject({ status: 429, retryAfterSec: 30 })
  })

  it('rejects a response that is not the shape it expects', async () => {
    const { impl } = fakeFetch(() => ({ json: { nope: true } }))
    await expect(figmaApi('t', impl, BASE).file('K12345678')).rejects.toMatchObject({ status: 502 })
  })

  it('reads published styles and variables', async () => {
    const { impl } = fakeFetch((c) =>
      c.url.endsWith('/styles')
        ? { json: fixture('published-styles') }
        : { json: fixture('variables') },
    )
    const api = figmaApi('t', impl, BASE)
    expect((await api.publishedStyles('K12345678')).map((s) => s.node_id)).toEqual([
      '1:100',
      '1:105',
      '2:202',
    ])
    expect(Object.keys((await api.localVariables('K12345678')).variables)).toHaveLength(5)
  })

  it('reads the account for the connection label', async () => {
    const { impl } = fakeFetch(() => ({ json: fixture('me') }))
    expect(await figmaApi('t', impl, BASE).me()).toMatchObject({ email: 'ada@acme.test' })
  })
})

describe('OAuth', () => {
  const env = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://x/cb' }

  it('exchanges a code with basic auth and a form body', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: fixture('token') }))
    const token = await exchangeFigmaCode({ code: 'abc', ...env }, impl, BASE)
    expect(calls[0]!.url).toBe(`${BASE}/v1/oauth/token`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers.Authorization).toBe(
      `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    )
    const form = new URLSearchParams(calls[0]!.body!)
    expect(Object.fromEntries(form)).toEqual({
      redirect_uri: 'http://x/cb',
      code: 'abc',
      grant_type: 'authorization_code',
    })
    expect(token).toEqual({
      accessToken: 'figu_access_1',
      refreshToken: 'figur_refresh_1',
      expiresIn: 7776000,
    })
  })

  it('refreshes with the refresh token; the answer carries no new one', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: fixture('refresh') }))
    const token = await refreshFigmaToken({ refreshToken: 'figur_refresh_1', ...env }, impl, BASE)
    expect(calls[0]!.url).toBe(`${BASE}/v1/oauth/refresh`)
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body!))).toEqual({
      refresh_token: 'figur_refresh_1',
    })
    expect(token.accessToken).toBe('figu_access_2')
    expect(token.refreshToken).toBeUndefined()
    expect(token.expiresIn).toBe(7776000)
  })

  it('fails with the provider’s reason', async () => {
    const { impl } = fakeFetch(() => ({ status: 400, body: 'invalid_grant' }))
    await expect(
      refreshFigmaToken({ refreshToken: 'bad', ...env }, impl, BASE),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('invalid_grant') })
  })
})

describe('downloadRender', () => {
  const allow = async () => ({ ok: true as const })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const url = 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/hero-abc'

  it('downloads a PNG after checking the host', async () => {
    const checked: string[] = []
    const { impl } = fakeFetch(() => ({ body: png, headers: { 'Content-Type': 'image/png' } }))
    const bytes = await downloadRender(url, {
      fetchImpl: impl,
      base: BASE,
      checkHost: async (h) => (checked.push(h), { ok: true }),
    })
    expect(bytes.equals(png)).toBe(true)
    expect(checked).toEqual(['figma-alpha-api.s3.us-west-2.amazonaws.com'])
  })

  it('refuses private hosts, plain http and non-images', async () => {
    const { impl } = fakeFetch(() => ({ body: 'x', headers: { 'Content-Type': 'text/html' } }))
    await expect(
      downloadRender('http://example.com/a.png', { fetchImpl: impl, base: BASE, checkHost: allow }),
    ).rejects.toThrow(/non-https/)
    await expect(
      downloadRender(url, {
        fetchImpl: impl,
        base: BASE,
        checkHost: async () => ({ ok: false, reason: 'private address' }),
      }),
    ).rejects.toThrow(/private address/)
    await expect(
      downloadRender(url, { fetchImpl: impl, base: BASE, checkHost: allow }),
    ).rejects.toThrow(/not a PNG/)
  })

  it('trusts only the configured API origin without a host check', async () => {
    const { impl } = fakeFetch(() => ({ body: png, headers: { 'Content-Type': 'image/png' } }))
    const local = 'http://127.0.0.1:4010'
    const bytes = await downloadRender(`${local}/img/1.png`, {
      fetchImpl: impl,
      base: local,
      checkHost: async () => ({ ok: false, reason: 'must not be asked' }),
    })
    expect(bytes.length).toBe(4)
  })

  it('stops at the size cap', async () => {
    const { impl } = fakeFetch(() => ({
      body: png,
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(60 * 1024 * 1024) },
    }))
    await expect(
      downloadRender(url, { fetchImpl: impl, base: BASE, checkHost: allow }),
    ).rejects.toThrow(/too large/)
  })
})
