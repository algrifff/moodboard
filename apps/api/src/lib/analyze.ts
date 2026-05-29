import Anthropic from '@anthropic-ai/sdk'
import type {
  AgentId,
  CanvasObject,
  FontData,
  ImageData,
  PDFData,
  StickyData,
  TextData,
} from '@moodboard/shared'
import { readFile } from 'node:fs/promises'
import { getAgent, SYNTHESIZER } from './agents'
import { isSafeFilename, pdfThumbPath, uploadPath } from './storage'
import { mimeFromExt } from './upload-validation'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
if (!ANTHROPIC_API_KEY) {
  console.warn('ANTHROPIC_API_KEY not set — /api/boards/:id/analyze will 503')
}

// Sonnet by default — the quality lift over Haiku is worth the 3× cost,
// and the content-hash cache makes repeat reads free.
export const FAST_MODEL = 'claude-haiku-4-5'
export const DEEP_MODEL = 'claude-sonnet-4-6'
export type AnalysisDepth = 'fast' | 'deep'
export const DEFAULT_DEPTH: AnalysisDepth = 'deep'

const client = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null

// System prompts and output schemas live in agents.ts. This module is the
// content builder + Anthropic transport — agent-agnostic.

function isImageData(d: CanvasObject['data']): d is ImageData {
  return 'url' in d && typeof (d as ImageData).url === 'string'
}
function isStickyData(d: CanvasObject['data']): d is StickyData {
  return 'color' in d && typeof (d as StickyData).color === 'string'
}
function isTextData(d: CanvasObject['data']): d is TextData {
  return 'font' in d && typeof (d as TextData).font === 'string' && 'fontSize' in d
}
function isPdfData(d: CanvasObject['data']): d is PDFData {
  return (
    'extractedText' in d && 'thumbnailUrl' in d && typeof (d as PDFData).thumbnailUrl === 'string'
  )
}
function isFontData(d: CanvasObject['data']): d is FontData {
  return 'family' in d && typeof (d as FontData).family === 'string'
}

function urlToFilename(url: string): string | null {
  const m = url.match(/^\/api\/files\/([^/]+)$/)
  return m && m[1] ? m[1] : null
}

const MAX_BYTES_PER_IMAGE = 4 * 1024 * 1024

type ImageBlock = {
  type: 'image'
  source: {
    type: 'base64'
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    data: string
  }
}

async function loadImageBlock(url: string): Promise<ImageBlock | null> {
  const filename = urlToFilename(url)
  if (!filename || !isSafeFilename(filename)) return null
  let buffer: Buffer
  try {
    buffer = await readFile(uploadPath(filename))
  } catch {
    return null
  }
  if (buffer.byteLength > MAX_BYTES_PER_IMAGE) {
    console.warn(
      `analyze: skipping ${filename} (${buffer.byteLength} bytes > ${MAX_BYTES_PER_IMAGE})`,
    )
    return null
  }
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const mime = mimeFromExt(ext)
  if (
    mime !== 'image/jpeg' &&
    mime !== 'image/png' &&
    mime !== 'image/gif' &&
    mime !== 'image/webp'
  ) {
    return null
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: mime, data: buffer.toString('base64') },
  }
}

async function loadPdfThumbBlock(url: string): Promise<ImageBlock | null> {
  const filename = urlToFilename(url)
  if (!filename || !isSafeFilename(filename)) return null
  let buffer: Buffer
  try {
    buffer = await readFile(pdfThumbPath(filename))
  } catch {
    return null
  }
  if (buffer.byteLength > MAX_BYTES_PER_IMAGE) return null
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64') },
  }
}

type ContentBlock = ImageBlock | { type: 'text'; text: string }

