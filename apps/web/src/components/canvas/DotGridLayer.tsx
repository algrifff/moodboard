import Konva from 'konva'
import { useEffect, useRef } from 'react'
import { Layer, Shape } from 'react-konva'
import { useCanvasStore } from '@/store/canvas'

// Module-scope ripple queue so any component can fire one without prop-drilling.
// Read by the DotGridLayer's sceneFunc each frame.
type Ripple = { x: number; y: number; startTime: number }
const ripples: Ripple[] = []

/** Fire a dot-grid ripple at a world-space point. Cheap; safe to call often. */
export function emitDotRipple(x: number, y: number) {
  ripples.push({ x, y, startTime: performance.now() })
}

// Module-scope set of object IDs currently being dragged/resized. Interaction
// handlers toggle these on pointer-down / pointer-up. The grid reads from the
// canvas store each frame to resolve IDs to positions, so the halo follows
// the object live.
const activeDrags = new Set<string>()

/** Mark or unmark an object as actively dragged/resized for the drag halo. */
export function setDragHalo(id: string, active: boolean) {
  if (active) activeDrags.add(id)
  else activeDrags.delete(id)
}

// World-space spacing between dots. At zoom 1, this is also the screen-px
// spacing.
const DOT_SPACING = 24

// Base look. Radius is theme-agnostic. Base alpha is theme-scoped — read
// from --dot-base-alpha at the top of each frame (cached, only re-reads
// on data-theme attribute changes).
const DOT_BASE_RADIUS = 0.9
const DOT_BASE_ALPHA_FALLBACK = 0.18

// Cursor "magnetism" — dots within FALLOFF world-px brighten + grow.
// Softer than before; the drag halo is now the louder of the two.
const CURSOR_FALLOFF_WORLD = 140
const DOT_PEAK_RADIUS = 1.5
const DOT_PEAK_ALPHA = 0.5

// Slow global breath. Subtle — reads as life, not chrome.
const PULSE_PERIOD_MS = 4200
const PULSE_AMPLITUDE = 0.04

// Spawn ripple — a propagating ring of brightness fired when an object
// lands on the canvas.
const RIPPLE_LIFETIME_MS = 850
const RIPPLE_SPEED_PX_PER_MS = 0.6 // world-px per ms = 600 px/sec
const RIPPLE_WIDTH_WORLD = 36 // ring "thickness" in world px
const RIPPLE_PEAK_ALPHA = 0.55
const RIPPLE_PEAK_RADIUS_BOOST = 1.3

// Gravitational warp — dots near objects are pushed outward along the
// radial direction. The grid curves around mass.
const GRAV_STRENGTH = 0.21 // fraction of object radius for max displacement
const GRAV_INFLUENCE_MULT = 3 // object affects dots within N × its max dimension

// Drag halo — brightness around objects currently being dragged or resized.
// Now the louder of the two highlight effects: "this is the thing you're
// moving" reads stronger than the cursor magnetism.
const DRAG_HALO_FALLOFF_WORLD = 160
const DRAG_HALO_PEAK_ALPHA_BOOST = 0.5
const DRAG_HALO_PEAK_RADIUS_BOOST = 0.9

type Props = {
  scale: number
  offset: { x: number; y: number }
  viewportSize: { width: number; height: number }
}

