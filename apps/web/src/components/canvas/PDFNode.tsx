import type { CanvasObject, PDFData } from '@moodboard/shared'
import type Konva from 'konva'
import { useEffect, useRef, useState } from 'react'
import { Group, Image as KonvaImage, Rect, Text } from 'react-konva'
import { useSpawnOpacity } from '@/hooks/useSpawnAnim'
import { getCachedPage, getPdfjs, renderPdfPage, setCachedPage } from '@/lib/pdfClient'
import { useCanvasStore } from '@/store/canvas'
import { emitDotRipple, setDragHalo } from './DotGridLayer'

type Zone = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const ZONE_CURSORS: Record<Zone, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
}

const EDGE_PX = 14
const HALO_PX = 14
const MIN_SIDE = 40
// Below this much screen-pixel drag, mouseUp is treated as a click.
const CLICK_SLOP_PX = 4
// Per-page render target — keeps client-side renders crisp without
// blowing memory on very large PDFs.
const PAGE_RENDER_WIDTH = 800

function isPdfData(d: CanvasObject['data']): d is PDFData {
  return 'thumbnailUrl' in d && typeof (d as PDFData).thumbnailUrl === 'string'
}

type Active = {
  mode: 'drag' | Zone
  pointer: { x: number; y: number }
  size: { w: number; h: number }
  pos: { x: number; y: number }
  aspect: number
  initialPositions: Map<string, { x: number; y: number }>
  travel: number
}

type DisplayImage = HTMLImageElement | HTMLCanvasElement

