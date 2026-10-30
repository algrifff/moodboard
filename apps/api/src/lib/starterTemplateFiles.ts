import {
  outputFormatSchema,
  templateViewportSchema,
  type OutputFormat,
  type TemplateViewport,
} from '@moodboard/shared'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

export const STARTER_KEYS = [
  'youtube-thumbnail',
  'social-post',
  'deck',
  'landing-page',
  'one-pager',
] as const

const metaSchema = z.object({
  name: z.string().min(1),
  format: outputFormatSchema,
  viewport: templateViewportSchema,
})

export type StarterTemplate = {
  key: string
  name: string
  format: OutputFormat
  viewport: TemplateViewport
  html: string
  css: string
  js: string
}

const DIR = new URL('../templates/', import.meta.url)

async function readOptional(url: URL): Promise<string> {
  try {
    return await readFile(url, 'utf8')
  } catch {
    return ''
  }
}

export async function loadStarterTemplates(): Promise<StarterTemplate[]> {
  return Promise.all(
    STARTER_KEYS.map(async (key) => {
      const dir = new URL(`${key}/`, DIR)
      const meta = metaSchema.parse(JSON.parse(await readFile(new URL('meta.json', dir), 'utf8')))
      const [html, css, js] = await Promise.all([
        readFile(new URL('template.html', dir), 'utf8'),
        readFile(new URL('template.css', dir), 'utf8'),
        readOptional(new URL('template.js', dir)),
      ])
      return { key, ...meta, html, css, js }
    }),
  )
}
