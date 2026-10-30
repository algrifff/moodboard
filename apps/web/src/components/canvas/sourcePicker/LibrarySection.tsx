import type { CanvasObject, LibraryAsset } from '@moodboard/shared'
import { ArrowSquareOut } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { AssetThumb } from '@/components/library/AssetThumb'
import { pushServerObjects } from '@/lib/boardSync'
import { addLibraryAssetToBoard, ASSET_DRAG_TYPE, searchLibrary } from '@/lib/libraryApi'
import { useSourcePickerStore } from '@/store/sourcePicker'
import { showToast } from '../Toast'
import { EmptyHint, Section } from './tiles'

const PAGE = 12

// The asset library inside the sources drawer: newest assets, or matches for
// the drawer's search box. Click to add one at the middle of the canvas, or
// drag it onto the canvas where you want it.
export function LibrarySection({ boardId, query }: { boardId: string; query: string }) {
  const [assets, setAssets] = useState<LibraryAsset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addingId, setAddingId] = useState<string | null>(null)
  const setDragging = useSourcePickerStore((s) => s.setDraggingAsset)
  const closePicker = useSourcePickerStore((s) => s.closePicker)
  const seq = useRef(0)

  useEffect(() => {
    const s = ++seq.current
    const timer = setTimeout(
      () => {
        searchLibrary({ q: query.trim() || undefined }, { limit: PAGE })
          .then((res) => {
            if (s !== seq.current) return
            setAssets(res.assets)
            setError(null)
          })
          .catch((e: Error) => s === seq.current && setError(e.message))
      },
      query ? 250 : 0,
    )
    return () => clearTimeout(timer)
  }, [query])

  const add = async (asset: LibraryAsset) => {
    if (addingId) return
    setAddingId(asset.id)
    try {
      const change = await addLibraryAssetToBoard(asset.id, boardId)
      pushServerObjects(boardId, [
        { object: change.object as CanvasObject, version: change.version },
      ])
      showToast(`Added ${asset.name}`)
      closePicker()
    } catch (e) {
      showToast(`Couldn’t add it: ${e instanceof Error ? e.message : 'unknown error'}`)
    } finally {
      setAddingId(null)
    }
  }

  return (
    <Section
      title={
        <div className="flex w-full items-center">
          <span className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--text-mute)] font-semibold">
            Asset library
          </span>
          <a
            href="/library"
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--text-mute)] hover:text-foreground transition-colors"
          >
            Open
            <ArrowSquareOut size={11} />
          </a>
        </div>
      }
    >
      {error ? (
        <div className="px-2 py-2 text-[12px] text-destructive">{error}</div>
      ) : assets === null ? (
        <div
          className="grid gap-1.5 px-1 pt-1"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))' }}
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="aspect-square bg-[var(--bg-elevated)]"
              style={{ borderRadius: 'var(--radius)', opacity: 0.6 }}
            />
          ))}
        </div>
      ) : assets.length === 0 ? (
        <EmptyHint text={query ? 'Nothing in the library matches.' : 'The library is empty.'} />
      ) : (
        <ul
          className="grid gap-1.5 px-1 pt-1"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))' }}
        >
          {assets.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                draggable
                disabled={addingId === a.id}
                onClick={() => void add(a)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(ASSET_DRAG_TYPE, a.id)
                  e.dataTransfer.effectAllowed = 'copy'
                  // Next tick: hiding the drawer in the same task would cancel the drag.
                  setTimeout(() => setDragging(true), 0)
                }}
                onDragEnd={() => setDragging(false)}
                title={[a.name, a.caption].filter(Boolean).join(' — ')}
                aria-label={`Add ${a.name} to the board`}
                className="group relative block aspect-square w-full overflow-hidden bg-[var(--bg-elevated)] transition-opacity hover:opacity-90 disabled:opacity-40"
                style={{ borderRadius: 'var(--radius)' }}
              >
                <AssetThumb asset={a} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
