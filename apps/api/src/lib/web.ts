// Web URL extractor (Phase 14).
//
// Pulls brand-relevant signal out of any public homepage:
//   - Title + description (OG meta, then <title> / meta description fallback)
//   - Favicon (the highest-res link rel icon)
//   - 1–3 logo image candidates (favicon, OG image, biggest header <img>)
//   - Readable text (script/style/chrome stripped, whitespace collapsed, capped)
//   - Brand palette (sampled from the OG / hero image via @napi-rs/canvas)
//   - Font hints (Google Fonts URL params + first inline font-family decl)
//
// No headless browser, no parser library — just native fetch + careful regex.
// The DOM we care about is small (head + early body) and the patterns we
// match are specific, so a regex pass is reliable enough for a first cut. If
// future sites stop yielding good results we can drop in jsdom + Readability
// behind the same interface.
//
// SSRF defence: scheme allowlist (http/https), private-IP block on the
// resolved host, response body cap. The cap is the second wall — even if a
// host slips through, the fetch will time out / abort once it's hit.

import { createCanvas, loadImage } from '@napi-rs/canvas'
import { saveUpload } from './storage'
import type { ImageData } from '@moodboard/shared'
import { nanoid } from 'nanoid'

// Match Notion / Drive caps from analyze.ts:185.
const WEB_EXCERPT_MAX = 4000

// Browser-shaped UA — many sites serve a minimal placeholder to default
// Node fetch headers. Pretending to be Chrome gets us the real homepage.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const FETCH_TIMEOUT_MS = 10_000
const HTML_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const IMAGE_MAX_BYTES = 4 * 1024 * 1024 // 4 MB

// Up to 3 logos — favicon + OG image + one header candidate. More than that
// becomes noise on the canvas.
const MAX_LOGOS = 3

// Palette swatches displayed on the card. Five is enough for a brand
// signature without overflowing the card width.
const PALETTE_SIZE = 5

export type WebPageExtract = {
  url: string
  host: string
  title: string
  description: string
  faviconUrl?: string
  readableText: string
  colours: { hex: string; role: string }[]
  fonts: { family: string; role: 'display' | 'body' }[]
  fetchedAt: string
}

export type WebExtractResult = {
  page: WebPageExtract
  logoImages: ImageData[]
}

