import type { CanvasObject, StickyData, ImageData } from '@moodboard/shared'
import { Vibrant } from 'node-vibrant/browser'

export type Swatch = { hex: string; population: number }

const imagePaletteCache = new Map<string, Swatch[]>()

function isImageData(data: CanvasObject['data']): data is ImageData {
  return 'url' in data && typeof (data as ImageData).url === 'string'
}

function isStickyData(data: CanvasObject['data']): data is StickyData {
  return 'color' in data && typeof (data as StickyData).color === 'string'
}

async function paletteFromImage(url: string): Promise<Swatch[]> {
  const cached = imagePaletteCache.get(url)
  if (cached) return cached
  const palette = await Vibrant.from(url).getPalette()
  const swatches: Swatch[] = []
  for (const key of Object.keys(palette)) {
    const s = palette[key]
    if (s) swatches.push({ hex: s.hex, population: s.population })
  }
  imagePaletteCache.set(url, swatches)
  return swatches
}

function dedupe(swatches: Swatch[]): Swatch[] {
  const seen = new Map<string, Swatch>()
  for (const s of swatches) {
    const key = s.hex.toLowerCase()
    const existing = seen.get(key)
    if (!existing || existing.population < s.population) {
      seen.set(key, { hex: key, population: s.population })
    }
  }
  return [...seen.values()]
}

export async function paletteFromGroup(
  objects: CanvasObject[],
  limit = 5,
): Promise<Swatch[]> {
  const all: Swatch[] = []
  const tasks: Promise<void>[] = []
  for (const o of objects) {
    if (o.type === 'image' && isImageData(o.data)) {
      tasks.push(
        paletteFromImage(o.data.url).then((s) => {
          all.push(...s)
        }),
      )
    } else if (o.type === 'sticky' && isStickyData(o.data)) {
      all.push({ hex: o.data.color.toLowerCase(), population: 1 })
    }
  }
  await Promise.all(tasks)
  return dedupe(all)
    .sort((a, b) => b.population - a.population)
    .slice(0, limit)
}
