import Anthropic from '@anthropic-ai/sdk'
import type {
  AgentId,
  CanvasObject,
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

  let imageCount = 0
  let pdfCount = 0
  for (const o of objects) {
    if (o.type === 'image' && isImageData(o.data)) {
      const block = await loadImageBlock(o.data.url)
      if (block) {
        content.push(block)
        imageCount += 1
      }
    } else if (o.type === 'pdf' && isPdfData(o.data)) {
      const block = await loadPdfThumbBlock(o.data.thumbnailUrl)
      if (block) {
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
      textLines.push(`- Text label: "${t}"`)
    } else if (o.type === 'pdf' && isPdfData(o.data)) {
      const raw = o.data.extractedText.trim()
      if (raw) {
        const excerpt = raw.length > PDF_EXCERPT_MAX ? `${raw.slice(0, PDF_EXCERPT_MAX)}…` : raw
        pdfExcerpts.push(`--- PDF excerpt ---\n${excerpt}\n--- end PDF ---`)
      }
    }
  }

  const header = [
    `Group: ${imageCount} image(s), ${pdfCount} PDF(s), ${stickyCount} sticky note(s), ${textCount} text label(s).`,
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
        'PDF contents (treat as documents being referenced, not the final design — read for ideas, voice, subject matter):\n\n' +
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
  const v = 'v3'
  return `${agentId}@${depth === 'fast' ? FAST_MODEL : DEEP_MODEL}@${v}`
}

export function synthesisModelTag(agentIds: AgentId[], depth: AnalysisDepth): string {
  // v3 — added positioning / references / tensions / bodyCopy fields. Old
  // v2 cache entries would parse (extra fields tolerated by zod by default)
  // but wouldn't have the new content, so we'd serve stale stripped-down
  // briefs from cache. Bump to force a fresh synth.
  const v = 'v3'
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
