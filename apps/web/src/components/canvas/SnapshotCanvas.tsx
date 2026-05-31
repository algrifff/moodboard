import type { CanvasObject } from '@moodboard/shared'
import { useEffect, useRef, useState } from 'react'
import { Layer, Stage } from 'react-konva'
import type { SharedGroupSnapshot } from '@moodboard/shared'
import { CanvasOverlayLayer } from './CanvasOverlayLayer'
import { ColorPaletteWidget } from './ColorPaletteWidget'
import { GroupOutline } from './GroupOutline'
import { ImageNode } from './ImageNode'
import { PDFNode } from './PDFNode'

// Read-only Konva stage for the public share viewer. Reuses the editor's
// node components with `panMode={true}` so drag, resize, double-click-
// to-edit, and inline-edit affordances stay off. Computes a fit-to-all
// transform from the snapshot's combined object bounds whenever the
// container or snapshot changes.

const PADDING_PX = 60

type Bounds = { left: number; top: number; right: number; bottom: number }

function computeBounds(objects: CanvasObject[]): Bounds | null {
  if (objects.length === 0) return null
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const o of objects) {
    left = Math.min(left, o.position.x)
    top = Math.min(top, o.position.y)
    right = Math.max(right, o.position.x + o.size.width)
    bottom = Math.max(bottom, o.position.y + o.size.height)
  }
  return { left, top, right, bottom }
}

export function SnapshotCanvas({
  objects,
  groups,
  // Synthetic boardId so node components that require one (DriveNode,
  // NotionPageNode, etc.) still mount. Refresh actions are gated by
  // panMode={true}, so the dummy never reaches the API.
  pseudoBoardId,
}: {
  objects: CanvasObject[]
  groups: SharedGroupSnapshot[]
  pseudoBoardId: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const [transform, setTransform] = useState<{ scale: number; offset: { x: number; y: number } }>({
    scale: 1,
    offset: { x: 0, y: 0 },
  })

  // Observe the container — fit-to-all recomputes on resize so the hero
  // stays framed inside the doc layout.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fit-to-all transform: scale so the padded bounding box fills the
  // container, then translate to centre.
  useEffect(() => {
    if (size.width <= 0 || size.height <= 0) return
    const bounds = computeBounds(objects)
    if (!bounds) {
      setTransform({ scale: 1, offset: { x: 0, y: 0 } })
      return
    }
    const w = bounds.right - bounds.left + PADDING_PX * 2
    const h = bounds.bottom - bounds.top + PADDING_PX * 2
    const scale = Math.max(0.1, Math.min(2, Math.min(size.width / w, size.height / h)))
    const cx = (bounds.left + bounds.right) / 2
    const cy = (bounds.top + bounds.bottom) / 2
    setTransform({
      scale,
      offset: {
        x: size.width / 2 - cx * scale,
        y: size.height / 2 - cy * scale,
      },
    })
  }, [size.width, size.height, objects])

  const { scale, offset } = transform

  // Partition: Konva-rendered (images, PDFs) vs DOM-overlay rendered
  // (everything else). Mirrors what MoodBoardCanvas does.
  const konvaObjects = objects.filter((o) => o.type === 'image' || o.type === 'pdf')
  const overlayObjects = objects.filter(
    (o) =>
      o.type === 'sticky' ||
      o.type === 'text' ||
      o.type === 'font' ||
      o.type === 'notion-page' ||
      o.type === 'drive-file' ||
      o.type === 'drive-folder' ||
      o.type === 'web-page' ||
      o.type === 'spotify-playlist' ||
      o.type === 'spotify-track' ||
      o.type === 'spotify-album' ||
      o.type === 'video-clip' ||
      o.type === 'voice-note',
  )

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden">
      {size.width > 0 && size.height > 0 && (
        <Stage
          width={size.width}
          height={size.height}
          scaleX={scale}
          scaleY={scale}
          x={offset.x}
          y={offset.y}
          listening={false}
        >
          <Layer>
            {konvaObjects.map((o) =>
              o.type === 'image' ? (
                <ImageNode key={o.id} object={o} panMode={true} selected={false} />
              ) : (
                <PDFNode
                  key={o.id}
                  object={o}
                  panMode={true}
                  selected={false}
                  onOpen={() => undefined}
                />
              ),
            )}
          </Layer>
        </Stage>
      )}

      {/* Group outlines on top of the Konva stage, behind overlays */}
      <div className="absolute inset-0 pointer-events-none">
        {groups.map((g) => (
          <GroupOutline key={`outline-${g.key}`} bounds={g.bounds} scale={scale} offset={offset} />
        ))}
        {groups.map((g) => {
          const items = g.objectIds
            .map((id) => objects.find((o) => o.id === id))
            .filter((o): o is CanvasObject => Boolean(o))
          return (
            <ColorPaletteWidget
              key={`palette-${g.key}`}
              groupKey={g.key}
              objects={items}
              bounds={g.bounds}
              scale={scale}
              offset={offset}
              aiPalette={g.palette.length > 0 ? g.palette : undefined}
            />
          )
        })}
      </div>

      <CanvasOverlayLayer
        objects={overlayObjects}
        scale={scale}
        offset={offset}
        panMode={true}
        selectedIds={[]}
        boardId={pseudoBoardId}
      />
    </div>
  )
}