export class WebExtractError extends Error {
  constructor(
    public code: 'BAD_URL' | 'PRIVATE_HOST' | 'TIMEOUT' | 'TOO_LARGE' | 'FETCH_FAILED' | 'NOT_HTML',
    message: string,
  ) {
    super(message)
    this.name = 'WebExtractError'
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function extractWebPage(input: string, userId: string): Promise<WebExtractResult> {
  const parsed = parseUrlOrThrow(input)
  if (isPrivateHost(parsed.hostname)) {
    throw new WebExtractError('PRIVATE_HOST', `Refusing to fetch private host ${parsed.hostname}`)
  }

  const { html, finalUrl } = await fetchHtml(parsed.toString())
  const baseUrl = new URL(finalUrl)
  const meta = parseMeta(html, baseUrl)
  const readableText = extractReadable(html)
  const fonts = extractFonts(html)

  // Logo discovery — favicon first, then OG image, then the biggest
  // header <img> that smells like a logo. Each candidate is downloaded
  // and saved to /data/uploads/ so it lives on the canvas as a regular
  // image object.
  const candidates = collectLogoCandidates(html, baseUrl, meta)
  console.log(
    `[web] ${baseUrl.host}: ${candidates.length} logo candidate(s)`,
    candidates.map((c) => `${c.kind}:${c.url}`),
  )
  const logoImages: ImageData[] = []
  for (const candidate of candidates.slice(0, MAX_LOGOS)) {
    try {
      const saved = await downloadAndSaveImage(candidate, userId)
      if (saved) {
        logoImages.push(saved)
        console.log(`[web] ✓ saved ${candidate.kind} logo: ${candidate.url} → ${saved.url}`)
      } else {
        console.log(`[web] ✗ skipped ${candidate.kind} logo (null return): ${candidate.url}`)
      }
    } catch (e) {
      // Best-effort — a single 404 / wrong mime shouldn't fail the whole
      // import. Drop the candidate and keep going. Log so we can see why.
      console.log(
        `[web] ✗ failed ${candidate.kind} logo: ${candidate.url} — ${e instanceof Error ? e.message : 'unknown'}`,
      )
    }
  }
  console.log(`[web] ${baseUrl.host}: ${logoImages.length} logo(s) saved`)

  // Palette — sample from the OG image (or the first saved logo if no OG).
  // Falls back to an empty palette if nothing samples cleanly.
  const paletteSource = pickPaletteSource(candidates, logoImages)
  const colours = paletteSource ? await samplePalette(paletteSource) : []

  const page: WebPageExtract = {
    url: finalUrl,
    host: baseUrl.host,
    title: meta.title,
    description: meta.description,
    readableText,
    colours,
    fonts,
    fetchedAt: new Date().toISOString(),
  }
  if (meta.faviconUrl) page.faviconUrl = meta.faviconUrl

  return { page, logoImages }
}

// ---------------------------------------------------------------------------
// URL + SSRF guards
// ---------------------------------------------------------------------------

function parseUrlOrThrow(input: string): URL {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new WebExtractError('BAD_URL', 'Not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebExtractError('BAD_URL', 'Only http(s) URLs are supported')
  }
  // Strip any embedded credentials before the URL leaves this function.
  url.username = ''
  url.password = ''
  return url
}

// Block obvious private/loopback ranges. Not bulletproof against DNS
// rebinding — for that we'd need to resolve + lock the IP. Adequate for
// the first cut; we can upgrade if a real abuser shows up.
export function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase()
  if (lower === 'localhost') return true
  if (lower.endsWith('.localhost')) return true
  if (lower === '0.0.0.0') return true
  if (lower.endsWith('.internal')) return true
  if (lower.endsWith('.local')) return true
  // IPv4 literals
  const v4 = lower.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
  }
  // IPv6 loopback / link-local
  if (lower === '::1') return true
  if (lower.startsWith('fe80:')) return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  return false
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string }> {
  const buf = await fetchWithCaps(url, HTML_MAX_BYTES, [
    'text/html',
    'application/xhtml+xml',
    'application/xml',
  ])
  return { html: buf.body.toString('utf8'), finalUrl: buf.finalUrl }
}

type FetchedBlob = { body: Buffer; mimeType: string; finalUrl: string }

