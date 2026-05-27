export type Point = { x: number; y: number }
export type CanvasTransform = { scale: number; x: number; y: number }

export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 4

export function clampZoom(scale: number): number {
  return Math.min(Math.max(scale, ZOOM_MIN), ZOOM_MAX)
}

export function worldToScreen(p: Point, t: CanvasTransform): Point {
  return {
    x: p.x * t.scale + t.x,
    y: p.y * t.scale + t.y,
  }
}

export function screenToWorld(p: Point, t: CanvasTransform): Point {
  return {
    x: (p.x - t.x) / t.scale,
    y: (p.y - t.y) / t.scale,
  }
}

export function zoomAroundPoint(
  current: CanvasTransform,
  screenPoint: Point,
  nextScale: number,
): CanvasTransform {
  const clamped = clampZoom(nextScale)
  const world = screenToWorld(screenPoint, current)
  return {
    scale: clamped,
    x: screenPoint.x - world.x * clamped,
    y: screenPoint.y - world.y * clamped,
  }
}
