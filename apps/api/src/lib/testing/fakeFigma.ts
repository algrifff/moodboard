import { createCanvas } from '@napi-rs/canvas'
import { readFileSync } from 'node:fs'

// A stand-in for api.figma.com built from the recorded fixtures, installed
// as the global fetch for the Figma flow tests (FIGMA_API_BASE points here).
// Test support only — nothing in the app imports it.

export const FAKE_FIGMA_ORIGIN = 'http://figma.test'

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/figma/${name}.json`, import.meta.url), 'utf8'))

export function testPng(width = 48, height = 30, colour = '#7B5CFF'): Buffer {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = colour
  ctx.fillRect(0, 0, width, height)
  return canvas.toBuffer('image/png')
}

export type FakeFigma = {
  calls: string[]
  lastModified: string
  variables: 'ok' | 'forbidden'
  refreshes: number
  refreshStatus: number
  fetch: typeof fetch
}

export function createFakeFigma(): FakeFigma {
  const state: FakeFigma = {
    calls: [],
    lastModified: '2026-03-04T10:00:00Z',
    variables: 'forbidden',
    refreshes: 0,
    refreshStatus: 200,
    fetch: undefined as unknown as typeof fetch,
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  state.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.origin !== FAKE_FIGMA_ORIGIN) throw new Error(`unexpected fetch to ${url.origin}`)
    const method = init?.method ?? 'GET'
    state.calls.push(`${method} ${url.pathname}${url.search}`)
    const path = url.pathname

    if (path === '/v1/oauth/refresh') {
      state.refreshes++
      if (state.refreshStatus !== 200)
        return new Response('invalid_grant', { status: state.refreshStatus })
      return json({ access_token: `figu_refreshed_${state.refreshes}`, expires_in: 7776000 })
    }
    if (path === '/v1/oauth/token') return json(fixture('token'))
    if (path === '/v1/me') return json(fixture('me'))
    if (path.startsWith('/img/')) {
      return new Response(new Uint8Array(testPng()), { headers: { 'Content-Type': 'image/png' } })
    }
    const m = /^\/v1\/(files|images)\/([^/]+)(?:\/(.+))?$/.exec(path)
    if (!m) return json({ status: 404, err: 'Not found' }, 404)
    const [, kind, , rest] = m
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean)

    if (kind === 'images') {
      return json({
        err: null,
        images: Object.fromEntries(
          ids.map((id) => [
            id,
            id === '12:99' ? null : `${FAKE_FIGMA_ORIGIN}/img/${id.replace(':', '-')}.png`,
          ]),
        ),
      })
    }
    if (rest === 'nodes') {
      if (ids.includes('1:105'))
        return json({ ...fixture('nodes-styles'), lastModified: state.lastModified })
      const hero = fixture('nodes-hero')
      const nodes: Record<string, unknown> = {}
      for (const id of ids) {
        if (id === '12:34') nodes[id] = hero.nodes['12:34']
        else if (id === '0:1')
          nodes[id] = { document: { id, name: 'Brand', type: 'CANVAS', children: [] } }
        else if (id === '12:99') {
          nodes[id] = {
            document: {
              id,
              name: 'Empty',
              type: 'FRAME',
              absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
            },
          }
        } else nodes[id] = null
      }
      return json({ ...hero, lastModified: state.lastModified, nodes })
    }
    if (rest === 'styles') return json(fixture('published-styles'))
    if (rest === 'variables/local') {
      return state.variables === 'ok'
        ? json(fixture('variables'))
        : json(fixture('error-forbidden'), 403)
    }
    return json({ ...fixture('file'), lastModified: state.lastModified })
  }) as typeof fetch
  return state
}
