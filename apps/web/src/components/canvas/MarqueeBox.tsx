import type { Point } from '@/lib/transform'

export function MarqueeBox({
  start,
  end,
  scale,
  offset,
}: {
  start: Point
  end: Point
  scale: number
  offset: { x: number; y: number }
}) {
  const x1 = Math.min(start.x, end.x)
  const y1 = Math.min(start.y, end.y)
  const x2 = Math.max(start.x, end.x)
  const y2 = Math.max(start.y, end.y)

  return (
    <div
      style={{
        position: 'absolute',
        left: x1 * scale + offset.x,
        top: y1 * scale + offset.y,
        width: (x2 - x1) * scale,
        height: (y2 - y1) * scale,
        border: '1.5px dashed #7B5CFF',
        backgroundColor: 'rgba(123, 92, 255, 0.06)',
        pointerEvents: 'none',
        zIndex: 15,
      }}
    />
  )
}