async function fetchWithCaps(
  url: string,
  maxBytes: number,
  acceptPrefixes: string[],
): Promise<FetchedBlob> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'follow',
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new WebExtractError('FETCH_FAILED', `HTTP ${res.status} from ${url}`)
    }
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (acceptPrefixes.length > 0 && !acceptPrefixes.some((p) => mimeType.startsWith(p))) {
      throw new WebExtractError('NOT_HTML', `Unexpected content-type ${mimeType} from ${url}`)
    }
    // Verify the resolved host is still safe after redirects.
    const finalUrl = res.url || url
    const finalParsed = new URL(finalUrl)
    if (isPrivateHost(finalParsed.hostname)) {
      throw new WebExtractError(
        'PRIVATE_HOST',
        `Redirected to private host ${finalParsed.hostname}`,
      )
    }
    // Stream into a buffer with the byte cap enforced — defends against
    // misreported content-length / chunked responses larger than declared.
    const reader = res.body?.getReader()
    if (!reader) {
      throw new WebExtractError('FETCH_FAILED', 'No response body')
    }
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          throw new WebExtractError('TOO_LARGE', `Response exceeded ${maxBytes} bytes`)
        }
        chunks.push(value)
      }
    }
    return { body: Buffer.concat(chunks), mimeType, finalUrl }
  } catch (e) {
    if (e instanceof WebExtractError) throw e
    if (e instanceof Error && e.name === 'AbortError') {
      throw new WebExtractError('TIMEOUT', `Fetch timed out for ${url}`)
    }
    throw new WebExtractError('FETCH_FAILED', e instanceof Error ? e.message : 'unknown')
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// HTML meta parsing
// ---------------------------------------------------------------------------

type ParsedMeta = {
  title: string
  description: string
  faviconUrl?: string
  ogImageUrl?: string
}

export function parseMeta(html: string, base: URL): ParsedMeta {
  const head = sliceHead(html)
  const ogTitle = matchMetaContent(head, /property=["']og:title["']/i)
  const titleTag = matchTag(head, /<title\b[^>]*>([\s\S]*?)<\/title>/i)
  const title = decodeEntities((ogTitle || titleTag || base.host).trim())

  const ogDesc = matchMetaContent(head, /property=["']og:description["']/i)
  const metaDesc = matchMetaContent(head, /name=["']description["']/i)
  const description = decodeEntities((ogDesc || metaDesc || '').trim())

  const ogImage = matchMetaContent(head, /property=["']og:image["']/i)
  const result: ParsedMeta = { title, description }
  if (ogImage) {
    const abs = absolutise(ogImage, base)
    if (abs) result.ogImageUrl = abs
  }

  const faviconHref = pickBestIcon(head)
  if (faviconHref) {
    const abs = absolutise(faviconHref, base)
    if (abs) result.faviconUrl = abs
  }

  return result
}

// Restrict pattern matching to the <head> when present — meta tags in the
// body are spec-violating and rare. Cheaper and safer.
function sliceHead(html: string): string {
  const open = html.search(/<head\b/i)
  const close = html.search(/<\/head>/i)
  if (open === -1 || close === -1 || close <= open) return html
  return html.slice(open, close)
}

function matchMetaContent(html: string, key: RegExp): string | null {
  // Match <meta {key} ... content="..."> in either attribute order.
  // Bounded by the next > to keep regex linear. Decode entities so URLs
  // with &amp;/&#38; round-trip cleanly.
  const tagRe = /<meta\b[^>]*>/gi
  for (const m of html.matchAll(tagRe)) {
    const tag = m[0]
    if (!key.test(tag)) continue
    const c = tag.match(/content=["']([^"']*)["']/i)
    if (c?.[1]) return decodeEntities(c[1])
  }
  return null
}

function matchTag(html: string, re: RegExp): string | null {
  const m = html.match(re)
  return m?.[1] ?? null
}

function pickBestIcon(head: string): string | null {
  // <link rel="icon" ...> — multiple may appear with different sizes.
  // Prefer the highest sizes="…" value; fall back to apple-touch-icon, then
  // any rel=icon, then the implicit /favicon.ico (handled by caller via
  // absolutise on null return).
  const tagRe = /<link\b[^>]*>/gi
  let best: { sizeScore: number; href: string } | null = null
  for (const m of head.matchAll(tagRe)) {
    const tag = m[0]
    if (!/rel=["'][^"']*(?:icon|apple-touch-icon)[^"']*["']/i.test(tag)) continue
    const hrefMatch = tag.match(/href=["']([^"']*)["']/i)
    // HTML entity-encode survives inside attribute values (e.g.
    // href="...?w=180&amp;h=180"); decode before treating it as a URL.
    const href = hrefMatch?.[1] ? decodeEntities(hrefMatch[1]) : null
    if (!href) continue
    const sizesMatch = tag.match(/sizes=["']([^"']*)["']/i)
    let sizeScore = 0
    if (sizesMatch?.[1]) {
      // "32x32" → 32. "any" → 9999 (SVG / vector icons preferred).
      if (/any/i.test(sizesMatch[1])) sizeScore = 9999
      else {
        const px = sizesMatch[1].match(/(\d+)/)
        if (px?.[1]) sizeScore = Number(px[1])
      }
    }
    // apple-touch-icon is usually 180×180 and high-quality; if no sizes
    // attribute, treat it as a 180 score.
    if (sizeScore === 0 && /apple-touch-icon/i.test(tag)) sizeScore = 180
    if (!best || sizeScore > best.sizeScore) best = { sizeScore, href }
  }
  return best?.href ?? null
}

function absolutise(href: string, base: URL): string | null {
  try {
    return new URL(href, base).toString()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Readable text
// ---------------------------------------------------------------------------

export function extractReadable(html: string): string {
  // Drop scripts, styles, and inline svg blocks wholesale — they're dense
  // and useless for tonal analysis.
  let cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, ' ')
  // Strip remaining tags. We treat block-level closers as soft line breaks
  // so the resulting prose retains paragraph boundaries.
  cleaned = cleaned
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|br|tr|td|th)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  cleaned = decodeEntities(cleaned)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  if (cleaned.length > WEB_EXCERPT_MAX) {
    cleaned = cleaned.slice(0, WEB_EXCERPT_MAX) + '…'
  }
  return cleaned
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
}

// ---------------------------------------------------------------------------
// Logo discovery
// ---------------------------------------------------------------------------

type LogoCandidate = { url: string; kind: 'favicon' | 'og' | 'header' }

function collectLogoCandidates(html: string, base: URL, meta: ParsedMeta): LogoCandidate[] {
  const out: LogoCandidate[] = []
  if (meta.faviconUrl) out.push({ url: meta.faviconUrl, kind: 'favicon' })
  if (meta.ogImageUrl) out.push({ url: meta.ogImageUrl, kind: 'og' })

  // Header img candidates — scan <header>, <nav>, and the first few <img>
  // tags of the document. Prefer images whose src/alt smells like a logo,
  // but fall back to "the first image inside the header" since many
  // brand pages don't tag their logo at all.
  const headerLike = [
    html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/i)?.[1],
    html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i)?.[1],
  ].filter(Boolean) as string[]
  for (const region of headerLike) {
    const explicit: string[] = []
    const fallback: string[] = []
    for (const m of region.matchAll(/<img\b[^>]*>/gi)) {
      const tag = m[0]
      const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1]
      const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? ''
      if (!src) continue
      const abs = absolutise(decodeEntities(src), base)
      if (!abs) continue
      if (/logo|brand|wordmark|mark/i.test(src) || /logo|brand|wordmark/i.test(alt)) {
        explicit.push(abs)
      } else {
        fallback.push(abs)
      }
    }
    // Add up to 2 explicit-logo candidates per region, then 1 fallback
    // image (the natural top-of-page graphic if no logo-named img exists).
    explicit.slice(0, 2).forEach((url) => out.push({ url, kind: 'header' }))
    if (explicit.length === 0 && fallback[0]) {
      out.push({ url: fallback[0], kind: 'header' })
    }
  }

  // Universal favicon fallbacks — always try these paths even when a
  // <link rel="icon"> was declared, because the declared one is often
  // a tiny 16×16 .ico while /apple-touch-icon.png is a clean 180×180
  // and lives at a known location on most modern sites.
  out.push({ url: new URL('/apple-touch-icon.png', base).toString(), kind: 'favicon' })
  if (!meta.faviconUrl) {
    out.push({ url: new URL('/favicon.ico', base).toString(), kind: 'favicon' })
  }

  // Dedupe by URL.
  const seen = new Set<string>()
  return out.filter((c) => {
    if (seen.has(c.url)) return false
    seen.add(c.url)
    return true
  })
}

async function downloadAndSaveImage(
  candidate: LogoCandidate,
  userId: string,
): Promise<ImageData | null> {
  const parsed = (() => {
    try {
      return new URL(candidate.url)
    } catch {
      return null
    }
  })()
  if (!parsed) return null
  if (isPrivateHost(parsed.hostname)) return null
  // Some CDNs return application/octet-stream (or nothing) for images.
  // Accept image/* primarily, but also any response whose URL clearly
  // points at an image file by extension. Magic-byte sniff catches the
  // remaining cases.
  const urlExt = parsed.pathname
    .toLowerCase()
    .match(/\.(png|jpe?g|webp|gif|svg|avif|ico|bmp)(?:$|\?)/)
  const acceptPrefixes = urlExt ? [] : ['image/']
  const blob = await fetchWithCaps(candidate.url, IMAGE_MAX_BYTES, acceptPrefixes)
  const sniffedMime = sniffImageMime(blob.body) ?? blob.mimeType
  // If we still can't identify it as an image, bail rather than save garbage.
  if (!sniffedMime.startsWith('image/')) return null
  const ext = extForMime(sniffedMime) ?? extForUrl(parsed.pathname) ?? 'bin'
  const id = nanoid()
  const saved = await saveUpload(blob.body, id, ext, sniffedMime)
  // Asset row is what makes GET /api/files/{filename} reachable for this
  // user — the route enforces ownership via the asset table, so a file
  // on disk without a row is effectively 404'd. Mirrors the same pattern
  // as the Drive image-import branch in routes/external.ts:recordAsset.
  // db is imported lazily so unit tests (which exercise the pure
  // helpers below without env vars) don't try to dial Postgres at
  // module load.
  const { db, schema } = await import('../db')
  await db.insert(schema.asset).values({
    id: nanoid(),
    userId,
    filename: saved.filename,
    mimeType: sniffedMime,
    size: saved.size,
    kind: 'upload',
  })
  return { url: `/api/files/${saved.filename}` }
}

// Detect common image formats from the leading magic bytes. Returns
// null for anything we don't recognise, so the caller can decide to
// fall back to a less reliable signal (URL extension, content-type).
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  // GIF: 47 49 46 38 (37|39) 61
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return 'image/webp'
  // ICO: 00 00 01 00
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00)
    return 'image/x-icon'
  // SVG (text-based) — look for "<svg" or "<?xml" within the first 200 bytes.
  const head = buf.slice(0, 200).toString('utf8').toLowerCase()
  if (head.includes('<svg') || (head.includes('<?xml') && head.includes('svg')))
    return 'image/svg+xml'
  // AVIF / HEIC: ftypavif / ftypheic at byte 4
  if (buf.slice(4, 8).toString() === 'ftyp') {
    const brand = buf.slice(8, 12).toString().toLowerCase()
    if (brand.startsWith('avif')) return 'image/avif'
    if (brand.startsWith('heic') || brand.startsWith('heix')) return 'image/heic'
  }
  return null
}

function extForUrl(pathname: string): string | null {
  const m = pathname.toLowerCase().match(/\.([a-z0-9]+)(?:$|\?)/)
  return m?.[1] ?? null
}

function extForMime(mime: string): string | null {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/svg+xml':
      return 'svg'
    case 'image/avif':
      return 'avif'
    case 'image/x-icon':
    case 'image/vnd.microsoft.icon':
      return 'ico'
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Palette sampling
// ---------------------------------------------------------------------------

function pickPaletteSource(candidates: LogoCandidate[], saved: ImageData[]): LogoCandidate | null {
  // Prefer the OG image (full-bleed hero) for palette — favicons are
  // usually too small / monochrome to give a real read. Fall back to any
  // saved image so we still get a swatch row.
  const og = candidates.find((c) => c.kind === 'og')
  if (og) return og
  if (saved[0]) return { url: saved[0].url, kind: 'favicon' }
  return null
}

async function samplePalette(source: LogoCandidate): Promise<{ hex: string; role: string }[]> {
  try {
    // Fetch the image bytes. If `source.url` is one of our own saved
    // /api/files/ URLs we'd need to resolve to disk — but the palette
    // sources are always the original remote OG URL captured in the
    // candidates list, so a fresh fetch is fine.
    const isLocal = source.url.startsWith('/api/files/')
    let bytes: Buffer
    if (isLocal) {
      // Read from disk via the upload helper. Currently the palette
      // source picker only returns remote URLs for OG images; this branch
      // is here for the fallback path which uses `saved[0].url`.
      const { readFile } = await import('node:fs/promises')
      const { uploadPath } = await import('./storage')
      const filename = source.url.replace('/api/files/', '')
      bytes = await readFile(uploadPath(filename))
    } else {
      const blob = await fetchWithCaps(source.url, IMAGE_MAX_BYTES, ['image/'])
      bytes = blob.body
    }
    const img = await loadImage(bytes)
    if (!img.width || !img.height) return []
    // Downscale to a small thumb — counting frequencies on a 64×64 grid is
    // plenty precise and much cheaper than the original.
    const targetW = 64
    const targetH = Math.max(1, Math.round((img.height / img.width) * 64))
    const canvas = createCanvas(targetW, targetH)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, targetW, targetH)
    const pixels = ctx.getImageData(0, 0, targetW, targetH).data

    // Quantise to 5-bits-per-channel (32 buckets each), count, sort.
    const buckets = new Map<number, { count: number; r: number; g: number; b: number }>()
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i]!
      const g = pixels[i + 1]!
      const b = pixels[i + 2]!
      const a = pixels[i + 3]!
      if (a < 128) continue
      // Drop near-greys and near-whites/blacks — they dominate logo
      // backgrounds and aren't useful brand colour signal.
      const maxC = Math.max(r, g, b)
      const minC = Math.min(r, g, b)
      const sat = maxC === 0 ? 0 : (maxC - minC) / maxC
      const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      if (sat < 0.12 && (luma > 0.92 || luma < 0.08)) continue
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      const bucket = buckets.get(key)
      if (bucket) {
        bucket.count += 1
        bucket.r += r
        bucket.g += g
        bucket.b += b
      } else {
        buckets.set(key, { count: 1, r, g, b })
      }
    }
    const top = [...buckets.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, PALETTE_SIZE)
      .map((b) => {
        const r = Math.round(b.r / b.count)
        const g = Math.round(b.g / b.count)
        const bb = Math.round(b.b / b.count)
        return rgbToHex(r, g, bb)
      })
    const roles = ['primary', 'secondary', 'accent', 'support', 'support']
    return top.map((hex, i) => ({ hex, role: roles[i] ?? 'support' }))
  } catch {
    return []
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => n.toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase()
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export function extractFonts(html: string): { family: string; role: 'display' | 'body' }[] {
  const head = sliceHead(html)
  const families = new Set<string>()

  // Google Fonts links — the family list lives in the ?family= query.
  const linkRe = /<link\b[^>]*\bhref=["']([^"']*fonts\.googleapis\.com[^"']*)["'][^>]*>/gi
  for (const m of head.matchAll(linkRe)) {
    try {
      const u = new URL(m[1]!)
      const fam = u.searchParams.get('family') ?? ''
      // family=Inter:wght@400;700&family=Newsreader
      for (const segment of fam.split('&')) {
        const name = segment.split(':')[0]?.replace(/\+/g, ' ').trim()
        if (name) families.add(name)
      }
      // Newer URL form: ?family=Inter&display=swap repeated.
      for (const v of u.searchParams.getAll('family')) {
        const name = v.split(':')[0]?.replace(/\+/g, ' ').trim()
        if (name) families.add(name)
      }
    } catch {
      // skip malformed
    }
  }

  // @font-face decls + body { font-family } heuristic inside inline
  // <style> blocks. Materialise to an array — matchAll returns a
  // single-pass iterator and we walk the blocks twice.
  const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
  for (const m of styleBlocks) {
    const css = m[1] ?? ''
    const ffMatches = css.matchAll(/@font-face\s*\{[^}]*font-family\s*:\s*['"]?([^'";}]+)/gi)
    for (const ff of ffMatches) {
      const name = ff[1]?.trim()
      if (name) families.add(name)
    }
  }
  for (const m of styleBlocks) {
    const css = m[1] ?? ''
    const bodyFont = css.match(/\bbody\s*\{[^}]*font-family\s*:\s*([^;}]+)/i)
    if (bodyFont?.[1]) {
      const first = bodyFont[1].split(',')[0]?.replace(/['"]/g, '').trim()
      if (first) families.add(first)
    }
  }

  // Cast to display/body roles — without semantic info we assign the first
  // family to `display` (usually the headline face) and the rest to `body`.
  const list = [...families].slice(0, 4)
  return list.map((family, i) => ({
    family,
    role: i === 0 ? ('display' as const) : ('body' as const),
  }))
}