export function PDFNode({
  object,
  panMode,
  selected,
  onOpen,
}: {
  object: CanvasObject
  panMode: boolean
  selected: boolean
  onOpen: (object: CanvasObject) => void
}) {
  const [displayImage, setDisplayImage] = useState<DisplayImage | null>(null)
  const [nearEdge, setNearEdge] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageBusy, setPageBusy] = useState(false)
  const [resolvedPageCount, setResolvedPageCount] = useState<number | null>(null)
  const spawnOpacity = useSpawnOpacity()
  const imageRef = useRef<Konva.Image>(null)
  const activeRef = useRef<Active | null>(null)
  const pdfData = isPdfData(object.data) ? object.data : null
  const thumbnailUrl = pdfData?.thumbnailUrl ?? ''
  const pdfUrl = pdfData?.url ?? ''
  const pageCount = pdfData?.pageCount ?? resolvedPageCount ?? 1
  const canPage = pageCount > 1

  // Resize the widget so its aspect matches the page being shown. We
  // preserve the user's current width and adjust height only. A small
  // threshold avoids ping-ponging on rounding-level differences.
  const applyAspect = (aspect: number) => {
    if (!isFinite(aspect) || aspect <= 0) return
    const live = useCanvasStore.getState().objects.find((o) => o.id === object.id)
    if (!live) return
    const targetH = live.size.width / aspect
    if (Math.abs(targetH - live.size.height) < 1) return
    useCanvasStore.getState().updateObject(object.id, {
      size: { width: live.size.width, height: targetH },
    })
  }

  // If the object was placed before pageCount was persisted, fetch it once
  // via pdfjs so the arrows still appear.
  useEffect(() => {
    if (pdfData?.pageCount || !pdfUrl) return
    let cancelled = false
    ;(async () => {
      try {
        const pdfjs = await getPdfjs()
        const doc = await pdfjs.getDocument({ url: pdfUrl, withCredentials: true }).promise
        if (cancelled) {
          doc.destroy()
          return
        }
        setResolvedPageCount(doc.numPages)
        await doc.destroy()
      } catch {
        // ignore — buttons just won't show
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pdfData?.pageCount, pdfUrl])

  // Every page renders client-side via pdfjs and gets cached. For page 1,
  // the server-rendered thumbnail (when present) is shown as a fast first
  // paint — but pdfjs is still the source of truth, so a missing or broken
  // thumbnail can't leave the widget blank.
  useEffect(() => {
    let cancelled = false

    if (!pdfUrl) return

    const cached = getCachedPage(pdfUrl, currentPage)
    if (cached) {
      setDisplayImage(cached)
      applyAspect(cached.width / cached.height)
      setPageBusy(false)
      return
    }

    if (currentPage === 1 && thumbnailUrl) {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        if (cancelled) return
        // Don't stomp a real client render that may have landed first.
        if (!getCachedPage(pdfUrl, 1)) {
          setDisplayImage(img)
          applyAspect(img.naturalWidth / img.naturalHeight)
        }
      }
      img.src = thumbnailUrl
    }

    setPageBusy(true)
    renderPdfPage(pdfUrl, currentPage, PAGE_RENDER_WIDTH)
      .then((canvas) => {
        if (cancelled) return
        setCachedPage(pdfUrl, currentPage, canvas)
        setDisplayImage(canvas)
        applyAspect(canvas.width / canvas.height)
        setPageBusy(false)
      })
      .catch((e) => {
        if (cancelled) return
        console.warn('PDF page render failed', e)
        setPageBusy(false)
      })

    return () => {
      cancelled = true
    }
    // applyAspect is intentionally omitted — it reads the latest store on
    // each call and we want this effect to re-run only when the page or
    // PDF identity changes, not on every size update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, thumbnailUrl, pdfUrl])

  const computeZone = (pointer: { x: number; y: number }): Zone | null => {
    const node = imageRef.current
    const stage = node?.getStage()
    if (!node || !stage) return null
    const sScale = stage.scaleX()
    const sX = stage.x()
    const sY = stage.y()
    const left = node.x() * sScale + sX
    const top = node.y() * sScale + sY
    const right = (node.x() + node.width()) * sScale + sX
    const bottom = (node.y() + node.height()) * sScale + sY

    const nearLeft = pointer.x - left < EDGE_PX
    const nearRight = right - pointer.x < EDGE_PX
    const nearTop = pointer.y - top < EDGE_PX
    const nearBottom = bottom - pointer.y < EDGE_PX

    if (nearTop && nearLeft) return 'nw'
    if (nearTop && nearRight) return 'ne'
    if (nearBottom && nearLeft) return 'sw'
    if (nearBottom && nearRight) return 'se'
    if (nearTop) return 'n'
    if (nearBottom) return 's'
    if (nearLeft) return 'w'
    if (nearRight) return 'e'
    return null
  }

  const handleMouseMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (activeRef.current) return
    if (panMode) return
    const stage = e.target.getStage()
    const pointer = stage?.getPointerPosition()
    if (!stage || !pointer) return
    const zone = computeZone(pointer)
    stage.container().style.cursor = zone ? ZONE_CURSORS[zone] : 'pointer'
    setNearEdge(zone !== null)
  }

  const handleMouseLeave = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (activeRef.current) return
    const stage = e.target.getStage()
    if (stage) stage.container().style.cursor = 'default'
    setNearEdge(false)
  }

  const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (panMode) return
    if (e.evt.button !== 0) return
    e.cancelBubble = true

    const stage = e.target.getStage()
    const pointer = stage?.getPointerPosition()
    const node = imageRef.current
    if (!stage || !pointer || !node) return

    const state = useCanvasStore.getState()
    const wasSelected = state.selectedIds.includes(object.id)
    if (e.evt.shiftKey) {
      state.toggleSelection(object.id)
    } else if (!wasSelected) {
      state.setSelection([object.id])
    }

    // Snapshot pre-action state for undo. Drag/resize updates that follow
    // are coalesced into this one history frame.
    state.commitBeforeAction()

    const zone = computeZone(pointer)
    const after = useCanvasStore.getState()
    const initial = new Map<string, { x: number; y: number }>()
    for (const id of after.selectedIds) {
      const o = after.objects.find((o) => o.id === id)
      if (o) initial.set(id, { x: o.position.x, y: o.position.y })
    }
    if (initial.size === 0) {
      initial.set(object.id, { x: object.position.x, y: object.position.y })
    }

    activeRef.current = {
      mode: zone ?? 'drag',
      pointer: { x: pointer.x, y: pointer.y },
      size: { w: node.width(), h: node.height() },
      pos: { x: node.x(), y: node.y() },
      aspect: node.width() / node.height(),
      initialPositions: initial,
      travel: 0,
    }
    if (zone === null) {
      for (const id of initial.keys()) setDragHalo(id, true)
    } else {
      setDragHalo(object.id, true)
    }

    const onMove = (ev: MouseEvent) => {
      const active = activeRef.current
      const stg = imageRef.current?.getStage()
      if (!active || !stg) return
      const rect = stg.container().getBoundingClientRect()
      const pX = ev.clientX - rect.left
      const pY = ev.clientY - rect.top
      const sScale = stg.scaleX()
      const dx = (pX - active.pointer.x) / sScale
      const dy = (pY - active.pointer.y) / sScale
      active.travel = Math.max(
        active.travel,
        Math.abs(pX - active.pointer.x) + Math.abs(pY - active.pointer.y),
      )
      const updateObject = useCanvasStore.getState().updateObject

      if (active.mode === 'drag') {
        for (const [id, pos] of active.initialPositions) {
          updateObject(id, { position: { x: pos.x + dx, y: pos.y + dy } })
        }
        return
      }

      const z = active.mode
      const aspect = active.aspect
      let nw = active.size.w
      let nh = active.size.h
      let nx = active.pos.x
      let ny = active.pos.y

      let freeW = active.size.w
      let freeH = active.size.h
      if (z === 'e' || z === 'ne' || z === 'se') freeW = active.size.w + dx
      if (z === 'w' || z === 'nw' || z === 'sw') freeW = active.size.w - dx
      if (z === 's' || z === 'se' || z === 'sw') freeH = active.size.h + dy
      if (z === 'n' || z === 'nw' || z === 'ne') freeH = active.size.h - dy

      if (z === 'n' || z === 's') {
        nh = Math.max(MIN_SIDE, freeH)
        nw = nh * aspect
      } else if (z === 'e' || z === 'w') {
        nw = Math.max(MIN_SIDE, freeW)
        nh = nw / aspect
      } else {
        const scaleW = freeW / active.size.w
        const scaleH = freeH / active.size.h
        const scale = Math.abs(scaleW - 1) > Math.abs(scaleH - 1) ? scaleW : scaleH
        nw = Math.max(MIN_SIDE, active.size.w * scale)
        nh = Math.max(MIN_SIDE, active.size.h * scale)
      }

      if (z === 'w' || z === 'nw' || z === 'sw') {
        nx = active.pos.x + active.size.w - nw
      }
      if (z === 'n' || z === 'nw' || z === 'ne') {
        ny = active.pos.y + active.size.h - nh
      }

      updateObject(object.id, {
        size: { width: nw, height: nh },
        position: { x: nx, y: ny },
      })
    }

    const onUp = () => {
      const active = activeRef.current
      activeRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      // Clear halos for everything this gesture lit up.
      if (active) {
        if (active.mode === 'drag') {
          for (const id of active.initialPositions.keys()) setDragHalo(id, false)
        } else {
          setDragHalo(object.id, false)
        }
      }
      if (active && active.mode === 'drag' && active.travel < CLICK_SLOP_PX) {
        onOpen(object)
        return
      }
      // Real drag/resize → ripple from the object's new center.
      if (active && active.travel >= CLICK_SLOP_PX) {
        const live = useCanvasStore.getState().objects.find((o) => o.id === object.id)
        if (live) {
          emitDotRipple(
            live.position.x + live.size.width / 2,
            live.position.y + live.size.height / 2,
          )
        }
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Stop the drag handler from latching when the user clicks a page-flip
  // button — these belong to the widget chrome, not the move/resize layer.
  const handleButtonDown = (e: Konva.KonvaEventObject<MouseEvent>, delta: 1 | -1) => {
    e.cancelBubble = true
    if (panMode) return
    if (pageBusy) return
    setCurrentPage((p) => {
      const next = p + delta
      if (next < 1) return p
      if (next > pageCount) return p
      return next
    })
  }

  const badgeW = 38
  const badgeH = 20
  // Arrow glyph half-extent — defines both the visible glyph size and
  // its clickable hit area.
  const arrowR = 14
  const arrowInset = 6

  const buttonY = object.position.y + object.size.height / 2
  const leftArrowX = object.position.x + arrowInset + arrowR
  const rightArrowX = object.position.x + object.size.width - arrowInset - arrowR
  const prevDisabled = currentPage <= 1 || pageBusy
  const nextDisabled = currentPage >= pageCount || pageBusy

  return (
    <>
      {displayImage ? (
        <KonvaImage
          ref={imageRef}
          image={displayImage}
          x={object.position.x}
          y={object.position.y}
          width={object.size.width}
          height={object.size.height}
          rotation={object.rotation}
          opacity={(pageBusy ? 0.7 : 1) * spawnOpacity}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          stroke={selected || nearEdge ? '#7B5CFF' : '#E2E8F0'}
          strokeWidth={selected || nearEdge ? 2 : 1}
          strokeScaleEnabled={false}
          shadowColor="rgba(15,23,42,0.18)"
          shadowBlur={selected ? 0 : 6}
          shadowOffsetY={2}
          shadowOpacity={selected ? 0 : 1}
          hitFunc={(ctx, shape) => {
            const w = shape.width()
            const h = shape.height()
            ctx.beginPath()
            ctx.rect(-HALO_PX, -HALO_PX, w + HALO_PX * 2, h + HALO_PX * 2)
            ctx.closePath()
            ctx.fillStrokeShape(shape)
          }}
        />
      ) : (
        <Rect
          ref={imageRef as unknown as React.Ref<Konva.Rect>}
          x={object.position.x}
          y={object.position.y}
          width={object.size.width}
          height={object.size.height}
          fill="#F8FAFC"
          stroke={selected || nearEdge ? '#7B5CFF' : '#E2E8F0'}
          strokeWidth={selected || nearEdge ? 2 : 1}
          strokeScaleEnabled={false}
          cornerRadius={2}
          opacity={spawnOpacity}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
      )}

      {/* PDF badge top-left */}
      <Group
        x={object.position.x + 8}
        y={object.position.y + 8}
        opacity={spawnOpacity}
        listening={false}
      >
        <Rect width={badgeW} height={badgeH} fill="rgba(15,23,42,0.85)" cornerRadius={4} />
        <Text
          width={badgeW}
          height={badgeH}
          text="PDF"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          fontSize={11}
          fontStyle="bold"
          fill="#ffffff"
          align="center"
          verticalAlign="middle"
        />
      </Group>

      {/* Plain left / right arrows — rendered last so they hit before the
          image. Shadow keeps them legible on both light and dark pages. */}
      {canPage && (
        <>
          <Text
            x={leftArrowX - arrowR}
            y={buttonY - arrowR}
            width={arrowR * 2}
            height={arrowR * 2}
            text="‹"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
            fontSize={22}
            fontStyle="bold"
            fill="#ffffff"
            opacity={(prevDisabled ? 0.3 : 1) * spawnOpacity}
            align="center"
            verticalAlign="middle"
            shadowColor="rgba(15,23,42,0.85)"
            shadowBlur={4}
            shadowOpacity={1}
            onMouseDown={(e) => handleButtonDown(e, -1)}
            onMouseEnter={(e) => {
              const stage = e.target.getStage()
              if (stage && !prevDisabled) stage.container().style.cursor = 'pointer'
            }}
            onMouseLeave={(e) => {
              const stage = e.target.getStage()
              if (stage) stage.container().style.cursor = 'default'
            }}
          />
          <Text
            x={rightArrowX - arrowR}
            y={buttonY - arrowR}
            width={arrowR * 2}
            height={arrowR * 2}
            text="›"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
            fontSize={22}
            fontStyle="bold"
            fill="#ffffff"
            opacity={(nextDisabled ? 0.3 : 1) * spawnOpacity}
            align="center"
            verticalAlign="middle"
            shadowColor="rgba(15,23,42,0.85)"
            shadowBlur={4}
            shadowOpacity={1}
            onMouseDown={(e) => handleButtonDown(e, 1)}
            onMouseEnter={(e) => {
              const stage = e.target.getStage()
              if (stage && !nextDisabled) stage.container().style.cursor = 'pointer'
            }}
            onMouseLeave={(e) => {
              const stage = e.target.getStage()
              if (stage) stage.container().style.cursor = 'default'
            }}
          />
        </>
      )}
    </>
  )
}
