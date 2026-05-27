import type { CanvasObject } from '@moodboard/shared'
import { StickyNote } from './StickyNote'
import { TextObject } from './TextObject'

export function CanvasOverlayLayer({
  objects,
  scale,
  offset,
  panMode,
  selectedIds,
}: {
  objects: CanvasObject[]
  scale: number
  offset: { x: number; y: number }
  panMode: boolean
  selectedIds: string[]
}) {
  const selectedSet = new Set(selectedIds)
  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ pointerEvents: 'none' }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          pointerEvents: 'none',
        }}
      >
        {objects.map((o) => {
          if (o.type === 'sticky') {
            return (
              <StickyNote
                key={o.id}
                object={o}
                scale={scale}
                panMode={panMode}
                selected={selectedSet.has(o.id)}
              />
            )
          }
          if (o.type === 'text') {
            return (
              <TextObject
                key={o.id}
                object={o}
                scale={scale}
                panMode={panMode}
                selected={selectedSet.has(o.id)}
              />
            )
          }
          return null
        })}
      </div>
    </div>
  )
}
