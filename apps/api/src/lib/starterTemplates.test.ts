import {
  emptyKitTokens,
  findSlots,
  HOUSE_KIT_TOKENS,
  isSafeKitUrl,
  kitToCss,
  kitTokensSchema,
  parseVideoDoc,
  videoDurationProblem,
  videoRenderProblems,
  viewportSize,
  type KitTokens,
} from '@moodboard/shared'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromiumAvailable, chromiumExecutablePath } from './browser'
import { composeDocument } from './compose'
import { loadStarterTemplates, type StarterTemplate } from './starterTemplateFiles'

// The --kit-* names every kit emits, whatever its tokens. Templates may only
// read these (plus custom properties they define themselves).
const FIXED_KIT_VARS = new Set(kitToCss(emptyKitTokens()).match(/--kit-[a-z0-9-]+/g))

const VIDEO_KEYS = ['promo-spot', 'promo-spot-vertical']

let starters: StarterTemplate[]

beforeAll(async () => {
  starters = await loadStarterTemplates()
})

describe('starter templates', () => {
  it('ship the formats, two of them video', () => {
    expect(starters.map((s) => s.format)).toEqual([
      'thumbnail',
      'social',
      'deck',
      'landing',
      'one-pager',
      'video',
      'video',
    ])
  })

  it('declare labelled text and image slots', () => {
    for (const s of starters) {
      const slots = findSlots(s.html)
      expect(slots.length, s.key).toBeGreaterThan(3)
      expect(
        slots.every((m) => m.label !== null),
        s.key,
      ).toBe(true)
      expect(
        slots.some((m) => m.kind === 'image'),
        s.key,
      ).toBe(true)
      expect(
        slots.some((m) => m.name === 'brand'),
        s.key,
      ).toBe(true)
    }
  })

  it('read only the fixed --kit-* contract (or their own custom properties)', () => {
    for (const s of starters) {
      const own = new Set([...s.css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
      const used = [...`${s.html}\n${s.css}`.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!)
      const foreign = used.filter((v) => !FIXED_KIT_VARS.has(v) && !own.has(v))
      expect(foreign, s.key).toEqual([])
    }
  })

  it('need no network and animate only in seekable ways', () => {
    for (const s of starters) {
      const text = `${s.html}\n${s.css}\n${s.js}`
      expect(text, s.key).not.toMatch(/https?:\/\/|url\(\s*["']?\/\/|@import/)
      expect(s.js, s.key).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/)
    }
    expect(starters.filter((s) => /@keyframes/.test(s.css)).map((s) => s.key)).toEqual(
      expect.arrayContaining(['youtube-thumbnail', 'social-post', ...VIDEO_KEYS]),
    )
  })
})

// The video template convention (CLAUDE.md): a fixed viewport inside the
// render limits, `data-duration` (ms) on the root, and motion only as CSS
// keyframes with explicit delays — a function of time, so a renderer can
// seek it. The browser half of the contract is below.
describe('video starter templates', () => {
  const videos = () => starters.filter((s) => s.format === 'video')

  it('have a fixed viewport and a duration inside the render limits', () => {
    expect(videos().map((s) => s.key)).toEqual(VIDEO_KEYS)
    for (const s of videos()) {
      expect(s.viewport.kind, s.key).toBe('fixed')
      const viewport = viewportSize(s.viewport)
      const doc = parseVideoDoc(s.html)
      expect(doc, s.key).not.toBeNull()
      expect(videoDurationProblem(s.html), s.key).toBeNull()
      expect(
        videoRenderProblems({ viewport, durationMs: doc!.durationMs, fps: 60 }),
        s.key,
      ).toEqual([])
      expect(doc!.posterMs, s.key).toBeGreaterThan(0)
      expect(doc!.posterMs, s.key).toBeLessThan(doc!.durationMs)
    }
  })

  it('put data-duration on the root element of the markup', () => {
    for (const s of videos()) {
      expect(s.html.trimStart(), s.key).toMatch(/^<main[^>]*\sdata-duration="\d+"/)
    }
  })

  it('animate with keyframes and explicit delays only — no transitions or script timing', () => {
    for (const s of videos()) {
      expect(s.css, s.key).toMatch(/@keyframes/)
      expect(s.css, s.key).not.toMatch(/\btransition\s*:|transition-/)
      expect(s.css, s.key).not.toMatch(/animation-play-state|animation-timeline/)
      expect(s.js, s.key).toBe('')
    }
  })

  it('are a 16:9 and a 9:16 cut of the same spot', () => {
    const [wide, tall] = videos().map((s) => viewportSize(s.viewport))
    expect(wide).toEqual({ width: 1920, height: 1080 })
    expect(tall).toEqual({ width: 1080, height: 1920 })
    expect(slotNames(videos()[0]!)).toEqual(slotNames(videos()[1]!))
  })
})

const slotNames = (s: StarterTemplate) =>
  findSlots(s.html)
    .map((m) => m.name)
    .sort()

// ---------------------------------------------------------------------------
// Standalone render: each starter composed with two different kits, loaded
// with every network request refused, animations seeked to their end (as
// the Phase 25 renderer will), then checked and screenshotted. Needs a
// Chromium: Playwright's own build (CI installs it), or CHROMIUM_PATH; skipped
// where there is none. OUTPUT_SHOTS_DIR saves each screenshot and document.
// ---------------------------------------------------------------------------

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60" viewBox="0 0 240 60"><rect width="60" height="60" rx="14" fill="#F3B61F"/><text x="74" y="42" font-family="Georgia" font-size="34" fill="#F4F1EA">Ember</text></svg>`

const KITS: { name: string; tokens: KitTokens; assets: Map<string, string> }[] = [
  {
    name: 'ember',
    tokens: kitTokensSchema.parse({
      palette: [
        { role: 'background', hex: '#0E0E10' },
        { role: 'surface', hex: '#1B1B21' },
        { role: 'text', hex: '#F4F1EA' },
        { role: 'primary', hex: '#E4572E' },
        { role: 'accent', hex: '#F3B61F' },
      ],
      fonts: {
        display: { family: 'Georgia', category: 'serif', weights: [700] },
        body: { family: 'Helvetica Neue', category: 'sans' },
      },
      logos: [{ name: 'Logo', url: '/api/files/ember_logo.svg' }],
    }),
    assets: new Map([
      ['ember_logo.svg', `data:image/svg+xml;base64,${Buffer.from(LOGO_SVG).toString('base64')}`],
    ]),
  },
  {
    name: 'meadow',
    tokens: kitTokensSchema.parse({
      palette: [
        { role: 'background', hex: '#F3F6F1' },
        { role: 'surface', hex: '#FFFFFF' },
        { role: 'text', hex: '#1D2B22' },
        { role: 'primary', hex: '#2F6B4F' },
        { role: 'accent', hex: '#FF8A5B' },
      ],
      fonts: { display: { family: 'Avenir Next', category: 'sans', weights: [600] } },
    }),
    assets: new Map(),
  },
]

const SHOTS = process.env.OUTPUT_SHOTS_DIR
const executablePath = chromiumExecutablePath()
const hasChromium = chromiumAvailable()

describe.skipIf(!hasChromium)('starter templates render standalone', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath })
    if (SHOTS) mkdirSync(SHOTS, { recursive: true })
  })

  afterAll(async () => {
    await browser?.close()
  })

  const cases = [
    'youtube-thumbnail',
    'social-post',
    'deck',
    'landing-page',
    'one-pager',
    ...VIDEO_KEYS,
  ].flatMap((key) => KITS.map((kit) => [key, kit.name] as const))

  it.each(cases)('%s with the %s kit', async (key, kitName) => {
    const starter = starters.find((s) => s.key === key)!
    const kit = KITS.find((k) => k.name === kitName)!
    const composed = composeDocument({
      title: starter.name,
      format: starter.format,
      viewport: starter.viewport,
      html: starter.html,
      css: starter.css,
      js: starter.js,
      kitCss: kitToCss(kit.tokens),
      kitHasLogo: kit.tokens.logos.some((l) => isSafeKitUrl(l.url)),
      values: {},
      assets: kit.assets,
    })
    expect(composed.missingAssets).toEqual([])

    const size =
      starter.viewport.kind === 'fixed'
        ? { width: starter.viewport.width, height: starter.viewport.height }
        : { width: 1440, height: 900 }
    const page = await browser.newPage({ viewport: size })
    const requests: string[] = []
    const problems: string[] = []
    await page.route('**/*', (route) => {
      requests.push(route.request().url())
      return route.abort()
    })
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
    page.on('pageerror', (e) => problems.push(e.message))

    await page.setContent(composed.html, { waitUntil: 'load' })
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        const end = a.effect?.getComputedTiming().endTime
        a.pause()
        a.currentTime = typeof end === 'number' ? end : 0
      }
    })

    expect(requests).toEqual([])
    expect(problems).toEqual([])
    const facts = await page.evaluate(() => ({
      background: [document.body, document.documentElement]
        .map((el) => getComputedStyle(el).backgroundColor)
        .find((c) => c !== 'rgba(0, 0, 0, 0)'),
      logo: document.documentElement.dataset.kitLogo,
      brandVisible: [...document.querySelectorAll('[data-slot="brand"]')].some(
        (el) => (el as HTMLElement).offsetParent !== null,
      ),
      logoVisible: [...document.querySelectorAll('.logo')].some(
        (el) => (el as HTMLElement).offsetWidth > 0,
      ),
      headline: [...document.querySelectorAll('h1')].map((h) => h.getBoundingClientRect().height),
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    }))
    expect(facts.logo).toBe(kitName === 'ember' ? 'present' : 'none')
    expect(facts.logoVisible).toBe(kitName === 'ember')
    expect(facts.brandVisible).toBe(kitName !== 'ember')
    expect(facts.headline.every((h) => h > 20)).toBe(true)
    expect(facts.overflowX).toBeLessThanOrEqual(0)
    if (key !== 'social-post' && !VIDEO_KEYS.includes(key)) {
      const bg = kit.tokens.palette.find((p) => p.role === 'background')!.hex
      expect(facts.background).toBeDefined()
      expect(key === 'deck' || facts.background === hexToRgb(bg)).toBe(true)
    }

    if (SHOTS) {
      await page.screenshot({
        path: path.join(SHOTS, `${key}--${kitName}.png`),
        fullPage: starter.viewport.kind === 'responsive',
      })
      writeFileSync(path.join(SHOTS, `${key}--${kitName}.html`), composed.html)
    }
    await page.close()
  })

  describe.each(VIDEO_KEYS)('%s is a seekable timeline', (key) => {
    const SCENES: [number, string][] = [
      [1000, '.sting'],
      [4000, '.hero'],
      [7000, '.beat-1'],
      [9000, '.beat-2'],
      [11000, '.beat-3'],
      [14000, '.cta'],
    ]

    it.each(KITS.map((k) => k.name))('with the %s kit', async (kitName) => {
      const starter = starters.find((s) => s.key === key)!
      const kit = KITS.find((k) => k.name === kitName)!
      const doc = parseVideoDoc(starter.html)!
      const composed = composeDocument({
        title: starter.name,
        format: starter.format,
        viewport: starter.viewport,
        html: starter.html,
        css: starter.css,
        js: starter.js,
        kitCss: kitToCss(kit.tokens),
        kitHasLogo: kit.tokens.logos.some((l) => isSafeKitUrl(l.url)),
        values: {},
        assets: kit.assets,
      })
      const page = await browser.newPage({ viewport: viewportSize(starter.viewport) })
      const problems: string[] = []
      await page.route('**/*', (route) => route.abort())
      page.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
      page.on('pageerror', (e) => problems.push(e.message))
      await page.setContent(composed.html, { waitUntil: 'load' })
      const seek = (t: number) =>
        page.evaluate(
          (time) =>
            (
              window as unknown as { __moodboardTimeline: { seek(t: number): void } }
            ).__moodboardTimeline.seek(time),
          t,
        )
      const visible = (selector: string) =>
        page.evaluate(
          (sel) => getComputedStyle(document.querySelector(sel)!).visibility === 'visible',
          selector,
        )

      expect(problems).toEqual([])
      const facts = await page.evaluate(() => {
        const timeline = (
          window as unknown as {
            __moodboardTimeline?: { duration: number; animations: number }
          }
        ).__moodboardTimeline
        const all = document.getAnimations()
        return {
          duration: timeline?.duration,
          count: timeline?.animations,
          // Every animation must finish inside the film, with finite repeats
          // and an explicit, non-negative delay.
          offenders: all
            .filter((a) => {
              const t = a.effect!.getComputedTiming()
              return !(
                Number.isFinite(t.endTime as number) &&
                (t.endTime as number) <= (timeline?.duration ?? 0) + 1 &&
                (t.delay ?? 0) >= 0
              )
            })
            .map((a) => (a as CSSAnimation).animationName),
          unnamed: all.filter((a) => !(a instanceof CSSAnimation)).length,
        }
      })
      expect(facts.duration).toBe(doc.durationMs)
      expect(facts.count).toBeGreaterThan(30)
      expect(facts.offenders).toEqual([])
      expect(facts.unnamed).toBe(0)

      for (const [t, selector] of SCENES) {
        await seek(t)
        expect(await visible(selector), `${selector} at ${t}`).toBe(true)
        const others = SCENES.filter(([, s]) => s !== selector).map(([, s]) => s)
        for (const other of others) {
          expect(await visible(other), `${other} hidden at ${t}`).toBe(false)
        }
      }

      const shot = async (t: number) => {
        await seek(t)
        return page.screenshot()
      }
      const [first, poster, last] = [
        await shot(0),
        await shot(doc.posterMs),
        await shot(doc.durationMs - 1),
      ]
      expect(first.equals(poster)).toBe(false)
      expect(poster.equals(last)).toBe(false)
      // A frame is a pure function of time: the same seek gives the same
      // pixels, and nothing moves on its own afterwards.
      expect((await shot(doc.posterMs)).equals(poster)).toBe(true)
      await page.waitForTimeout(250)
      expect((await page.screenshot()).equals(poster)).toBe(true)
      // The film settles before it ends, so its last frame is a held end card.
      expect((await shot(doc.durationMs - 90)).equals(last)).toBe(true)

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
      if (SHOTS) {
        for (const [label, t] of [
          ['poster', doc.posterMs],
          ['end', doc.durationMs - 1],
        ] as const) {
          await seek(t)
          await page.screenshot({ path: path.join(SHOTS, `${key}--${kitName}--${label}.png`) })
        }
      }
      await page.close()
    })
  })

  it('the landing page collapses to one column on a phone', async () => {
    const starter = starters.find((s) => s.key === 'landing-page')!
    const composed = composeDocument({
      title: starter.name,
      format: starter.format,
      viewport: starter.viewport,
      html: starter.html,
      css: starter.css,
      js: starter.js,
      kitCss: kitToCss(HOUSE_KIT_TOKENS),
      kitHasLogo: false,
      values: {},
      assets: new Map(),
    })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.route('**/*', (route) => route.abort())
    await page.setContent(composed.html)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    if (SHOTS) {
      await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()))
      await page.screenshot({
        path: path.join(SHOTS, 'landing-page--house-mobile.png'),
        fullPage: true,
      })
    }
    await page.close()
  })
})

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
