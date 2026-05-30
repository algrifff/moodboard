import type { CanvasObject, ImageData, PDFData, UploadResponse } from '@moodboard/shared'
import type Konva from 'konva'
import { nanoid } from 'nanoid'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Layer, Stage } from 'react-konva'
import { cubicBezier } from 'framer-motion'
import { groupBoundingBox, objectsInMarquee } from '@/lib/aabb'
import { proxyUrl, uploadFile } from '@/lib/api'
import { captureClipboard, extractImgSrc, urlToImageHit } from '@/lib/clipboardImage'
import { importDriveFile, importNotionPage, importWebUrl } from '@/lib/connectionsApi'
import { extractDriveFileId } from '@/lib/driveUrl'
import { extractWebUrl } from '@/lib/webUrl'
import { fitToDefaultSize, loadImageDimensions, PDF_LONGEST_SIDE } from '@/lib/imageLoad'
import { extractNotionPageId } from '@/lib/notionUrl'
import {
  createDriveFile,
  createDriveFolder,
  createNotionPage,
  createText,
  createWebPage,
} from '@/lib/objectFactory'
import {
  EASE_OUT_STANDARD,
  FIT_ALL_DURATION_MS,
  SNAP_CURVE,
  ZOOM_RESET_DURATION_MS,
} from '@/lib/motion'
import { screenToWorld, zoomAroundPoint, type Point } from '@/lib/transform'
import { tweenTransform } from '@/lib/tweenTransform'
import { useCanvasStore } from '@/store/canvas'
import { useSourcePickerStore } from '@/store/sourcePicker'
import { CanvasOverlayLayer } from './CanvasOverlayLayer'
import { DotGridLayer } from './DotGridLayer'
import { EmptyStateHint } from './EmptyStateHint'
import { GroupsLayer } from './GroupsLayer'
import { ImageNode } from './ImageNode'
import { MarqueeBox } from './MarqueeBox'
import { PDFNode } from './PDFNode'
import { showToast } from './Toast'

const PdfPreviewModal = lazy(() =>
  import('./PdfPreviewModal').then((m) => ({ default: m.PdfPreviewModal })),
)

type Size = { width: number; height: number }
type Marquee = { start: Point; end: Point; shiftKey: boolean; baseSelection: string[] }

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

// Heuristic for "this URL points at an image file" — used to keep the
// legacy paste-an-image-URL flow working without intercepting brand
// homepages. The path-only check ignores query strings (so signed S3
// URLs still match) but doesn't try to resolve content-type.
function hasImageExtension(url: string): boolean {
  try {
    const u = new URL(url)
    const path = u.pathname.toLowerCase()
    return /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico)$/i.test(path)
  } catch {
    return false
  }
}

