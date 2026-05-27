import type { CanvasObject, ImageData } from '@moodboard/shared'
import type Konva from 'konva'
import { useEffect, useRef, useState } from 'react'
import { Image as KonvaImage } from 'react-konva'
import { useCanvasStore } from '@/store/canvas'

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

function isImageData(data: CanvasObject['data']): data is ImageData {
  return 'url' in data && typeof (data as ImageData).url === 'string'
}

type Active = {
  mode: 'drag' | Zone
  pointer: { x: number; y: number }
  size: { w: number; h: number }
  pos: { x: number; y: number }
  aspect: number
  initialPositions: Map<string, { x: number; y: number }>
}

export function ImageNode({
  object,
  panMode,
  selected,
}: {
  object: CanvasObject
  panMode: boolean
  selected: boolean
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [nearEdge, setNearEdge] = useState(false)
  const imageRef = useRef<Konva.Image>(null)
  const activeRef = useRef<Active | null>(null)
  const url = isImageData(object.data) ? object.data.url : null

  useEffect(() => {
    if (!url) {
      setImage(null)
      return
    }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    let cancelled = false
    img.onload = () => {
      if (!cancelled) setImage(img)
    }
    img.src = url
    return () => {
      cancelled = true
    }
  }, [url])

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
    stage.container().style.cursor = zone ? ZONE_CURSORS[zone] : 'move'
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

      // Compute free-aspect values from cursor delta
      let freeW = active.size.w
      let freeH = active.size.h
      if (z === 'e' || z === 'ne' || z === 'se') freeW = active.size.w + dx
      if (z === 'w' || z === 'nw' || z === 'sw') freeW = active.size.w - dx
      if (z === 's' || z === 'se' || z === 'sw') freeH = active.size.h + dy
      if (z === 'n' || z === 'nw' || z === 'ne') freeH = active.size.h - dy

      if (z === 'n' || z === 's') {
        // Vertical edge: height drives, width follows aspect
        nh = Math.max(MIN_SIDE, freeH)
        nw = nh * aspect
      } else if (z === 'e' || z === 'w') {
        // Horizontal edge: width drives, height follows aspect
        nw = Math.max(MIN_SIDE, freeW)
        nh = nw / aspect
      } else {
        // Corner: pick whichever cursor delta is larger relative to original
        const scaleW = freeW / active.size.w
        const scaleH = freeH / active.size.h
        const scale = Math.abs(scaleW - 1) > Math.abs(scaleH - 1) ? scaleW : scaleH
        nw = Math.max(MIN_SIDE, active.size.w * scale)
        nh = Math.max(MIN_SIDE, active.size.h * scale)
      }

      // Adjust position so the opposite edge/corner stays pinned
      if (z === 'w' || z === 'nw' || z === 'sw') {
        nx = active.pos.x + active.size.w - nw
      }
      if (z === 'n' || z === 'nw' || z === 'ne') {
        ny = active.pos.y + active.size.h - nh
      }
      // For pure horizontal edges (e/w), keep top constant; for pure vertical edges (n/s), keep left constant — already handled by initial values

      updateObject(object.id, {
        size: { width: nw, height: nh },
        position: { x: nx, y: ny },
      })
    }

    const onUp = () => {
      activeRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  if (!image) return null

  return (
    <KonvaImage
      ref={imageRef}
      image={image}
      x={object.position.x}
      y={object.position.y}
      width={object.size.width}
      height={object.size.height}
      rotation={object.rotation}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      stroke={selected || nearEdge ? '#7B5CFF' : undefined}
      strokeWidth={selected || nearEdge ? 2 : 0}
      strokeScaleEnabled={false}
      hitFunc={(ctx, shape) => {
        const w = shape.width()
        const h = shape.height()
        ctx.beginPath()
        ctx.rect(-HALO_PX, -HALO_PX, w + HALO_PX * 2, h + HALO_PX * 2)
        ctx.closePath()
        ctx.fillStrokeShape(shape)
      }}
    />
  )
}
