// Dominant colours from RGBA pixels: quantise to 5 bits per channel, count,
// and take the most frequent buckets. Shared by the web-page importer and the
// asset library so both read colour the same way.

export type DominantColorOptions = {
  max?: number
  // Skip a bucket this close (RGB euclidean distance) to one already taken,
  // so five shades of one blue don't crowd out the second colour.
  minDistance?: number
  // Near-greys, whites and blacks dominate logo backgrounds and are weak
  // brand signal. When nothing else is left, a monochrome image would have no
  // colours at all, so callers can opt back in.
  fallbackToNeutrals?: boolean
}

type Bucket = { count: number; r: number; g: number; b: number }

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => n.toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase()
}

function isNeutral(r: number, g: number, b: number): boolean {
  const maxC = Math.max(r, g, b)
  const minC = Math.min(r, g, b)
  const sat = maxC === 0 ? 0 : (maxC - minC) / maxC
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return sat < 0.12 && (luma > 0.92 || luma < 0.08)
}

function bucketise(pixels: ArrayLike<number>, skipNeutrals: boolean): Bucket[] {
  const buckets = new Map<number, Bucket>()
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i]!
    const g = pixels[i + 1]!
    const b = pixels[i + 2]!
    if (pixels[i + 3]! < 128) continue
    if (skipNeutrals && isNeutral(r, g, b)) continue
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
  return [...buckets.values()].sort((a, b) => b.count - a.count)
}

export function dominantColors(
  pixels: ArrayLike<number>,
  options: DominantColorOptions = {},
): string[] {
  const { max = 5, minDistance = 0, fallbackToNeutrals = false } = options
  let buckets = bucketise(pixels, true)
  if (buckets.length === 0 && fallbackToNeutrals) buckets = bucketise(pixels, false)

  const picked: [number, number, number][] = []
  for (const b of buckets) {
    if (picked.length >= max) break
    const rgb: [number, number, number] = [
      Math.round(b.r / b.count),
      Math.round(b.g / b.count),
      Math.round(b.b / b.count),
    ]
    const tooClose = picked.some(
      (p) => Math.hypot(p[0] - rgb[0], p[1] - rgb[1], p[2] - rgb[2]) < minDistance,
    )
    if (!tooClose) picked.push(rgb)
  }
  return picked.map(([r, g, b]) => toHex(r, g, b))
}