export function MoodBoardCanvas({ boardId }: { boardId?: string } = {}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const marqueeRef = useRef<Marquee | null>(null)
  const [previewPdf, setPreviewPdf] = useState<{ url: string; name: string } | null>(null)
  // Cancels any in-flight pan/zoom tween — keyboard chords interrupt cleanly.
  const tweenCancelRef = useRef<(() => void) | null>(null)
  // Active mouse-drag pan (right or middle button). Stored as a ref so the
  // window-level mousemove can read it without re-binding on every move.
  const panDragRef = useRef<{
    startX: number
    startY: number
    startOffset: { x: number; y: number }
  } | null>(null)

  const objects = useCanvasStore((s) => s.objects)
  const scale = useCanvasStore((s) => s.scale)
  const offset = useCanvasStore((s) => s.offset)
  const selectedIds = useCanvasStore((s) => s.selectedIds)
  const addObject = useCanvasStore((s) => s.addObject)
  const commit = useCanvasStore((s) => s.commitBeforeAction)
  const setTransform = useCanvasStore((s) => s.setTransform)
  const setViewportSize = useCanvasStore((s) => s.setViewportSize)
  const selectedSet = new Set(selectedIds)

  // Pan mode is purely "currently dragging with right/middle mouse." Space+
  // drag is gone — wheel/trackpad gestures handle the rest.
  const panMode = isPanning

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => {
      const next = { width: el.clientWidth, height: el.clientHeight }
      setSize(next)
      setViewportSize(next)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [setViewportSize])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey

      // Undo / redo. Allowed inside editable text — contentEditable's native
      // undo doesn't have history of our canvas state, so ours should always
      // win for board-level operations.
      if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        useCanvasStore.getState().undo()
        return
      }
      if (mod && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        useCanvasStore.getState().redo()
        return
      }

      if (mod && e.key === '0') {
        e.preventDefault()
        tweenCancelRef.current?.()
        const s = useCanvasStore.getState()
        tweenCancelRef.current = tweenTransform(
          { scale: s.scale, offset: s.offset },
          { scale: 1, offset: { x: 0, y: 0 } },
          ZOOM_RESET_DURATION_MS,
          cubicBezier(...EASE_OUT_STANDARD),
          (next) => setTransform({ scale: next.scale, offset: next.offset }),
        )
        return
      }
      if (mod && e.key === '1') {
        e.preventDefault()
        const s = useCanvasStore.getState()
        if (s.objects.length === 0) return
        const bbox = groupBoundingBox(s.objects, 40)
        const w = bbox.right - bbox.left
        const h = bbox.bottom - bbox.top
        const vw = s.viewportSize.width
        const vh = s.viewportSize.height
        if (w <= 0 || h <= 0 || vw <= 0 || vh <= 0) return
        const nextScale = Math.max(0.1, Math.min(4, Math.min(vw / w, vh / h)))
        const bboxCx = (bbox.left + bbox.right) / 2
        const bboxCy = (bbox.top + bbox.bottom) / 2
        tweenCancelRef.current?.()
        tweenCancelRef.current = tweenTransform(
          { scale: s.scale, offset: s.offset },
          {
            scale: nextScale,
            offset: {
              x: vw / 2 - bboxCx * nextScale,
              y: vh / 2 - bboxCy * nextScale,
            },
          },
          FIT_ALL_DURATION_MS,
          cubicBezier(...SNAP_CURVE),
          (next) => setTransform({ scale: next.scale, offset: next.offset }),
        )
        return
      }

      if (!isEditableTarget(e.target)) {
        if (e.key === 'Escape') {
          useCanvasStore.getState().clearSelection()
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          const state = useCanvasStore.getState()
          if (state.selectedIds.length > 0) {
            e.preventDefault()
            state.commitBeforeAction()
            state.deleteSelection()
          }
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      tweenCancelRef.current?.()
    }
  }, [setTransform])

  // Pan with right-click or middle-click drag. Wheel events (handled
  // separately) cover the trackpad two-finger swipe + pinch-zoom path.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1 && e.button !== 2) return
      e.preventDefault()
      panDragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startOffset: { ...useCanvasStore.getState().offset },
      }
      setIsPanning(true)
    }
    const onMouseMove = (e: MouseEvent) => {
      const pan = panDragRef.current
      if (!pan) return
      setTransform({
        offset: {
          x: pan.startOffset.x + (e.clientX - pan.startX),
          y: pan.startOffset.y + (e.clientY - pan.startY),
        },
      })
    }
    const onMouseUp = (e: MouseEvent) => {
      if (!panDragRef.current) return
      if (e.button !== 1 && e.button !== 2) return
      panDragRef.current = null
      setIsPanning(false)
    }
    const onContextMenu = (e: MouseEvent) => {
      // Suppress the native menu on the canvas — right-click is reserved
      // for pan here. (Once we add a real context menu we'll re-wire this.)
      e.preventDefault()
    }

    el.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    el.addEventListener('contextmenu', onContextMenu)
    return () => {
      el.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      el.removeEventListener('contextmenu', onContextMenu)
    }
  }, [setTransform])

  const placeImage = useCallback(
    async (upload: UploadResponse, worldPoint: { x: number; y: number }) => {
      const dims = await loadImageDimensions(upload.url)
      const sized = fitToDefaultSize(dims)
      const data: ImageData = { url: upload.url }
      const object: CanvasObject = {
        id: nanoid(),
        type: 'image',
        position: {
          x: worldPoint.x - sized.width / 2,
          y: worldPoint.y - sized.height / 2,
        },
        size: sized,
        rotation: 0,
        zIndex: objects.length,
        data,
      }
      commit()
      addObject(object)
    },
    [objects.length, addObject, commit],
  )

  const placePdf = useCallback(
    async (upload: UploadResponse, worldPoint: { x: number; y: number }) => {
      if (!upload.thumbnailUrl) {
        // Backend failed to render the cover — fall back to A4-ish portrait
        // at postcard size so the PDF still lands on the canvas.
        const fallback = { width: 180, height: 240 }
        const data: PDFData = {
          url: upload.url,
          thumbnailUrl: '',
          extractedText: upload.extractedText ?? '',
          pageCount: upload.pageCount,
        }
        commit()
        addObject({
          id: nanoid(),
          type: 'pdf',
          position: {
            x: worldPoint.x - fallback.width / 2,
            y: worldPoint.y - fallback.height / 2,
          },
          size: fallback,
          rotation: 0,
          zIndex: objects.length,
          data,
        })
        return
      }
      const dims = await loadImageDimensions(upload.thumbnailUrl)
      const sized = fitToDefaultSize(dims, PDF_LONGEST_SIDE)
      const data: PDFData = {
        url: upload.url,
        thumbnailUrl: upload.thumbnailUrl,
        extractedText: upload.extractedText ?? '',
        pageCount: upload.pageCount,
      }
      commit()
      addObject({
        id: nanoid(),
        type: 'pdf',
        position: {
          x: worldPoint.x - sized.width / 2,
          y: worldPoint.y - sized.height / 2,
        },
        size: sized,
        rotation: 0,
        zIndex: objects.length,
        data,
      })
    },
    [objects.length, addObject, commit],
  )

  const addImageFromBlob = useCallback(
    async (blob: Blob, worldPoint: { x: number; y: number }) => {
      setBusy(true)
      try {
        const upload = await uploadFile(blob)
        await placeImage(upload, worldPoint)
      } finally {
        setBusy(false)
      }
    },
    [placeImage],
  )

  const addPdfFromBlob = useCallback(
    async (blob: Blob, worldPoint: { x: number; y: number }, filename = 'document.pdf') => {
      setBusy(true)
      try {
        const upload = await uploadFile(blob, filename)
        await placePdf(upload, worldPoint)
      } finally {
        setBusy(false)
      }
    },
    [placePdf],
  )

  const addImageFromUrl = useCallback(
    async (url: string, worldPoint: { x: number; y: number }) => {
      setBusy(true)
      try {
        const upload = await proxyUrl(url)
        await placeImage(upload, worldPoint)
      } finally {
        setBusy(false)
      }
    },
    [placeImage],
  )

  const viewportCenterWorld = useCallback(() => {
    return screenToWorld(
      { x: size.width / 2, y: size.height / 2 },
      { scale, x: offset.x, y: offset.y },
    )
  }, [size, scale, offset])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const worldPoint = screenToWorld(screenPoint, { scale, x: offset.x, y: offset.y })

      const fileList = e.dataTransfer.files
      if (fileList.length > 0) {
        let i = 0
        for (const file of Array.from(fileList)) {
          const wp = { x: worldPoint.x + i * 16, y: worldPoint.y + i * 16 }
          if (file.type === 'application/pdf') {
            await addPdfFromBlob(file, wp, file.name)
            i += 1
          } else if (file.type.startsWith('image/')) {
            await addImageFromBlob(file, wp)
            i += 1
          }
        }
        return
      }
      const uri = e.dataTransfer.getData('text/uri-list').split('\n')[0]?.trim()
      if (uri && /^https?:\/\//i.test(uri)) {
        await addImageFromUrl(uri, worldPoint)
      }
    },
    [scale, offset, addImageFromBlob, addImageFromUrl, addPdfFromBlob],
  )

  // Handle a Notion page-id extracted from a pasted URL. If the user has at
  // least one Notion connection, import + spawn now. Otherwise stash the id
  // on the picker store and open the picker so the connect CTA is visible —
  // Board.tsx watches for `pendingPaste` and resumes the import after OAuth.
  const handleNotionPasteUrl = useCallback(
    async (pageId: string, point: Point) => {
      const picker = useSourcePickerStore.getState()
      const notionConnection = picker.connections.find((c) => c.provider === 'notion')
      if (!notionConnection) {
        picker.setPendingPaste({ provider: 'notion', pageId })
        picker.openPicker()
        showToast('Connect Notion first to drop this link')
        return
      }
      try {
        const data = await importNotionPage(notionConnection.id, pageId)
        const state = useCanvasStore.getState()
        state.commitBeforeAction()
        addObject(createNotionPage(point, state.objects.length, data))
      } catch (err) {
        showToast(`Notion import failed: ${err instanceof Error ? err.message : 'unknown'}`)
      }
    },
    [addObject],
  )

  // Generic web URL paste — no OAuth, no connection. Server fetches the page
  // with SSRF guards, extracts brand-relevant signal, downloads up to 3
  // logo candidates. The card spawns at the click point; logo images stack
  // to its right with a 16px gap so the user sees them all immediately.
  const handleWebPasteUrl = useCallback(
    async (url: string, point: Point) => {
      let host = url
      try {
        host = new URL(url).host
      } catch {
        // already a stringly URL — host fallback is fine
      }
      showToast(`Pulling colours from ${host}…`)
      try {
        const result = await importWebUrl(url)
        console.log(`[web-paste] ${host}: card + ${result.logoImages.length} logo(s)`, result.logoImages)
        const state = useCanvasStore.getState()
        state.commitBeforeAction()
        addObject(createWebPage(point, state.objects.length, result.page))
        // Stack logos to the right of the card. Each logo is 96×96 and
        // sits at a 16px gap; small enough to read as a row of marks
        // without dominating the canvas. Matches the bumped card width.
        const LOGO_SIZE = 96
        const GAP = 16
        const cardWidth = 320 // matches WEB_DEFAULT_SIZE.width in objectFactory
        const startX = point.x + cardWidth / 2 + GAP
        const y = point.y - LOGO_SIZE / 2
        result.logoImages.forEach((logo, i) => {
          addObject({
            id: nanoid(),
            type: 'image',
            position: { x: startX + i * (LOGO_SIZE + GAP), y },
            size: { width: LOGO_SIZE, height: LOGO_SIZE },
            rotation: 0,
            zIndex: state.objects.length + i + 1,
            data: logo,
          })
        })
        if (result.logoImages.length === 0) {
          showToast(`No brand logos found on ${host} — card only`)
        }
      } catch (err) {
        showToast(`Web import failed: ${err instanceof Error ? err.message : 'unknown'}`)
      }
    },
    [addObject],
  )

  // Same shape as the Notion paste handler, dispatched by the import's `kind`
  // discriminator so PDFs land as PDFNode and images as ImageNode.
  const handleDrivePasteUrl = useCallback(
    async (fileId: string, point: Point) => {
      const picker = useSourcePickerStore.getState()
      const driveConnection = picker.connections.find((c) => c.provider === 'drive')
      if (!driveConnection) {
        picker.setPendingPaste({ provider: 'drive', fileId })
        picker.openPicker()
        showToast('Connect Google Drive first to drop this link')
        return
      }
      try {
        const result = await importDriveFile(driveConnection.id, fileId)
        const state = useCanvasStore.getState()
        state.commitBeforeAction()
        if (result.kind === 'file') {
          addObject(createDriveFile(point, state.objects.length, result.data))
        } else if (result.kind === 'folder') {
          addObject(createDriveFolder(point, state.objects.length, result.data))
        } else if (result.kind === 'pdf') {
          addObject({
            id: nanoid(),
            type: 'pdf',
            position: { x: point.x - 90, y: point.y - 120 },
            size: { width: 180, height: 240 },
            rotation: 0,
            zIndex: state.objects.length,
            data: result.data,
          })
        } else {
          addObject({
            id: nanoid(),
            type: 'image',
            position: { x: point.x - 200, y: point.y - 150 },
            size: { width: 400, height: 300 },
            rotation: 0,
            zIndex: state.objects.length,
            data: result.data,
          })
        }
      } catch (err) {
        showToast(`Drive import failed: ${err instanceof Error ? err.message : 'unknown'}`)
      }
    },
    [addObject],
  )

  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return
      const items = e.clipboardData?.items
      if (!items || items.length === 0) return

      // Snapshot the clipboard NOW, before yielding to any await — the
      // event's clipboardData goes stale once the handler is async.
      const snap = await captureClipboard(items)

      // 1. PDF
      const pdf = snap.pdfBlobs[0]
      if (pdf) {
        e.preventDefault()
        await addPdfFromBlob(pdf, viewportCenterWorld(), pdf.name || 'pasted.pdf')
        return
      }

      // 2. Image blob (screenshot, copy-image-data, drag-from-Figma, etc.)
      const img = snap.imageBlobs[0]
      if (img) {
        e.preventDefault()
        try {
          await addImageFromBlob(img, viewportCenterWorld())
        } catch (err) {
          showToast(`Couldn't paste image: ${err instanceof Error ? err.message : 'failed'}`)
        }
        return
      }

      // 3. <img src> in HTML (right-click → Copy Image from a web page)
      if (snap.html) {
        const url = extractImgSrc(snap.html)
        if (url) {
          const hit = await urlToImageHit(url)
          if (hit) {
            e.preventDefault()
            try {
              if (hit.kind === 'blob') {
                await addImageFromBlob(hit.blob, viewportCenterWorld())
              } else {
                await addImageFromUrl(hit.url, viewportCenterWorld())
              }
            } catch (err) {
              showToast(`Couldn't paste image: ${err instanceof Error ? err.message : 'failed'}`)
            }
            return
          }
        }
      }

      // 4. text/plain — could be a Notion URL, an image URL, a data URI,
      // or just text. Notion takes precedence because the URL string
      // would also match the image-URL fallback (Notion's URLs are http).
      if (snap.text) {
        const trimmed = snap.text.trim()

        // 4a. Notion / Drive URL → import via the matching connection, or
        // stash the id and open the connect flow if no connection exists.
        if (trimmed.length > 0 && /https?:\/\//i.test(trimmed)) {
          const notionPageId = extractNotionPageId(trimmed)
          if (notionPageId) {
            e.preventDefault()
            await handleNotionPasteUrl(notionPageId, viewportCenterWorld())
            return
          }
          const driveFileId = extractDriveFileId(trimmed)
          if (driveFileId) {
            e.preventDefault()
            await handleDrivePasteUrl(driveFileId, viewportCenterWorld())
            return
          }
        }

        // 4b. data:image and URLs whose path obviously points at an image
        // file → land as ImageNode. We narrow the legacy "any http URL is
        // an image" branch to URLs with a clear image extension so a brand
        // homepage URL flows through to the web-page handler below
        // instead of getting downgraded to a single image.
        if (
          trimmed.length > 0 &&
          (trimmed.startsWith('data:image/') || hasImageExtension(trimmed))
        ) {
          const hit = await urlToImageHit(trimmed)
          if (hit) {
            e.preventDefault()
            try {
              if (hit.kind === 'blob') {
                await addImageFromBlob(hit.blob, viewportCenterWorld())
              } else {
                await addImageFromUrl(hit.url, viewportCenterWorld())
              }
              return
            } catch {
              // Image fetch failed — fall through to a text node instead.
            }
          }
        }

        // 4c. Any other http(s) URL → fetch the page, sample its brand
        // signal, spawn a web-page card + adjacent logo images. This is
        // the catch-all for "user pasted a brand homepage".
        if (trimmed.length > 0) {
          const webUrl = extractWebUrl(trimmed)
          if (webUrl) {
            e.preventDefault()
            await handleWebPasteUrl(webUrl, viewportCenterWorld())
            return
          }
        }

        // 5. Plain text → spawn a text node pre-filled with the content.
        if (trimmed.length > 0) {
          e.preventDefault()
          const state = useCanvasStore.getState()
          state.commitBeforeAction()
          addObject(createText(viewportCenterWorld(), state.objects.length, snap.text))
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [
    addImageFromBlob,
    addImageFromUrl,
    addObject,
    addPdfFromBlob,
    handleDrivePasteUrl,
    handleNotionPasteUrl,
    handleWebPasteUrl,
    viewportCenterWorld,
  ])

  // Wheel handler lives on the container, not on the Konva Stage. The
  // analysis panels / palette popovers are siblings of the Stage in the
  // DOM, so their wheel events never bubble to the Stage's handler. By
  // listening at the container we catch every wheel inside the canvas
  // viewport — pan/zoom keeps working regardless of which DOM overlay the
  // cursor is over. Skip elements that opt in to native scrolling via
  // `data-canvas-scrollable` (PDF preview modal).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-canvas-scrollable]')) return

      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const { scale: s, offset: o } = useCanvasStore.getState()
      const isZoom = e.ctrlKey || e.metaKey

      if (isZoom) {
        const dy = Math.max(-50, Math.min(50, e.deltaY))
        const factor = Math.exp(-dy * 0.01)
        const next = zoomAroundPoint({ scale: s, x: o.x, y: o.y }, pointer, s * factor)
        setTransform({ scale: next.scale, offset: { x: next.x, y: next.y } })
        return
      }

      setTransform({
        offset: { x: o.x - e.deltaX, y: o.y - e.deltaY },
      })
    }

    // passive:false so preventDefault works against the browser's default
    // page-scroll / pinch-zoom behaviour.
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setTransform])

  const handleStageMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (panMode) return
    if (e.target !== e.target.getStage()) return
    const stage = stageRef.current
    if (!stage) return
    const pointer = stage.getPointerPosition()
    if (!pointer) return
    const world = screenToWorld(pointer, { scale, x: offset.x, y: offset.y })
    const baseSelection = e.evt.shiftKey ? [...useCanvasStore.getState().selectedIds] : []
    if (!e.evt.shiftKey) useCanvasStore.getState().clearSelection()
    const next = { start: world, end: world, shiftKey: e.evt.shiftKey, baseSelection }
    marqueeRef.current = next
    setMarquee(next)
  }

  useEffect(() => {
    if (!marquee) return
    const startedAt = Date.now()

    const containerEl = containerRef.current
    if (!containerEl) return

    const onMove = (e: MouseEvent) => {
      const current = marqueeRef.current
      if (!current) return
      const rect = containerEl.getBoundingClientRect()
      const { scale: s, offset: o } = useCanvasStore.getState()
      const world = screenToWorld(
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        { scale: s, x: o.x, y: o.y },
      )
      const next = { ...current, end: world }
      marqueeRef.current = next
      setMarquee(next)
      const ids = objectsInMarquee(useCanvasStore.getState().objects, next.start, next.end)
      const merged = next.shiftKey ? Array.from(new Set([...next.baseSelection, ...ids])) : ids
      useCanvasStore.getState().setSelection(merged)
    }

    const onUp = () => {
      const current = marqueeRef.current
      marqueeRef.current = null
      setMarquee(null)
      if (!current) return
      const dx = current.end.x - current.start.x
      const dy = current.end.y - current.start.y
      const dragged = Math.abs(dx) > 2 || Math.abs(dy) > 2 || Date.now() - startedAt > 200
      if (!dragged && !current.shiftKey) {
        useCanvasStore.getState().clearSelection()
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [marquee !== null])

  const cursor = panMode ? 'grabbing' : 'default'

  // Dot grid is now a Konva layer (DotGridLayer) — cursor magnetism + slow
  // global pulse. Container is a plain dark surface.
  const bgStyle: React.CSSProperties = { cursor }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden bg-background"
      style={bgStyle}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* Defer Stage mount until the container has been measured. Konva
          eagerly draws its inner cache canvases at construction time — if
          we instantiate the Stage at width:0/height:0, the first
          `drawImage(cacheCanvas, ...)` of any child Rect throws
          `InvalidStateError: image argument is a canvas element with a
          width or height of 0`. The error fires inside React's commit
          layout-effects, so it cascades through every nested fiber and
          produces the huge stack we used to see on every reload.
          Gating on `size.width > 0 && size.height > 0` makes the first
          mount happen after the ResizeObserver has reported the real
          container size, which is the only state where Konva's internal
          buffers are valid. */}
      {size.width > 0 && size.height > 0 && (
      <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        scaleX={scale}
        scaleY={scale}
        x={offset.x}
        y={offset.y}
        onMouseDown={handleStageMouseDown}
      >
        <DotGridLayer scale={scale} offset={offset} viewportSize={size} />
        <Layer>
          {objects
            .filter((o) => o.type === 'image')
            .map((o) => (
              <ImageNode key={o.id} object={o} panMode={panMode} selected={selectedSet.has(o.id)} />
            ))}
          {objects
            .filter((o) => o.type === 'pdf')
            .map((o) => (
              <PDFNode
                key={o.id}
                object={o}
                panMode={panMode}
                selected={selectedSet.has(o.id)}
                onOpen={(obj) => {
                  const d = obj.data as PDFData
                  setPreviewPdf({ url: d.url, name: 'PDF' })
                }}
              />
            ))}
        </Layer>
      </Stage>
      )}

      <GroupsLayer objects={objects} scale={scale} offset={offset} boardId={boardId} />

      <CanvasOverlayLayer
        objects={objects.filter(
          (o) =>
            o.type === 'sticky' ||
            o.type === 'text' ||
            o.type === 'font' ||
            o.type === 'notion-page' ||
            o.type === 'drive-file' ||
            o.type === 'drive-folder' ||
            o.type === 'web-page',
        )}
        scale={scale}
        offset={offset}
        panMode={panMode}
        selectedIds={selectedIds}
        boardId={boardId}
      />

      {marquee && (
        <MarqueeBox start={marquee.start} end={marquee.end} scale={scale} offset={offset} />
      )}

      <EmptyStateHint />

      {busy && (
        <div className="absolute top-4 right-4 rounded-md bg-white/90 border px-3 py-1.5 text-xs shadow-sm">
          Uploading…
        </div>
      )}

      {previewPdf && (
        <Suspense fallback={null}>
          <PdfPreviewModal
            url={previewPdf.url}
            name={previewPdf.name}
            onClose={() => setPreviewPdf(null)}
          />
        </Suspense>
      )}
    </div>
  )
}
