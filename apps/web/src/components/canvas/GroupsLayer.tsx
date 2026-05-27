import type { CanvasObject } from '@moodboard/shared'
import { AnimatePresence } from 'framer-motion'
import { useMemo } from 'react'
import { groupBoundingBox, groupId, proximityGroups } from '@/lib/aabb'
import { ColorPaletteWidget } from './ColorPaletteWidget'
import { GroupOutline } from './GroupOutline'

export function GroupsLayer({
  objects,
  scale,
  offset,
}: {
  objects: CanvasObject[]
  scale: number
  offset: { x: number; y: number }
}) {
  const groups = useMemo(() => {
    const idGroups = proximityGroups(objects, 24)
    const byId = new Map(objects.map((o) => [o.id, o]))
    return idGroups.map((ids) => {
      const items = ids.map((id) => byId.get(id)!).filter(Boolean)
      return {
        key: groupId(ids),
        items,
        bounds: groupBoundingBox(items, 20),
      }
    })
  }, [objects])

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none' }}>
      <AnimatePresence>
        {groups.map((g) => (
          <GroupOutline key={g.key} bounds={g.bounds} scale={scale} offset={offset} />
        ))}
      </AnimatePresence>
      {groups.map((g) => (
        <ColorPaletteWidget
          key={`palette-${g.key}`}
          groupKey={g.key}
          objects={g.items}
          bounds={g.bounds}
          scale={scale}
          offset={offset}
        />
      ))}
    </div>
  )
}
