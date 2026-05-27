import type { CanvasObject, ImageData, UploadResponse } from '@moodboard/shared'
import type Konva from 'konva'
import { nanoid } from 'nanoid'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Layer, Stage } from 'react-konva'
import { objectsInMarquee } from '@/lib/aabb'
import { proxyUrl, uploadFile } from '@/lib/api'
import { fitToDefaultSize, loadImageDimensions } from '@/lib/imageLoad'
import { screenToWorld, zoomAroundPoint, type Point } from '@/lib/transform'
import { useCanvasStore } from '@/store/canvas'
import { CanvasOverlayLayer } from './CanvasOverlayLayer'
import { GroupsLayer } from './GroupsLayer'
import { ImageNode } from './ImageNode'
import { MarqueeBox } from './MarqueeBox'

type Size = { width: number; height: number }
type Marquee = { start: Point; end: Point; shiftKey: boolean; baseSelection: string[] }

const WHEEL_ZOOM_FACTOR = 1.05

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function MoodBoardCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [middleHeld, setMiddleHeld] = useState(false)
  const [busy, setBusy] = useState(false)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const marqueeRef = useRef<Marquee | null>(null)

  const objects = useCanvasStore((s) => s.objects)
  const scale = useCanvasStore((s) => s.scale)
  const offset = useCanvasStore((s) => s.offset)
  const selectedIds = useCanvasStore((s) => s.selectedIds)
  const addObject = useCanvasStore((s) => s.addObject)
  const setTransform = useCanvasStore((s) => s.setTransform)
  const setViewportSize = useCanvasStore((s) => s.setViewportSize)
  const selectedSet = new Set(selectedIds)

  const panMode = spaceHeld || middleHeld

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
      if (e.code === 'Space' && !isEditableTarget(e.target)) {
        e.preventDefault()
        setSpaceHeld(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault()
        setTransform({ scale: 1, offset: { x: 0, y: 0 } })
      }
      if (!isEditableTarget(e.target)) {
        if (e.key === 'Escape') {
          useCanvasStore.getState().clearSelection()
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (useCanvasStore.getState().selectedIds.length > 0) {
            e.preventDefault()
            useCanvasStore.getState().deleteSelection()
          }
        }
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [setTransform])

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault()
        setMiddleHeld(true)
      }
    }
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 1) setMiddleHeld(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

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
      addObject(object)
    },
    [objects.length, addObject],
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
          if (file.type.startsWith('image/')) {
            const wp = { x: worldPoint.x + i * 16, y: worldPoint.y + i * 16 }
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
    [scale, offset, addImageFromBlob, addImageFromUrl],
  )

  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return
      const items = e.clipboardData?.items
      if (!items) return

      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile()
          if (blob) {
            e.preventDefault()
            await addImageFromBlob(blob, viewportCenterWorld())
            return
          }
        }
      }
      for (const item of Array.from(items)) {
        if (item.type === 'text/plain') {
          const text = await new Promise<string>((resolve) => item.getAsString(resolve))
          const trimmed = text.trim()
          if (/^https?:\/\//i.test(trimmed)) {
            e.preventDefault()
            await addImageFromUrl(trimmed, viewportCenterWorld())
            return
          }
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addImageFromBlob, addImageFromUrl, viewportCenterWorld])

  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const pointer = stage.getPointerPosition()
    if (!pointer) return
    const direction = e.evt.deltaY > 0 ? -1 : 1
    const nextScale = direction > 0 ? scale * WHEEL_ZOOM_FACTOR : scale / WHEEL_ZOOM_FACTOR
    const next = zoomAroundPoint({ scale, x: offset.x, y: offset.y }, pointer, nextScale)
    setTransform({ scale: next.scale, offset: { x: next.x, y: next.y } })
  }

  const handleStageMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (panMode) return
    if (e.target !== e.target.getStage()) return
    const stage = stageRef.current
    if (!stage) return
    const pointer = stage.getPointerPosition()
    if (!pointer) return
    const world = screenToWorld(pointer, { scale, x: offset.x, y: offset.y })
    const baseSelection = e.evt.shiftKey
      ? [...useCanvasStore.getState().selectedIds]
      : []
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
      const merged = next.shiftKey
        ? Array.from(new Set([...next.baseSelection, ...ids]))
        : ids
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

  const cursor = panMode ? 'grab' : 'default'

  const gridSpacing = Math.max(24 * scale, 16)
  const bgStyle: React.CSSProperties = {
    cursor,
    backgroundImage:
      'radial-gradient(circle, rgba(15, 23, 42, 0.18) 1.4px, transparent 1.6px)',
    backgroundSize: `${gridSpacing}px ${gridSpacing}px`,
    backgroundPosition: `${offset.x}px ${offset.y}px`,
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden bg-slate-50"
      style={bgStyle}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        scaleX={scale}
        scaleY={scale}
        x={offset.x}
        y={offset.y}
        draggable={panMode}
        onWheel={handleWheel}
        onMouseDown={handleStageMouseDown}
        onDragMove={(e) => {
          if (e.target === e.target.getStage()) {
            setTransform({ offset: { x: e.target.x(), y: e.target.y() } })
          }
        }}
        onDragEnd={(e) => {
          if (e.target === e.target.getStage()) {
            setTransform({ offset: { x: e.target.x(), y: e.target.y() } })
          }
        }}
      >
        <Layer>
          {objects
            .filter((o) => o.type === 'image' || o.type === 'pdf')
            .map((o) => (
              <ImageNode
                key={o.id}
                object={o}
                panMode={panMode}
                selected={selectedSet.has(o.id)}
              />
            ))}
        </Layer>
      </Stage>

      <GroupsLayer objects={objects} scale={scale} offset={offset} />

      <CanvasOverlayLayer
        objects={objects.filter((o) => o.type === 'sticky' || o.type === 'text')}
        scale={scale}
        offset={offset}
        panMode={panMode}
        selectedIds={selectedIds}
      />

      {marquee && (
        <MarqueeBox start={marquee.start} end={marquee.end} scale={scale} offset={offset} />
      )}

      {busy && (
        <div className="absolute top-4 right-4 rounded-md bg-white/90 border px-3 py-1.5 text-xs shadow-sm">
          Uploading…
        </div>
      )}
    </div>
  )
}
