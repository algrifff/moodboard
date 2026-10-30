import type { PickerTile } from '@moodboard/shared'
import { useEffect, useRef, useState } from 'react'
import { listRecents } from '@/lib/connectionsApi'
import type { PickerConnection } from '@/store/sourcePicker'
import { EmptyHint, Section, TileRow, TileSkeletonList } from './tiles'

// ---------------------------------------------------------------------------
// Recents — across-connection recently imported items.
// ---------------------------------------------------------------------------

export function RecentsSection({
  connections,
  onImport,
  importingId,
}: {
  connections: PickerConnection[]
  onImport: (tile: PickerTile) => void
  importingId: string | null
}) {
  const [tiles, setTiles] = useState<PickerTile[]>([])
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const s = ++seq.current
    setLoading(true)
    Promise.all(connections.map((c) => listRecents(c.id)))
      .then((all) => {
        if (s !== seq.current) return
        const flat = all.flat().sort((a, b) => {
          const ta = a.lastEditedAt ? Date.parse(a.lastEditedAt) : 0
          const tb = b.lastEditedAt ? Date.parse(b.lastEditedAt) : 0
          return tb - ta
        })
        setTiles(flat)
      })
      .catch(() => {
        // Best-effort — leave previous tiles in place.
      })
      .finally(() => {
        if (s === seq.current) setLoading(false)
      })
  }, [connections])

  // No recents and no connection? The empty state takes over. With at
  // least one connection but no recents we still show a tidy "nothing yet"
  // so the structure stays consistent.
  return (
    <Section title="Recently added">
      {loading && tiles.length === 0 ? (
        <TileSkeletonList rows={3} />
      ) : tiles.length === 0 ? (
        <EmptyHint text="Nothing here yet. Import from a source below to start." />
      ) : (
        <div className="flex flex-col gap-0.5">
          {tiles.slice(0, 8).map((t) => (
            <TileRow
              key={`recents:${t.connectionId}:${t.id}`}
              tile={t}
              depth={0}
              onImport={onImport}
              onToggleExpand={() => {}}
              expandedChildren={{}}
              loadingChildren={NO_LOADING}
              importingId={importingId}
              canExpand={false}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

const NO_LOADING = new Set<string>()
