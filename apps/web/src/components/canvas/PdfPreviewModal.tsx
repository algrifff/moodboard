import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { useEffect, useRef, useState } from 'react'
import { getPdfjs } from '@/lib/pdfClient'

const MAX_WIDTH = 900
const MAX_HEIGHT_VH = 0.9

export function PdfPreviewModal({
  url,
  name,
  onClose,
}: {
  url: string
  name: string
  onClose: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pageNum, setPageNum] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load the document once.
  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(null)
    let docToCleanup: PDFDocumentProxy | null = null
    ;(async () => {
      try {
        const pdfjs = await getPdfjs()
        const d = await pdfjs.getDocument({ url, withCredentials: true }).promise
        if (cancelled) {
          d.destroy()
          return
        }
        docToCleanup = d
        setDoc(d)
        setPageCount(d.numPages)
        setBusy(false)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load PDF')
        setBusy(false)
      }
    })()
    return () => {
      cancelled = true
      docToCleanup?.destroy()
    }
  }, [url])

  // Cleanup the doc on unmount.
  useEffect(() => {
    return () => {
      doc?.destroy()
    }
    // Intentionally only depend on doc identity; replacement is handled above.
  }, [doc])

  // Render whichever page is current.
  useEffect(() => {
    if (!doc) return
    let cancelled = false
    let renderTask: RenderTask | null = null
    ;(async () => {
      try {
        const page = await doc.getPage(pageNum)
        if (cancelled) return
        const canvas = canvasRef.current
        if (!canvas) return
        const viewport0 = page.getViewport({ scale: 1 })
        const maxByH = (window.innerHeight * MAX_HEIGHT_VH) / viewport0.height
        const maxByW = MAX_WIDTH / viewport0.width
        const dpr = window.devicePixelRatio || 1
        const scale = Math.min(maxByH, maxByW) * dpr
        const viewport = page.getViewport({ scale })
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        canvas.style.width = `${viewport.width / dpr}px`
        canvas.style.height = `${viewport.height / dpr}px`
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        renderTask = page.render({ canvas, canvasContext: ctx, viewport })
        await renderTask.promise
      } catch (e) {
        if (cancelled) return
        // RenderingCancelled isn't an error worth surfacing.
        const msg = e instanceof Error ? e.message : String(e)
        if (!/cancelled/i.test(msg)) setError(msg)
      }
    })()
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [doc, pageNum])

  // Esc closes, arrow keys page through.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault()
        setPageNum((p) => Math.min(p + 1, pageCount || p))
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        setPageNum((p) => Math.max(1, p - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pageCount])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'var(--bg-overlay)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="bg-card overflow-hidden flex flex-col max-h-[92vh] shadow-[var(--shadow-modal)]"
        style={{ borderRadius: 'var(--radius-lg)' }}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border-soft)]">
          <div className="text-sm font-medium text-foreground truncate max-w-[60ch]">{name}</div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPageNum((p) => Math.max(1, p - 1))}
              disabled={pageNum <= 1}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--bg-elevated)] disabled:opacity-30 transition-colors"
              style={{ borderRadius: 'var(--radius)' }}
            >
              ←
            </button>
            <span className="text-xs tabular-nums text-muted-foreground min-w-[5ch] text-center">
              {pageCount > 0 ? `${pageNum} / ${pageCount}` : '—'}
            </span>
            <button
              type="button"
              onClick={() => setPageNum((p) => Math.min(p + 1, pageCount || p))}
              disabled={pageNum >= pageCount}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--bg-elevated)] disabled:opacity-30 transition-colors"
              style={{ borderRadius: 'var(--radius)' }}
            >
              →
            </button>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
              style={{ borderRadius: 'var(--radius)' }}
            >
              Open
            </a>
            <button
              type="button"
              onClick={onClose}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
              style={{ borderRadius: 'var(--radius)' }}
            >
              Close
            </button>
          </div>
        </div>
        <div
          className="overflow-auto bg-[var(--bg-muted)] p-4 flex items-center justify-center min-w-[400px] min-h-[300px]"
          data-canvas-scrollable
        >
          {busy && <div className="text-xs text-muted-foreground">Loading PDF…</div>}
          {error && !busy && (
            <div className="text-xs text-destructive max-w-[60ch] text-center">{error}</div>
          )}
          <canvas ref={canvasRef} className={busy || error ? 'hidden' : ''} />
        </div>
      </div>
    </div>
  )
}