/** Build the multi-modal content array for a group — agent-agnostic. */
async function buildGroupContent(objects: CanvasObject[]): Promise<ContentBlock[]> {
  const content: ContentBlock[] = []

  // Collect font specimens up front so we can emit them as their own
  // dedicated block at the top of the message. When they were buried
  // inside the regular text-lines section, the AD often ignored them
  // in favour of typography it inferred from PDF excerpts.
  const fonts: FontData[] = []
  for (const o of objects) {
    if (o.type === 'font' && isFontData(o.data)) fonts.push(o.data)
  }

  let imageCount = 0
  let pdfCount = 0
  for (const o of objects) {
    if (o.type === 'image' && isImageData(o.data)) {
      const block = await loadImageBlock(o.data.url)
      if (block) {
        // Label the image with its URL so the AD can write the URL back
        // when identifying a logo. Without this, agents have no stable
        // identifier to refer to images.
        content.push({ type: 'text', text: `Image URL: ${o.data.url}` })
        content.push(block)
        imageCount += 1
      }
    } else if (o.type === 'pdf' && isPdfData(o.data)) {
      const block = await loadPdfThumbBlock(o.data.thumbnailUrl)
      if (block) {
        content.push({ type: 'text', text: `PDF thumbnail URL: ${o.data.thumbnailUrl}` })
        content.push(block)
        pdfCount += 1
      }
    }
  }

  const textLines: string[] = []
  const pdfExcerpts: string[] = []
  // Per-PDF excerpt cap — keeps the prompt bounded when several PDFs land
  // in the same group. Whole-document analysis isn't the job; setting the
  // tone is.
  const PDF_EXCERPT_MAX = 4000
  let stickyCount = 0
  let textCount = 0
  for (const o of objects) {
    if (o.type === 'sticky' && isStickyData(o.data)) {
      stickyCount += 1
      const t = o.data.text.trim() || '(empty)'
      textLines.push(`- Sticky note (color ${o.data.color}): "${t}"`)
    } else if (o.type === 'text' && isTextData(o.data)) {
      textCount += 1
      const t = o.data.text.trim() || '(empty)'
      // Surface the user-chosen font + size — this is ground truth for the
      // AD's `fonts` field. Without it the AD would have to guess from
      // image evidence alone.
      textLines.push(
        `- Text label: "${t}" [font: ${o.data.font}, size: ${Math.round(o.data.fontSize)}px]`,
      )
    } else if (o.type === 'pdf' && isPdfData(o.data)) {
      const raw = o.data.extractedText.trim()
      if (raw) {
        const excerpt = raw.length > PDF_EXCERPT_MAX ? `${raw.slice(0, PDF_EXCERPT_MAX)}…` : raw
        pdfExcerpts.push(`--- PDF excerpt ---\n${excerpt}\n--- end PDF ---`)
      }
    }
  }

  // BRAND FONTS — emitted before any other text content. This is the
  // highest-trust signal for the AD's `fonts` field: the user
  // physically uploaded a font file and dropped it on the moodboard.
  // PDFs and photography are secondary; uploaded fonts dictate.
  if (fonts.length > 0) {
    const lines = fonts
      .map((f, i) => {
        const fmt = f.url.endsWith('.woff2')
          ? 'woff2'
          : f.url.endsWith('.woff')
            ? 'woff'
            : f.url.endsWith('.otf')
              ? 'otf'
              : 'ttf'
        return `  ${i + 1}. "${f.family}" (uploaded ${fmt})`
      })
      .join('\n')
    content.push({
      type: 'text',
      text:
        '=== BRAND FONTS — UPLOADED BY THE USER ===\n' +
        "The user has uploaded the following typeface file(s) and placed them on the moodboard. These are the brand's deliberately-chosen typefaces. Each of these MUST appear as an entry in your `fonts` output field, with `name` copied verbatim. Do not skip an uploaded font in favour of typography you inferred from a PDF excerpt or an image — uploaded fonts override every other source.\n\n" +
        lines +
        '\n=== END BRAND FONTS ===',
    })
  }

  const header = [
    `Group: ${imageCount} image(s), ${pdfCount} PDF(s), ${stickyCount} sticky note(s), ${textCount} text label(s), ${fonts.length} uploaded font(s).`,
    textLines.length > 0
      ? '\nText content:'
      : pdfExcerpts.length > 0
        ? ''
        : '\n(No text content — work purely from the images and sticky colours.)',
    ...textLines,
  ].join('\n')
  content.push({ type: 'text', text: header })
  if (pdfExcerpts.length > 0) {
    content.push({
      type: 'text',
      text:
        'PDF contents (treat as reference material — read for subject matter, voice, and visual references). PDF layout typography is incidental and does NOT dictate the brand\'s chosen fonts. BUT if a PDF excerpt explicitly names a typeface ("use Helvetica", "set in Akzidenz Grotesk", etc.), treat that name as a deliberate typography reference and count it for the fonts field.\n\n' +
        pdfExcerpts.join('\n\n'),
    })
  }
  content.push({ type: 'text', text: 'Give me the read.' })
  return content
}

/**
 * Run a single agent against a group. Returns the agent-specific data
 * (validated against the agent's zod schema).
 */
