import Anthropic from '@anthropic-ai/sdk'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import { db, schema } from '../db'
import { captionImage, type CaptionClient } from './assetCaption'
import { dominantColors } from './imageColors'
import { uploadPath } from './storage'

// Fills in an asset's library metadata: dimensions, dominant colours and,
// when ANTHROPIC_API_KEY is set, a caption + tags. Cheap enough to run when
// an asset is recorded; anything missed (and every pre-library asset) is
// picked up by the maintenance tick via enrichPending().

const SAMPLE_EDGE = 64
const CAPTION_EDGE = 1024
const COLOR_COUNT = 5
const COLOR_MIN_DISTANCE = 48

let captionClient: CaptionClient | null | undefined

function defaultCaptionClient(): CaptionClient | null {
  if (captionClient !== undefined) return captionClient
  const apiKey = process.env.ANTHROPIC_API_KEY
  captionClient = apiKey ? new Anthropic({ apiKey }).messages : null
  return captionClient
}

type Measured = {
  width: number
  height: number
  colors: string[]
  jpegBase64: () => string
}

async function measureImage(bytes: Buffer): Promise<Measured | null> {
  let image
  try {
    image = await loadImage(bytes)
  } catch {
    return null
  }
  if (!image.width || !image.height) return null

  const sample = createCanvas(
    SAMPLE_EDGE,
    Math.max(1, Math.round((image.height / image.width) * SAMPLE_EDGE)),
  )
  const sctx = sample.getContext('2d')
  sctx.drawImage(image, 0, 0, sample.width, sample.height)
  const colors = dominantColors(sctx.getImageData(0, 0, sample.width, sample.height).data, {
    max: COLOR_COUNT,
    minDistance: COLOR_MIN_DISTANCE,
    fallbackToNeutrals: true,
  })

  return {
    width: image.width,
    height: image.height,
    colors,
    // Downscaled and flattened onto white: keeps the vision call small and
    // inside the API's image size limit whatever was uploaded.
    jpegBase64: () => {
      const scale = Math.min(1, CAPTION_EDGE / Math.max(image.width, image.height))
      const canvas = createCanvas(
        Math.max(1, Math.round(image.width * scale)),
        Math.max(1, Math.round(image.height * scale)),
      )
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      return canvas.toBuffer('image/jpeg', 80).toString('base64')
    },
  }
}

// One asset. The row is claimed first (enriched_at set), so two instances
// never caption the same image and a file that can't be read isn't retried
// forever; the metadata is then written over it.
export async function enrichAsset(
  id: string,
  client: CaptionClient | null = defaultCaptionClient(),
): Promise<void> {
  const [row] = await db
    .update(schema.asset)
    .set({ enrichedAt: new Date() })
    .where(and(eq(schema.asset.id, id), isNull(schema.asset.enrichedAt)))
    .returning()
  if (!row) return

  const patch: Partial<typeof schema.asset.$inferInsert> = {}
  if (row.mediaKind === 'image' && row.kind === 'upload') {
    try {
      const measured = await measureImage(await readFile(uploadPath(row.filename)))
      if (measured) {
        patch.width = measured.width
        patch.height = measured.height
        patch.colors = measured.colors
        if (client && !row.caption) {
          try {
            const result = await captionImage(client, {
              base64: measured.jpegBase64(),
              mediaType: 'image/jpeg',
            })
            if (result) {
              patch.caption = result.caption
              if (row.tags.length === 0) patch.tags = result.tags
            }
          } catch (e) {
            console.warn(
              '[library] captioning failed for',
              row.id,
              e instanceof Error ? e.message : e,
            )
          }
        }
      }
    } catch (e) {
      console.warn('[library] could not read', row.filename, e instanceof Error ? e.message : e)
    }
  }
  if (Object.keys(patch).length > 0) {
    await db.update(schema.asset).set(patch).where(eq(schema.asset.id, id))
  }
}

// Oldest-first backlog, bounded by count and wall-clock so one tick can't
// hog the event loop (decoding is synchronous inside napi-rs).
export async function enrichPending(
  options: { limit?: number; budgetMs?: number } = {},
): Promise<number> {
  const { limit = 200, budgetMs = 20_000 } = options
  const started = Date.now()
  const pending = await db
    .select({ id: schema.asset.id })
    .from(schema.asset)
    .where(isNull(schema.asset.enrichedAt))
    .orderBy(asc(schema.asset.createdAt))
    .limit(limit)
  let done = 0
  for (const { id } of pending) {
    if (Date.now() - started > budgetMs) break
    await enrichAsset(id)
    done++
  }
  return done
}
