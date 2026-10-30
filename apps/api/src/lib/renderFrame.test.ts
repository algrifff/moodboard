import { HOUSE_KIT_TOKENS, kitToCss, type TemplateViewport } from '@moodboard/shared'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromiumAvailable, closeBrowser } from './browser'
import { composeDocument } from './compose'
import { pngSize, renderFrame, RenderTimeoutError, withDocument } from './renderFrame'
import { loadStarterTemplates, type StarterTemplate } from './starterTemplateFiles'

// The frame renderer against the real starter templates, composed exactly
// as outputs are. Needs a Chromium (Playwright's own build, or
// CHROMIUM_PATH); skipped where there is none.

let starters: StarterTemplate[]

function compose(
  starter: StarterTemplate,
  extra: { html?: string; css?: string; js?: string } = {},
) {
  return composeDocument({
    title: starter.name,
    format: starter.format,
    viewport: starter.viewport,
    html: starter.html + (extra.html ?? ''),
    css: starter.css + (extra.css ?? ''),
    js: extra.js ?? starter.js,
    kitCss: kitToCss(HOUSE_KIT_TOKENS),
    kitHasLogo: false,
    values: {},
    assets: new Map(),
  }).html
}

const sizeOf = (viewport: TemplateViewport) =>
  viewport.kind === 'fixed'
    ? { width: viewport.width, height: viewport.height }
    : { width: 1440, height: 900 }

describe.skipIf(!chromiumAvailable())('renderFrame', () => {
  let server: Server
  let hits: string[]
  let origin: string

  beforeAll(async () => {
    starters = await loadStarterTemplates()
    hits = []
    server = createServer((req, res) => {
      hits.push(req.url ?? '')
      res.end('x')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await closeBrowser()
    await new Promise((resolve) => server?.close(resolve))
  })

  const starter = (key: string) => starters.find((s) => s.key === key)!

  it.each(['youtube-thumbnail', 'social-post', 'deck', 'landing-page', 'one-pager'])(
    '%s renders at its template viewport with no requests and no errors',
    async (key) => {
      const s = starter(key)
      const frame = await renderFrame(compose(s), { viewport: sizeOf(s.viewport) })
      expect({ width: frame.width, height: frame.height }).toEqual(sizeOf(s.viewport))
      expect(pngSize(frame.png)).toEqual(sizeOf(s.viewport))
      expect(frame.blocked).toEqual([])
      expect(frame.errors).toEqual([])
      expect(frame.sections).toBeGreaterThan(0)
    },
  )

  it('seeks every animation to its end state by default', async () => {
    const s = starter('youtube-thumbnail')
    const state = await withDocument(compose(s), { viewport: sizeOf(s.viewport) }, async (doc) => {
      const before = await doc.page.evaluate(() => document.getAnimations().length)
      await doc.seek('end')
      return {
        before,
        after: await doc.page.evaluate(() =>
          document.getAnimations().map((a) => ({
            paused: a.playState === 'paused' || a.playState === 'finished',
            atEnd: a.currentTime === a.effect?.getComputedTiming().endTime,
          })),
        ),
      }
    })
    expect(state.before).toBeGreaterThan(0)
    expect(state.after.every((a) => a.paused && a.atEnd)).toBe(true)
  })

  it('renders a different frame at the start of the timeline', async () => {
    const s = starter('youtube-thumbnail')
    const html = compose(s)
    const start = await renderFrame(html, { viewport: sizeOf(s.viewport), time: 0 })
    const end = await renderFrame(html, { viewport: sizeOf(s.viewport) })
    expect(start.png.equals(end.png)).toBe(false)
  })

  it('scales the capture down to fit maxEdge', async () => {
    const s = starter('deck')
    const frame = await renderFrame(compose(s), { viewport: sizeOf(s.viewport), maxEdge: 960 })
    expect(frame.width).toBe(960)
    expect(frame.height).toBe(540)
  })

  it('captures one section of a multi-section document', async () => {
    const s = starter('deck')
    const frame = await renderFrame(compose(s), { viewport: sizeOf(s.viewport), section: 2 })
    expect(frame.sections).toBe(5)
    expect({ width: frame.width, height: frame.height }).toEqual({ width: 1920, height: 1080 })
    await expect(
      renderFrame(compose(s), { viewport: sizeOf(s.viewport), section: 9 }),
    ).rejects.toThrow(/no section 10/)
  })

  it('never reaches the network, even when the document asks', async () => {
    const s = starter('social-post')
    const frame = await renderFrame(
      compose(s, {
        html: `<img src="${origin}/img.png" alt=""><link rel="stylesheet" href="${origin}/x.css">`,
        css: `body { background-image: url(${origin}/bg.png) } @import url(${origin}/i.css);`,
      }),
      { viewport: sizeOf(s.viewport) },
    )
    expect(hits).toEqual([])
    expect(frame.png.length).toBeGreaterThan(0)
  })

  it('gives up on a document that never finishes', async () => {
    const s = starter('social-post')
    await expect(
      renderFrame(compose(s, { js: 'for (;;) {}' }), {
        viewport: sizeOf(s.viewport),
        timeoutMs: 1500,
      }),
    ).rejects.toBeInstanceOf(RenderTimeoutError)
    // The renderer is still usable afterwards.
    const frame = await renderFrame(compose(s), { viewport: sizeOf(s.viewport) })
    expect(frame.width).toBe(1080)
  })
})
