import { createCanvas, loadImage } from '@napi-rs/canvas'

// A picture sized for a vision call: long edge capped (the API downsizes
// anything bigger anyway) and kept well under the per-image byte limit.

const EDGES = [1568, 1024, 640]
const MAX_BYTES = 3.5 * 1024 * 1024

export async function pngForModel(
  bytes: Buffer,
): Promise<{ png: Buffer; width: number; height: number }> {
  const image = await loadImage(bytes)
  let last: { png: Buffer; width: number; height: number } | null = null
  for (const edge of EDGES) {
    const scale = Math.min(1, edge / Math.max(image.width, image.height))
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const canvas = createCanvas(width, height)
    canvas.getContext('2d').drawImage(image, 0, 0, width, height)
    last = { png: canvas.toBuffer('image/png'), width, height }
    if (last.png.byteLength <= MAX_BYTES) return last
  }
  return last!
}
