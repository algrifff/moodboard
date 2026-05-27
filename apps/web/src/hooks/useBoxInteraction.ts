import { useRef, useState } from 'react'
import { useCanvasStore } from '@/store/canvas'

type Zone = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
type Mode = 'drag' | Zone

type DragOrigin = {
  mode: 'drag'
  pointer: { x: number; y: number }
  initialPositions: Map<string, { x: number; y: number }>
}

type ResizeOrigin = {
  mode: Zone
  pointer: { x: number; y: number }
  size: { w: number; h: number }
  pos: { x: number; y: number }
}

type Origin = DragOrigin | ResizeOrigin

type Options = {
  panMode: boolean
  editing: boolean
  minWidth?: number
  minHeight?: number
  edgePx?: number
  haloPx?: number
}

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

export function useBoxInteraction(objectId: string, scale: number, opts: Options) {
  const { panMode, editing, minWidth = 80, minHeight = 60, edgePx = 14, haloPx = 0 } = opts
  const updateObject = useCanvasStore((s) => s.updateObject)
  const idleCursor = editing ? 'text' : panMode ? 'grab' : 'move'
  const [cursor, setCursor] = useState<string>(idleCursor)
  const [hovering, setHovering] = useState(false)
  const originRef = useRef<Origin | null>(null)

  const computeZone = (e: React.PointerEvent<HTMLElement>): Zone | null => {
    if (panMode || editing) return null
    const rect = e.currentTarget.getBoundingClientRect()
    const innerLeft = rect.left + haloPx
    const innerTop = rect.top + haloPx
    const innerRight = rect.right - haloPx
    const innerBottom = rect.bottom - haloPx
    const left = e.clientX - innerLeft < edgePx
    const right = innerRight - e.clientX < edgePx
    const top = e.clientY - innerTop < edgePx
    const bottom = innerBottom - e.clientY < edgePx
    if (top && left) return 'nw'
    if (top && right) return 'ne'
    if (bottom && left) return 'sw'
    if (bottom && right) return 'se'
    if (top) return 'n'
    if (bottom) return 's'
    if (left) return 'w'
    if (right) return 'e'
    return null
  }

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const origin = originRef.current
    if (origin) {
      const dx = (e.clientX - origin.pointer.x) / scale
      const dy = (e.clientY - origin.pointer.y) / scale

      if (origin.mode === 'drag') {
        for (const [id, pos] of origin.initialPositions) {
          updateObject(id, { position: { x: pos.x + dx, y: pos.y + dy } })
        }
        return
      }

      const zone = origin.mode
      let nw = origin.size.w
      let nh = origin.size.h
      let nx = origin.pos.x
      let ny = origin.pos.y

      if (zone === 'e' || zone === 'ne' || zone === 'se') nw = origin.size.w + dx
      if (zone === 'w' || zone === 'nw' || zone === 'sw') {
        nw = origin.size.w - dx
        nx = origin.pos.x + dx
      }
      if (zone === 's' || zone === 'se' || zone === 'sw') nh = origin.size.h + dy
      if (zone === 'n' || zone === 'nw' || zone === 'ne') {
        nh = origin.size.h - dy
        ny = origin.pos.y + dy
      }

      if (nw < minWidth) {
        if (zone === 'w' || zone === 'nw' || zone === 'sw') {
          nx = origin.pos.x + origin.size.w - minWidth
        }
        nw = minWidth
      }
      if (nh < minHeight) {
        if (zone === 'n' || zone === 'nw' || zone === 'ne') {
          ny = origin.pos.y + origin.size.h - minHeight
        }
        nh = minHeight
      }

      updateObject(objectId, {
        size: { width: nw, height: nh },
        position: { x: nx, y: ny },
      })
      return
    }

    const zone = computeZone(e)
    setCursor(zone ? ZONE_CURSORS[zone] : idleCursor)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    if (editing || panMode) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)

    const zone = computeZone(e)
    const state = useCanvasStore.getState()
    const obj = state.objects.find((o) => o.id === objectId)
    if (!obj) return

    if (zone === null) {
      const wasSelected = state.selectedIds.includes(objectId)
      if (e.shiftKey) {
        state.toggleSelection(objectId)
      } else if (!wasSelected) {
        state.setSelection([objectId])
      }

      const after = useCanvasStore.getState()
      const initial = new Map<string, { x: number; y: number }>()
      for (const id of after.selectedIds) {
        const o = after.objects.find((o) => o.id === id)
        if (o) initial.set(id, { x: o.position.x, y: o.position.y })
      }
      if (initial.size === 0) {
        initial.set(objectId, { x: obj.position.x, y: obj.position.y })
      }

      originRef.current = {
        mode: 'drag',
        pointer: { x: e.clientX, y: e.clientY },
        initialPositions: initial,
      }
    } else {
      originRef.current = {
        mode: zone,
        pointer: { x: e.clientX, y: e.clientY },
        size: { w: obj.size.width, h: obj.size.height },
        pos: { x: obj.position.x, y: obj.position.y },
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (originRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // already released
      }
      originRef.current = null
    }
  }

  const onPointerEnter = () => setHovering(true)

  const onPointerLeave = () => {
    setHovering(false)
    if (!originRef.current) setCursor(idleCursor)
  }

  const nearEdge = cursor.endsWith('-resize')

  return {
    cursor,
    hovering,
    nearEdge,
    onPointerMove,
    onPointerDown,
    onPointerUp,
    onPointerEnter,
    onPointerLeave,
  }
}
