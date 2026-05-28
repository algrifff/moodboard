// Helpers for getting useful data out of a paste event.
//
// CRITICAL: ClipboardEvent.clipboardData becomes unreliable the moment the
// handler yields (any `await`). DataTransferItem.getAsFile() works
// synchronously, but DataTransferItem.getAsString() is callback-based — and
// the callback can stop firing once the event is "dead." The workaround is
// to kick off every read synchronously inside the handler and only await
// the resulting promises after.

export type ClipboardSnapshot = {
  imageBlobs: File[]
  pdfBlobs: File[]
  html: string | null
  text: string | null
}

export function captureClipboard(items: DataTransferItemList): Promise<ClipboardSnapshot> {
  const imageBlobs: File[] = []
  const pdfBlobs: File[] = []
  let htmlPromise: Promise<string> | null = null
  let textPromise: Promise<string> | null = null

  for (const item of Array.from(items)) {
    if (item.kind === 'file') {
      const blob = item.getAsFile()
      if (!blob) continue
      if (blob.type === 'application/pdf') pdfBlobs.push(blob)
      else if (blob.type.startsWith('image/')) imageBlobs.push(blob)
    } else if (item.kind === 'string') {
      if (item.type === 'text/html' && !htmlPromise) {
        htmlPromise = new Promise((resolve) => item.getAsString(resolve))
      } else if (item.type === 'text/plain' && !textPromise) {
        textPromise = new Promise((resolve) => item.getAsString(resolve))
      }
    }
  }

  return Promise.all([
    htmlPromise ?? Promise.resolve(null),
    textPromise ?? Promise.resolve(null),
  ]).then(([html, text]) => ({ imageBlobs, pdfBlobs, html, text }))
}

export type ImageHit = { kind: 'blob'; blob: Blob } | { kind: 'url'; url: string }

// Pull the first usable image URL out of a snippet of HTML.
export function extractImgSrc(html: string): string | null {
  if (!html) return null
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const img = doc.querySelector('img')
    if (!img) return null
    const src = img.getAttribute('src')
    if (src) return src
    // Some pasted HTML uses srcset only — take the first listed URL.
    const srcset = img.getAttribute('srcset')
    if (srcset) {
      const first = srcset.split(',')[0]?.trim().split(/\s+/)[0]
      if (first) return first
    }
    return null
  } catch {
    return null
  }
}

// Classify a raw string as either an image we can fetch as a blob (data: URI)
// or an http(s) URL the server-side proxy can fetch. Returns null when the
// value isn't image-shaped.
export async function urlToImageHit(value: string): Promise<ImageHit | null> {
  if (!value) return null
  if (value.startsWith('data:image/')) {
    try {
      const res = await fetch(value)
      const blob = await res.blob()
      if (blob.type.startsWith('image/')) return { kind: 'blob', blob }
    } catch {
      return null
    }
    return null
  }
  if (/^https?:\/\//i.test(value)) {
    return { kind: 'url', url: value }
  }
  return null
}
