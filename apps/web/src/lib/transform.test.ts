import { describe, expect, it } from 'vitest'
import {
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  screenToWorld,
  worldToScreen,
  zoomAroundPoint,
} from './transform'

describe('clampZoom', () => {
  it('clamps below min', () => {
    expect(clampZoom(0.05)).toBe(ZOOM_MIN)
  })
  it('clamps above max', () => {
    expect(clampZoom(10)).toBe(ZOOM_MAX)
  })
  it('passes through in-range values', () => {
    expect(clampZoom(1.5)).toBe(1.5)
  })
})

describe('worldToScreen / screenToWorld', () => {
  it('identity transform is the identity', () => {
    const t = { scale: 1, x: 0, y: 0 }
    expect(worldToScreen({ x: 10, y: 20 }, t)).toEqual({ x: 10, y: 20 })
    expect(screenToWorld({ x: 10, y: 20 }, t)).toEqual({ x: 10, y: 20 })
  })

  it('round-trips at scale=1 with offset', () => {
    const t = { scale: 1, x: 100, y: 50 }
    const world = { x: 42, y: -7 }
    expect(screenToWorld(worldToScreen(world, t), t)).toEqual(world)
  })

  it('round-trips at min zoom', () => {
    const t = { scale: ZOOM_MIN, x: 33, y: -11 }
    const world = { x: 200, y: -400 }
    const back = screenToWorld(worldToScreen(world, t), t)
    expect(back.x).toBeCloseTo(world.x, 10)
    expect(back.y).toBeCloseTo(world.y, 10)
  })

  it('round-trips at max zoom', () => {
    const t = { scale: ZOOM_MAX, x: -50, y: 7 }
    const world = { x: 0.5, y: -0.25 }
    const back = screenToWorld(worldToScreen(world, t), t)
    expect(back.x).toBeCloseTo(world.x, 10)
    expect(back.y).toBeCloseTo(world.y, 10)
  })
})

describe('zoomAroundPoint', () => {
  it('keeps the screen point fixed in world coords', () => {
    const t = { scale: 1, x: 0, y: 0 }
    const screen = { x: 300, y: 200 }
    const worldBefore = screenToWorld(screen, t)
    const next = zoomAroundPoint(t, screen, 2)
    expect(next.scale).toBe(2)
    const worldAfter = screenToWorld(screen, next)
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 10)
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 10)
  })

  it('clamps zoom past max', () => {
    const next = zoomAroundPoint({ scale: 2, x: 0, y: 0 }, { x: 0, y: 0 }, 100)
    expect(next.scale).toBe(ZOOM_MAX)
  })
})
