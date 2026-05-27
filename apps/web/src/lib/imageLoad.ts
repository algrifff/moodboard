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

export function fitToDefaultSize(natural: ImageDimensions): ImageDimensions {
  const longest = Math.max(natural.width, natural.height)
  if (longest === 0) return { width: DEFAULT_LONGEST_SIDE, height: DEFAULT_LONGEST_SIDE }
  const scale = DEFAULT_LONGEST_SIDE / longest
  return {
    width: Math.round(natural.width * scale),
    height: Math.round(natural.height * scale),
  }
}
