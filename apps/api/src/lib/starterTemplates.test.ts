import {
  emptyKitTokens,
  findSlots,
  HOUSE_KIT_TOKENS,
  isSafeKitUrl,
  kitToCss,
  kitTokensSchema,
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

let starters: StarterTemplate[]

beforeAll(async () => {
  starters = await loadStarterTemplates()
})

describe('starter templates', () => {
  it('ship the five formats', () => {
    expect(starters.map((s) => s.format)).toEqual([
      'thumbnail',
      'social',
      'deck',
      'landing',
      'one-pager',
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
      expect.arrayContaining(['youtube-thumbnail', 'social-post']),
    )
  })
})

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

  const cases = ['youtube-thumbnail', 'social-post', 'deck', 'landing-page', 'one-pager'].flatMap(
    (key) => KITS.map((kit) => [key, kit.name] as const),
  )

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
    if (key !== 'social-post') {
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
