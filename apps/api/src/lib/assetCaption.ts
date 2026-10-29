import type Anthropic from '@anthropic-ai/sdk'
import { tagSchema } from '@moodboard/shared'
import { z } from 'zod'
import { FAST_MODEL } from './modelTags'

// One cheap vision pass per library image: a short factual caption and a few
// tags, so the asset is findable by what's in it. Runs only when an Anthropic
// key is configured — callers pass `null` otherwise and captions are skipped.

export type CaptionClient = Pick<Anthropic['messages'], 'create'>

export type ImageCaption = { caption: string; tags: string[] }

const MAX_TAGS = 6

const PROMPT = `You catalogue images for a design studio's asset library so people can find them by searching.

Reply with JSON only, no prose and no code fence:
{"caption": "...", "tags": ["...", "..."]}

- caption: one factual sentence, at most 140 characters. Say what it is (photo, logo, illustration, screenshot…), the subject, the dominant colours or style, and any legible text. No guessing at brands you cannot read.
- tags: 3 to 6 lowercase words or short phrases a designer would search for (subject, style, mood, medium).`

const responseSchema = z.object({
  caption: z.string(),
  tags: z.array(z.string()).default([]),
})

// Tolerates a code fence or a sentence around the JSON; returns null when no
// usable caption is in there.
export function parseCaptionResponse(text: string): ImageCaption | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const parsed = responseSchema.safeParse(raw)
  if (!parsed.success) return null
  const caption = parsed.data.caption.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!caption) return null
  const tags: string[] = []
  for (const t of parsed.data.tags) {
    const tag = tagSchema.safeParse(t)
    if (tag.success && !tags.includes(tag.data)) tags.push(tag.data)
    if (tags.length === MAX_TAGS) break
  }
  return { caption, tags }
}

export async function captionImage(
  client: CaptionClient,
  image: { base64: string; mediaType: 'image/jpeg' | 'image/png' },
): Promise<ImageCaption | null> {
  const response = await client.create({
    model: FAST_MODEL,
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
          },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  })
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
  return parseCaptionResponse(text)
}
