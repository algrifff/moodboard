import type { CanvasObject, ImageData, PDFData, StickyData } from '@moodboard/shared'
import { Vibrant } from 'node-vibrant/browser'
import { isImageDead, markImageDead } from './imageHealth'

export type Swatch = { hex: string; population: number }

// Cache the per-image extraction so we don't re-decode the same image on
// every re-analysis. Key = image URL.
//
// Failures are handled via the shared imageHealth module — when Vibrant
// can't fetch the URL we mark it dead, and ImageNode (Konva render path)
// reads the same flag so it doesn't re-issue the same 404. The previous
// implementation only cached *successes*, so a board with an orphaned
// image would retry the 404 every time the palette widget re-rendered.
const imagePaletteCache = new Map<string, Swatch[]>()

// Skip the "Muted" / "DarkMuted" / "LightMuted" variants — they're the
// washed-out greys / blacks / off-whites that pollute a curated read.
// Vibrant variants are what designers actually call out as the palette.
const ALLOWED_VIBRANT_KEYS = new Set(['Vibrant', 'LightVibrant', 'DarkVibrant'])

function isImageData(data: CanvasObject['data']): data is ImageData {
  return 'url' in data && typeof (data as ImageData).url === 'string'
}

function isStickyData(data: CanvasObject['data']): data is StickyData {
  return 'color' in data && typeof (data as StickyData).color === 'string'
}

function isPdfData(data: CanvasObject['data']): data is PDFData {
  return 'thumbnailUrl' in data && typeof (data as PDFData).thumbnailUrl === 'string'
}

async function paletteFromImage(url: string): Promise<Swatch[]> {
  const cached = imagePaletteCache.get(url)
  if (cached) return cached
  // Short-circuit known-dead URLs — see lib/imageHealth for the rationale.
  // Returning [] means the URL contributes nothing to the group palette,
  // exactly like a successful-but-unsaturated image.
  if (isImageDead(url)) return []
  try {
    const palette = await Vibrant.from(url).getPalette()
    const swatches: Swatch[] = []
    for (const key of Object.keys(palette)) {
      if (!ALLOWED_VIBRANT_KEYS.has(key)) continue
      const s = palette[key]
      if (s) swatches.push({ hex: s.hex, population: s.population })
    }
    imagePaletteCache.set(url, swatches)
    return swatches
  } catch {
    markImageDead(url)
    return []
  }
}

function dedupe(swatches: Swatch[]): Swatch[] {
  // Merge same-hex contributions by summing weights; this is the canonical
  // "two images both pulled this colour → it's stronger" rollup.
  const seen = new Map<string, Swatch>()
  for (const s of swatches) {
    const key = s.hex.toLowerCase()
    const existing = seen.get(key)
    if (existing) {
      existing.population += s.population
    } else {
      seen.set(key, { hex: key, population: s.population })
    }
  }
  return [...seen.values()]
}

// Canvas-area weighting: bigger image → larger share of the palette.
// This lets the user steer the auto-palette by resizing images on the canvas —
// "make this image bigger" really does promote its colours.
export async function paletteFromGroup(objects: CanvasObject[], limit = 5): Promise<Swatch[]> {
  const all: Swatch[] = []
  const tasks: Promise<void>[] = []

  const collect = (url: string, area: number) =>
    paletteFromImage(url)
      .then((swatches) => {
        if (swatches.length === 0) return
        const total = swatches.reduce((sum, s) => sum + s.population, 0) || 1
        for (const s of swatches) {
          // Each image's swatches share a budget equal to that image's
          // canvas area. So a 400×400 image contributes 160k total weight,
          // distributed across its swatches by their vibrant population.
          const weight = (s.population / total) * area
          all.push({ hex: s.hex, population: weight })
        }
      })
      .catch(() => {
        // ignore individual image extraction failures; other images still contribute
      })

  for (const o of objects) {
    const area = Math.max(1, o.size.width * o.size.height)
    if (o.type === 'image' && isImageData(o.data)) {
      tasks.push(collect(o.data.url, area))
    } else if (o.type === 'pdf' && isPdfData(o.data) && o.data.thumbnailUrl) {
      // PDF cover contributes the same way as an image — proportionally to the
      // canvas tile size.
      tasks.push(collect(o.data.thumbnailUrl, area))
    } else if (o.type === 'sticky' && isStickyData(o.data)) {
      // Sticky's whole area is one colour, so its full area weight goes to that hex.
      all.push({ hex: o.data.color.toLowerCase(), population: area })
    }
  }

  await Promise.all(tasks)

  return dedupe(all)
    .sort((a, b) => b.population - a.population)
    .slice(0, limit)
}
