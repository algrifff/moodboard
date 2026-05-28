// Lazy, idempotent loader for the browser pdfjs build. Both the PDF widget
// on the canvas and the click-to-preview modal go through this so the worker
// gets configured exactly once, regardless of which mounts first.

type PdfjsModule = typeof import('pdfjs-dist')

let cached: Promise<PdfjsModule> | null = null

export function getPdfjs(): Promise<PdfjsModule> {
  if (!cached) {
    cached = import('pdfjs-dist').then((m) => {
      // Vite emits the worker as its own chunk; we hand the URL to pdf.js
      // and it spins up the worker for rendering off the main thread.
      m.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.mjs',
        import.meta.url,
      ).toString()
      return m
    })
  }
  return cached
}

// Per-PDF per-page cache so flipping back and forth across the same widget
// is instant after the first render. Module-scope keeps it alive across the
// lifetime of the page.
const pageCache = new Map<string, HTMLCanvasElement>()

function pageKey(url: string, page: number): string {
  return `${url}#${page}`
}

export function getCachedPage(url: string, page: number): HTMLCanvasElement | null {
  return pageCache.get(pageKey(url, page)) ?? null
}

export function setCachedPage(url: string, page: number, canvas: HTMLCanvasElement): void {
  pageCache.set(pageKey(url, page), canvas)
}

// Render a single PDF page into an offscreen canvas at the target width.
// Returns the canvas; the caller chooses to keep it (and cache it) or not.
export async function renderPdfPage(
  url: string,
  page: number,
  targetWidth: number,
): Promise<HTMLCanvasElement> {
  const pdfjs = await getPdfjs()
  const doc = await pdfjs.getDocument({ url, withCredentials: true }).promise
  try {
    const p = await doc.getPage(page)
    const viewport0 = p.getViewport({ scale: 1 })
    const scale = targetWidth / viewport0.width
    const viewport = p.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No 2D context available')
    await p.render({ canvas, canvasContext: ctx, viewport }).promise
    return canvas
  } finally {
    await doc.destroy()
  }
}
