import type { BrowserContext, ElementHandle, Page } from 'playwright'
import { getBrowser } from './browser'

// Renders a composed output document (lib/compose.ts — standalone, no
// network) in headless Chromium at its template viewport and captures a
// PNG frame. Animations are CSS keyframes / WAAPI only, so a frame at any
// time is a seek on document.getAnimations(): pause everything, set
// currentTime. Thumbnails are one frame; the MP4 renderer (renderVideo.ts)
// steps the same seek per frame through `withDocument`.
//
// One shared browser (lib/browser.ts), a fresh context per document, every
// request refused (the document's own CSP already forbids them), bounded
// concurrency and a hard timeout per document.

export type FrameViewport = { width: number; height: number }
export type FrameTime = number | 'end'

export const RENDER_TIMEOUT_MS = 20_000
// Frames and MP4s have separate pools: a video render holds its slot for
// minutes, and must not starve the designer's quick frame renders.
class Pool {
  private active = 0
  private waiting: (() => void)[] = []
  constructor(private readonly size: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.size) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
    return () => {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

const framePool = new Pool(Math.max(1, Number(process.env.RENDER_CONCURRENCY) || 2))
const videoPool = new Pool(Math.max(1, Number(process.env.VIDEO_RENDER_CONCURRENCY) || 1))

export class RenderTimeoutError extends Error {
  constructor(ms: number) {
    super(`Render timed out after ${ms}ms`)
    this.name = 'RenderTimeoutError'
  }
}

export type DocumentHandle = {
  page: Page
  // Network requests the document attempted (all refused). Should be empty.
  blocked: string[]
  // Script errors and console errors raised while loading.
  errors: string[]
  seek: (time: FrameTime) => Promise<void>
  sectionCount: () => Promise<number>
  screenshot: (opts?: { section?: number }) => Promise<Buffer>
}

// Top-level blocks of the document in reading order: a deck's slides, a
// landing page's header / sections / footer, or the single frame of a
// fixed-size design. Runs in the page.
function sectionElements(): Element[] {
  const out: Element[] = []
  for (const el of Array.from(document.body.children)) {
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue
    const inner =
      el.tagName === 'MAIN' ? Array.from(el.children).filter((c) => c.tagName === 'SECTION') : []
    if (inner.length > 1) out.push(...inner)
    else out.push(el)
  }
  return out.filter((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
}

export async function withDocument<T>(
  html: string,
  opts: {
    viewport: FrameViewport
    deviceScaleFactor?: number
    timeoutMs?: number
    pool?: 'frame' | 'video'
  },
  fn: (doc: DocumentHandle) => Promise<T>,
): Promise<T> {
  const release = await (opts.pool === 'video' ? videoPool : framePool).acquire()
  let context: BrowserContext | null = null
  const timeoutMs = opts.timeoutMs ?? RENDER_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined
  try {
    const browser = await getBrowser()
    context = await browser.newContext({
      viewport: opts.viewport,
      deviceScaleFactor: opts.deviceScaleFactor ?? 1,
      reducedMotion: 'no-preference',
    })
    const blocked: string[] = []
    const errors: string[] = []
    await context.route('**/*', (route) => {
      blocked.push(route.request().url())
      return route.abort()
    })
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })

    const handle: DocumentHandle = {
      page,
      blocked,
      errors,
      seek: (time) =>
        page.evaluate((t) => {
          // A video document carries its own timeline (lib/videoTimeline.ts);
          // using it makes a still exactly the frame the MP4 would have.
          const timeline = (
            window as unknown as { __moodboardTimeline?: { seek(time: number): void } }
          ).__moodboardTimeline
          if (timeline && t !== 'end') {
            timeline.seek(t)
            return
          }
          for (const a of document.getAnimations()) {
            const timing = a.effect?.getComputedTiming()
            a.pause()
            if (t !== 'end') {
              a.currentTime = t
              continue
            }
            const end = timing?.endTime
            if (typeof end === 'number' && Number.isFinite(end)) {
              a.currentTime = end
            } else {
              // An infinite loop has no end: hold the last moment of its
              // first iteration.
              const delay = timing?.delay ?? 0
              const duration = typeof timing?.duration === 'number' ? timing.duration : 0
              a.currentTime = Math.max(0, delay + duration - 1)
            }
          }
        }, time),
      sectionCount: () => page.evaluate(`(${sectionElements.toString()})().length`),
      screenshot: async ({ section } = {}) => {
        if (section === undefined) return page.screenshot({ type: 'png' })
        const target = await page.evaluateHandle(
          `(${sectionElements.toString()})()[${Number(section)}] ?? null`,
        )
        const element = target.asElement() as ElementHandle | null
        if (!element) throw new Error(`The document has no section ${section + 1}`)
        return element.screenshot({ type: 'png' })
      },
    }

    const run = async () => {
      await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs })
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      return fn(handle)
    }
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RenderTimeoutError(timeoutMs)), timeoutMs)
    })
    return await Promise.race([run(), timeout])
  } finally {
    clearTimeout(timer)
    await context?.close().catch(() => undefined)
    release()
  }
}

export type Frame = {
  png: Buffer
  width: number
  height: number
  sections: number
  blocked: string[]
  errors: string[]
}

// Pixel size from the PNG's IHDR chunk.
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

// One frame. `maxEdge` scales the capture down (device scale factor) so the
// longest edge fits — what a vision model or a card thumbnail needs.
export async function renderFrame(
  html: string,
  opts: {
    viewport: FrameViewport
    time?: FrameTime
    section?: number
    maxEdge?: number
    timeoutMs?: number
  },
): Promise<Frame> {
  const longest = Math.max(opts.viewport.width, opts.viewport.height)
  const scale = opts.maxEdge && longest > opts.maxEdge ? opts.maxEdge / longest : 1
  return withDocument(
    html,
    { viewport: opts.viewport, deviceScaleFactor: scale, timeoutMs: opts.timeoutMs },
    async (doc) => {
      await doc.seek(opts.time ?? 'end')
      const sections = await doc.sectionCount()
      const png = await doc.screenshot({ section: opts.section })
      return { png, ...pngSize(png), sections, blocked: doc.blocked, errors: doc.errors }
    },
  )
}
