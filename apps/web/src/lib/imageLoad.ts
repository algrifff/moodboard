export type ImageDimensions = { width: number; height: number }

export function loadImageDimensions(url: string): Promise<ImageDimensions> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`))
    img.src = url
  })
}

const DEFAULT_LONGEST_SIDE = 400
// PDFs land smaller — a portrait page at 240px longest side feels like a
// postcard, not a poster, when the user drops one onto a board next to
// existing imagery.
export const PDF_LONGEST_SIDE = 240

export function fitToDefaultSize(
  natural: ImageDimensions,
  longestSide = DEFAULT_LONGEST_SIDE,
): ImageDimensions {
  const longest = Math.max(natural.width, natural.height)
  if (longest === 0) return { width: longestSide, height: longestSide }
  const scale = longestSide / longest
  return {
    width: Math.round(natural.width * scale),
    height: Math.round(natural.height * scale),
  }
}