export async function analyzeGroup(
  objects: CanvasObject[],
  agentId: AgentId,
  depth: AnalysisDepth = DEFAULT_DEPTH,
): Promise<unknown> {
  if (!client) {
    throw new Error('Anthropic client not configured (ANTHROPIC_API_KEY missing)')
  }
  const agent = getAgent(agentId)
  const model = depth === 'fast' ? FAST_MODEL : DEEP_MODEL
  const content = await buildGroupContent(objects)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: Anthropic.Message = (await client.messages.create({
    model,
    max_tokens: agent.maxTokens,
    system: [
      {
        type: 'text',
        text: agent.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output_config: {
      format: { type: 'json_schema', schema: agent.jsonSchema },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)) as Anthropic.Message

  let parsed: unknown
  for (const block of response.content) {
    if (block.type === 'text') {
      try {
        parsed = JSON.parse(block.text)
        break
      } catch {
        // try next block
      }
    }
  }
  if (parsed === undefined) {
    throw new Error('Claude returned no parseable JSON output')
  }
  const result = agent.outputSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Agent ${agent.id} JSON failed schema: ${result.error.message}`)
  }
  return result.data
}

export function modelTag(agentId: AgentId, depth: AnalysisDepth): string {
  // Suffix bumps invalidate the on-disk cache when the schema changes.
  // v3 = agent registry introduction (different cache bucket per agent).
  // v4 = AIAnalysis gained logo + fonts fields; prompt + content builder
  //      changed (image URL labels, text-node font metadata).
  // v5 = font specimen objects emit ground-truth family name in the
  //      content builder; group header gained a font-count line.
  // v6 = uploaded fonts emitted as a dedicated top-of-prompt BRAND
  //      FONTS block with MUST-INCLUDE instructions; PDF excerpt
  //      preamble explicitly notes typography in PDFs is incidental;
  //      AD prompt restructured to enforce strict trust hierarchy.
  // v7 = font priority re-ordered: photos with type rank above text-
  //      node and PDF content, which only count when they explicitly
  //      name a typeface. CSS-fallback-stack text-node font tags are
  //      now explicitly in the IGNORE list.
  // v8 = logo schema changed from single object to array — AD now
  //      returns every mark variant (wordmark, icon, colour variants).
  const v = 'v8'
  return `${agentId}@${depth === 'fast' ? FAST_MODEL : DEEP_MODEL}@${v}`
}

export function synthesisModelTag(agentIds: AgentId[], depth: AnalysisDepth): string {
  // v3 — added positioning / references / tensions / bodyCopy fields.
  // v4 — added logo + fonts; dropped typography.samples (consolidated
  //      into fonts). AD prompt changes (image URL labels, text-node
  //      font metadata) also affect synth inputs, so bumping here too.
  // v5 — font specimen objects emit ground-truth family in the AD
  //      content; downstream synthesis input changes too.
  // v6 — uploaded fonts now in a dedicated BRAND FONTS block at the
  //      top of the AD prompt; downstream synth inputs change.
  // v7 — font priority hierarchy re-ordered (photos > text/PDF unless
  //      explicit naming); AD output shape unchanged but content
  //      shifts noticeably, so downstream synth needs to re-run.
  // v8 — logo schema is now an array; downstream synth output shape
  //      changed to match.
  const v = 'v8'
  const sorted = [...agentIds].sort().join(',')
  return `synth:${sorted}@${depth === 'fast' ? FAST_MODEL : DEEP_MODEL}@${v}`
}

/**
 * Synthesise a unified read from multiple agents' outputs. The moodboard's
 * content + each agent's read are fed in as context for the synthesiser.
 */
export async function synthesizeGroup(
  objects: CanvasObject[],
  agentResults: Array<{ id: AgentId; label: string; data: unknown }>,
  depth: AnalysisDepth = DEFAULT_DEPTH,
): Promise<unknown> {
  if (!client) {
    throw new Error('Anthropic client not configured (ANTHROPIC_API_KEY missing)')
  }
  const model = depth === 'fast' ? FAST_MODEL : DEEP_MODEL
  const content = await buildGroupContent(objects)

  // Append each prior agent's output as a labelled text block so the
  // synthesiser can read them as separate "specialist takes."
  for (const r of agentResults) {
    const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2)
    content.push({
      type: 'text',
      text: `--- ${r.label}'s read ---\n${body}\n--- end ${r.label}'s read ---`,
    })
  }
  content.push({
    type: 'text',
    text: 'Now: synthesise these into one unified read.',
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: Anthropic.Message = (await client.messages.create({
    model,
    max_tokens: SYNTHESIZER.maxTokens,
    system: [
      {
        type: 'text',
        text: SYNTHESIZER.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output_config: {
      format: { type: 'json_schema', schema: SYNTHESIZER.jsonSchema },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)) as Anthropic.Message

  let parsed: unknown
  for (const block of response.content) {
    if (block.type === 'text') {
      try {
        parsed = JSON.parse(block.text)
        break
      } catch {
        // try next
      }
    }
  }
  if (parsed === undefined) {
    throw new Error('Claude returned no parseable JSON output')
  }
  const result = SYNTHESIZER.outputSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Synthesiser JSON failed schema: ${result.error.message}`)
  }
  return result.data
}
