import { extractText, renderPageAsImage } from 'unpdf'
import { MAX_PDF_PAGES } from './upload-validation'

// Both text extraction and thumbnail rendering go through unpdf so a single
// pdfjs instance handles both. Importing pdfjs-dist directly here causes a
// worker / API version mismatch with the copy unpdf bundles internally.
const THUMBNAIL_PAGE = 1
const THUMBNAIL_TARGET_WIDTH = 600
const TEXT_MAX_CHARS = 50_000

export type PdfProcessResult = {
  text: string
  pageCount: number
  thumbnailPng: Buffer | null
}

export async function processPdf(buffer: Buffer): Promise<PdfProcessResult> {
  const data = new Uint8Array(buffer)

  // 1. Text extraction.
  const textResult = await extractText(data, { mergePages: true })
  const totalPages = textResult.totalPages
  if (totalPages > MAX_PDF_PAGES) {
    throw new Error(`PDF exceeds ${MAX_PDF_PAGES} pages (${totalPages})`)
  }
  const text = Array.isArray(textResult.text) ? textResult.text.join('\n\n') : textResult.text
  const truncatedText = text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}…` : text

  // 2. Thumbnail render. Cloning the data because pdfjs transfers TypedArrays
  // to its worker on first use, which would leave the previous view empty.
  let thumbnailPng: Buffer | null = null
  try {
    const arrayBuffer = await renderPageAsImage(new Uint8Array(buffer), THUMBNAIL_PAGE, {
      canvasImport: () => import('@napi-rs/canvas'),
      width: THUMBNAIL_TARGET_WIDTH,
    })
    thumbnailPng = Buffer.from(arrayBuffer as ArrayBuffer)
  } catch (e) {
    // Thumbnail failure is not fatal — text + the PDF itself still upload,
    // and the canvas widget falls back to client-side rendering anyway.
    console.warn('PDF thumbnail render failed', e)
  }

  return { text: truncatedText, pageCount: totalPages, thumbnailPng }
}

export function pdfThumbnailDimensions(): { width: number; height: number } {
  // Canonical default size for the canvas-side PDFNode (A4 ratio approx).
  return { width: 240, height: 320 }
}