export function DotGridLayer({ scale, offset, viewportSize }: Props) {
  const layerRef = useRef<Konva.Layer>(null)
  const cursorRef = useRef<{ x: number; y: number } | null>(null)
  // Konva paints to a 2D canvas, so it can't read CSS variables directly.
  // We cache the `--dot-rgb` triple and `--dot-base-alpha` and re-read
  // both whenever the document's data-theme attribute flips. The
  // sceneFunc composes `rgba(${dotRgb}, alpha)` at frame time.
  const dotRgbRef = useRef<string>('255, 255, 255')
  const dotBaseAlphaRef = useRef<number>(DOT_BASE_ALPHA_FALLBACK)

  // 60fps redraw. The callback is a no-op — Konva.Animation forces a layer
  // batchDraw each frame so the sceneFunc re-runs.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const anim = new Konva.Animation(() => {}, layer)
    anim.start()
    return () => {
      anim.stop()
    }
  }, [])

  // Read the dot grid tokens from CSS, and re-read whenever the document's
  // data-theme attribute flips. Avoids a per-frame getComputedStyle call.
  useEffect(() => {
    const readTokens = () => {
      const styles = getComputedStyle(document.documentElement)
      const rgb = styles.getPropertyValue('--dot-rgb').trim()
      if (rgb) dotRgbRef.current = rgb
      const alphaStr = styles.getPropertyValue('--dot-base-alpha').trim()
      const parsed = parseFloat(alphaStr)
      if (!Number.isNaN(parsed)) dotBaseAlphaRef.current = parsed
    }
    readTokens()
    const observer = new MutationObserver(readTokens)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])

  // Track the cursor in world space. Listen at the window level rather than
  // on the Konva stage — DOM overlays (sticky / text) sit above the canvas
  // and would otherwise swallow the stage's pointer events, making the
  // magnetism dim while hovering them. We bail when the pointer is outside
  // the canvas container's bounds so the highlight doesn't follow the mouse
  // into chrome.
  useEffect(() => {
    const layer = layerRef.current
    const stage = layer?.getStage()
    if (!stage) return
    const container = stage.container()

    const onMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) {
        cursorRef.current = null
        return
      }
      cursorRef.current = {
        x: (sx - stage.x()) / stage.scaleX(),
        y: (sy - stage.y()) / stage.scaleY(),
      }
    }
    const onWindowLeave = () => {
      cursorRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseleave', onWindowLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseleave', onWindowLeave)
    }
  }, [])

  // Auto-fire a ripple whenever the canvas gains an object (spawn from
  // toolbar/drop/paste). Drag/resize-end ripples are fired imperatively
  // from the interaction handlers via emitDotRipple().
  useEffect(() => {
    let prevObjects = useCanvasStore.getState().objects
    return useCanvasStore.subscribe((state) => {
      const next = state.objects
      if (next !== prevObjects && next.length > prevObjects.length) {
        const newest = next[next.length - 1]
        if (newest) {
          emitDotRipple(
            newest.position.x + newest.size.width / 2,
            newest.position.y + newest.size.height / 2,
          )
        }
      }
      prevObjects = next
    })
  }, [])

  return (
    <Layer ref={layerRef} listening={false}>
      <Shape
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sceneFunc={(ctx: any) => {
          const now = performance.now()

          // Visible world rect. Snap to the dot grid so the loop only
          // touches dots that could be on screen.
          const left = -offset.x / scale
          const top = -offset.y / scale
          const right = (viewportSize.width - offset.x) / scale
          const bottom = (viewportSize.height - offset.y) / scale

          const startX = Math.floor(left / DOT_SPACING) * DOT_SPACING
          const endX = Math.ceil(right / DOT_SPACING) * DOT_SPACING
          const startY = Math.floor(top / DOT_SPACING) * DOT_SPACING
          const endY = Math.ceil(bottom / DOT_SPACING) * DOT_SPACING

          const cursor = cursorRef.current
          const falloffSq = CURSOR_FALLOFF_WORLD * CURSOR_FALLOFF_WORLD

          const phase = ((now % PULSE_PERIOD_MS) / PULSE_PERIOD_MS) * Math.PI * 2
          const pulse = Math.sin(phase) * PULSE_AMPLITUDE

          // Theme-scoped base alpha. Cursor / drag / ripple peak math
          // stays anchored to DOT_PEAK_ALPHA so the brighten amount scales
          // inversely with the base — at higher base the relative boost
          // shrinks, which preserves the "calm baseline, loud peak" feel
          // in light mode without retuning every constant.
          const baseAlpha = dotBaseAlphaRef.current

          // Prune expired ripples in place. The list is module-scope so
          // imperative callers can push into it from anywhere.
          for (let i = ripples.length - 1; i >= 0; i--) {
            if (now - ripples[i]!.startTime >= RIPPLE_LIFETIME_MS) {
              ripples.splice(i, 1)
            }
          }

          // Snapshot gravity sources once per frame. AABB-aware: each
          // object contributes a displacement field whose direction is
          // outward from the nearest point on its bounding box, not from
          // a single center. For elongated nodes (wide images, tall text)
          // this spreads the warp across the silhouette instead of bunching
          // it at the centroid.
          const objects = useCanvasStore.getState().objects
          const grav = objects.map((o) => {
            const r = Math.max(o.size.width, o.size.height) / 2
            const reach = r * GRAV_INFLUENCE_MULT
            return {
              bL: o.position.x,
              bR: o.position.x + o.size.width,
              bT: o.position.y,
              bB: o.position.y + o.size.height,
              cx: o.position.x + o.size.width / 2,
              cy: o.position.y + o.size.height / 2,
              mass: r,
              reach,
              reachSq: reach * reach,
            }
          })

          // Drag halos — resolve active drag IDs to current centers.
          const halos: Array<{ x: number; y: number }> = []
          if (activeDrags.size > 0) {
            for (const o of objects) {
              if (!activeDrags.has(o.id)) continue
              halos.push({
                x: o.position.x + o.size.width / 2,
                y: o.position.y + o.size.height / 2,
              })
            }
          }
          const haloFalloffSq = DRAG_HALO_FALLOFF_WORLD * DRAG_HALO_FALLOFF_WORLD

          for (let gx = startX; gx <= endX; gx += DOT_SPACING) {
            for (let gy = startY; gy <= endY; gy += DOT_SPACING) {
              let alpha = baseAlpha + pulse
              let dotR = DOT_BASE_RADIUS
              let drawX = gx
              let drawY = gy

              // Gravitational displacement, AABB-aware. For each object:
              // (1) cheap-reject if the dot is outside the bbox expanded
              //     by `reach`,
              // (2) clamp the dot's grid position to the bbox to get the
              //     closest point on the box edge,
              // (3) push outward from that closest point with a smooth
              //     (1 − distNorm)² fade.
              // Dots that fall inside the bbox push away from the box
              // center instead — keeps the field continuous through the
              // node's footprint.
              for (let i = 0; i < grav.length; i++) {
                const g = grav[i]!
                if (
                  gx < g.bL - g.reach ||
                  gx > g.bR + g.reach ||
                  gy < g.bT - g.reach ||
                  gy > g.bB + g.reach
                )
                  continue
                const cpX = gx < g.bL ? g.bL : gx > g.bR ? g.bR : gx
                const cpY = gy < g.bT ? g.bT : gy > g.bB ? g.bB : gy
                const vdx = gx - cpX
                const vdy = gy - cpY
                if (vdx === 0 && vdy === 0) {
                  // Dot is inside the bbox — push away from center.
                  const cdx = gx - g.cx
                  const cdy = gy - g.cy
                  const cd = Math.sqrt(cdx * cdx + cdy * cdy) || 0.001
                  const mag = g.mass * GRAV_STRENGTH
                  drawX += (cdx / cd) * mag
                  drawY += (cdy / cd) * mag
                  continue
                }
                const vdSq = vdx * vdx + vdy * vdy
                if (vdSq >= g.reachSq) continue
                const vd = Math.sqrt(vdSq)
                const distNorm = vd / g.reach
                const fade = (1 - distNorm) * (1 - distNorm)
                const mag = g.mass * GRAV_STRENGTH * fade
                drawX += (vdx / vd) * mag
                drawY += (vdy / vd) * mag
              }

              // Cursor brighten — keyed off the undisplaced grid coords so
              // the highlight tracks the pointer predictably.
              if (cursor) {
                const dx = gx - cursor.x
                const dy = gy - cursor.y
                const dSq = dx * dx + dy * dy
                if (dSq < falloffSq) {
                  const t = 1 - Math.sqrt(dSq) / CURSOR_FALLOFF_WORLD
                  const gauss = t * t
                  alpha += (DOT_PEAK_ALPHA - baseAlpha) * gauss
                  dotR += (DOT_PEAK_RADIUS - DOT_BASE_RADIUS) * gauss
                }
              }

              // Drag halos — soft brightness around any object currently
              // being dragged or resized. Same falloff shape as the cursor
              // magnetism but with smaller boosts so the cursor still leads
              // visually.
              for (let i = 0; i < halos.length; i++) {
                const h = halos[i]!
                const dx = gx - h.x
                const dy = gy - h.y
                const dSq = dx * dx + dy * dy
                if (dSq >= haloFalloffSq) continue
                const t = 1 - Math.sqrt(dSq) / DRAG_HALO_FALLOFF_WORLD
                const gauss = t * t
                alpha += DRAG_HALO_PEAK_ALPHA_BOOST * gauss
                dotR += DRAG_HALO_PEAK_RADIUS_BOOST * gauss
              }

              // Spawn ripples — each active ring adds brightness near its
              // current radius from origin.
              for (let i = 0; i < ripples.length; i++) {
                const ripple = ripples[i]!
                const age = now - ripple.startTime
                const ringRadius = age * RIPPLE_SPEED_PX_PER_MS
                const dx = gx - ripple.x
                const dy = gy - ripple.y
                const d = Math.sqrt(dx * dx + dy * dy)
                const diff = Math.abs(d - ringRadius)
                if (diff > RIPPLE_WIDTH_WORLD) continue
                const ringStrength =
                  (1 - diff / RIPPLE_WIDTH_WORLD) * (1 - age / RIPPLE_LIFETIME_MS)
                alpha += RIPPLE_PEAK_ALPHA * ringStrength
                dotR += RIPPLE_PEAK_RADIUS_BOOST * ringStrength
              }

              ctx.beginPath()
              ctx.arc(drawX, drawY, dotR, 0, Math.PI * 2)
              ctx.fillStyle = `rgba(${dotRgbRef.current}, ${Math.min(alpha, 1)})`
              ctx.fill()
            }
          }
        }}
      />
    </Layer>
  )
}
