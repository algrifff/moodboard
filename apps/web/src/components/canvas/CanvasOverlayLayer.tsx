import type { CanvasObject } from '@moodboard/shared'
import { DriveNode } from './DriveNode'
import { FontNode } from './FontNode'
import { NotionPageNode } from './NotionPageNode'
import { StickyNote } from './StickyNote'
import { TextObject } from './TextObject'

export function CanvasOverlayLayer({
  objects,
  scale,
  offset,
  panMode,
  selectedIds,
  boardId,
}: {
  objects: CanvasObject[]
  scale: number
  offset: { x: number; y: number }
  panMode: boolean
  selectedIds: string[]
  // External nodes need the boardId for the refresh endpoint. Threaded
  // through here rather than read from a global so each node is a pure
  // function of its props.
  boardId?: string
}) {
  const selectedSet = new Set(selectedIds)
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none' }}>
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
          if (o.type === 'font') {
            return (
              <FontNode
                key={o.id}
                object={o}
                scale={scale}
                panMode={panMode}
                selected={selectedSet.has(o.id)}
              />
            )
          }
          if (o.type === 'notion-page' && boardId) {
            return (
              <NotionPageNode
                key={o.id}
                object={o}
                scale={scale}
                panMode={panMode}
                selected={selectedSet.has(o.id)}
                boardId={boardId}
              />
            )
          }
          if ((o.type === 'drive-file' || o.type === 'drive-folder') && boardId) {
            return (
              <DriveNode
                key={o.id}
                object={o}
                scale={scale}
                panMode={panMode}
                selected={selectedSet.has(o.id)}
                boardId={boardId}
              />
            )
          }
          return null
        })}
      </div>
    </div>
  )
}
