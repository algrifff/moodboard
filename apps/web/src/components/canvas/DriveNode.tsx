import type { CanvasObject, DriveFileData, DriveFolderData } from '@moodboard/shared'
import {
  ArrowClockwise,
  ArrowSquareOut,
  File,
  FileDoc,
  FilePpt,
  FileXls,
  Folder,
  type Icon,
} from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useState } from 'react'
import { useBoxInteraction } from '@/hooks/useBoxInteraction'
import { refreshExternal } from '@/lib/connectionsApi'
import { OBJECT_SPAWN_DURATION, SNAP_CURVE } from '@/lib/motion'
import { useCanvasStore } from '@/store/canvas'
import { SpawnRing } from './SpawnRing'

// DOM overlay node for a Google Drive file or folder. Same shell as
// NotionPageNode — title link + provider line + Open in Drive pill +
// refresh dot + spawn ring. Whole card is the drag surface; link
// elements stop pointer-capture on themselves so native clicks fire.
//
// Files-by-mime that route through dedicated nodes (PDFs → PDFNode,
// images → ImageNode) never get here; the import response signals
// `kind` and the picker / paste handler dispatch accordingly.
//
// Folders carry a childCount chip + the first 30 child names as
// `childPreview` so the AD can read folder context. The card itself
// just shows "Drive · folder · {N} items".

// Google-native mime types that get tailored icons. Anything else falls
// back to the generic File glyph.
const MIME_DOC = 'application/vnd.google-apps.document'
const MIME_SHEET = 'application/vnd.google-apps.spreadsheet'
const MIME_SLIDES = 'application/vnd.google-apps.presentation'

export function DriveNode({
  object,
  scale,
  panMode,
  selected,
  boardId,
}: {
  object: CanvasObject
  scale: number
  panMode: boolean
  selected: boolean
  boardId: string
}) {
  const isFolder = object.type === 'drive-folder'
  const fileData = isFolder ? null : (object.data as DriveFileData)
  const folderData = isFolder ? (object.data as DriveFolderData) : null
  const updateObject = useCanvasStore((s) => s.updateObject)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const HALO = 14
  const interaction = useBoxInteraction(object.id, scale, {
    panMode,
    editing: false,
    minWidth: 200,
    minHeight: 96,
    haloPx: HALO,
  })

  const stale = isStale(object)
  const name = folderData?.name ?? fileData?.name ?? 'Untitled'
  const webViewLink = folderData?.webViewLink ?? fileData?.webViewLink ?? ''
  const mimeType = folderData ? 'folder' : (fileData?.mimeType ?? '')

  const linkPointerDown = (e: React.PointerEvent) => e.stopPropagation()
  const openInDrive = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (webViewLink) window.open(webViewLink, '_blank', 'noopener,noreferrer')
  }

  const onRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (refreshing) return
    setRefreshing(true)
    setRefreshError(null)
    try {
      const fresh = await refreshExternal(boardId, object.id)
      useCanvasStore.getState().commitBeforeAction()
      // refreshExternal returns the same shape as import — for drive that's
      // a discriminated union. We expect 'file' or 'folder' here since
      // PDFs / images shouldn't be mounted as DriveNode in the first place.
      if (fresh.kind === 'file' || fresh.kind === 'folder') {
        updateObject(object.id, { data: fresh.data })
      }
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: OBJECT_SPAWN_DURATION, ease: [...SNAP_CURVE] }}
      onPointerEnter={interaction.onPointerEnter}
      onPointerLeave={interaction.onPointerLeave}
      onPointerMove={interaction.onPointerMove}
      onPointerDown={interaction.onPointerDown}
      onPointerUp={interaction.onPointerUp}
      style={{
        position: 'absolute',
        left: object.position.x - HALO,
        top: object.position.y - HALO,
        width: object.size.width + HALO * 2,
        height: object.size.height + HALO * 2,
        padding: HALO,
        boxSizing: 'border-box',
        cursor: interaction.cursor,
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          backgroundColor: 'var(--bg-card)',
          boxShadow: 'var(--shadow-card)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          outline: selected || interaction.nearEdge ? '2px solid var(--accent)' : 'none',
          outlineOffset: 3,
          color: 'var(--text)',
          display: 'flex',
          flexDirection: 'column',
          padding: '14px 16px',
          boxSizing: 'border-box',
        }}
      >
        <SpawnRing />
        <div className="flex items-start gap-2.5" style={{ minWidth: 0 }}>
          <MimeIcon mimeType={mimeType} />
          <a
            href={webViewLink}
            target="_blank"
            rel="noreferrer noopener"
            onPointerDown={linkPointerDown}
            onClick={openInDrive}
            className="flex-1 min-w-0 text-[14px] font-semibold leading-snug hover:underline"
            style={{
              color: 'inherit',
              textDecoration: 'none',
              cursor: 'pointer',
              wordBreak: 'break-word',
            }}
            title={`${name} — opens in Drive`}
          >
            {name}
          </a>
          <RefreshDot stale={stale} refreshing={refreshing} onClick={onRefresh} />
        </div>
        <div
          className="text-[10.5px] uppercase tracking-[0.1em] text-[var(--text-faint)] mt-1"
          style={{ marginLeft: 32 }}
        >
          {providerSubLine(folderData, fileData)}
        </div>
        <div style={{ flex: 1 }} />
        <a
          href={webViewLink}
          target="_blank"
          rel="noreferrer noopener"
          onPointerDown={linkPointerDown}
          onClick={openInDrive}
          className="inline-flex items-center gap-1 self-start text-[11.5px] font-medium hover:underline"
          style={{
            color: 'var(--text-mute)',
            textDecoration: 'none',
            padding: '4px 8px',
            borderRadius: 'var(--radius)',
            backgroundColor: 'var(--bg-elevated)',
            cursor: 'pointer',
          }}
        >
          Open in Drive
          <ArrowSquareOut size={11} weight="bold" />
        </a>
        {refreshError && (
          <div className="text-[11px] text-destructive mt-1.5" title={refreshError}>
            Refresh failed
          </div>
        )}
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Internal pieces
// ---------------------------------------------------------------------------

function providerSubLine(folder: DriveFolderData | null, file: DriveFileData | null): string {
  if (folder) {
    const items = folder.childCount === 1 ? '1 item' : `${folder.childCount} items`
    return `Drive · folder · ${items}`
  }
  if (file) {
    const label = mimeLabel(file.mimeType)
    const edited = file.modifiedTime ? ` · edited ${relativeTime(file.modifiedTime)}` : ''
    return `Drive · ${label}${edited}`
  }
  return 'Drive'
}

function mimeLabel(mimeType: string): string {
  if (mimeType === MIME_DOC) return 'Doc'
  if (mimeType === MIME_SHEET) return 'Sheet'
  if (mimeType === MIME_SLIDES) return 'Slides'
  // Strip top-level for everything else: "application/pdf" → "Pdf",
  // "text/plain" → "Plain", "video/mp4" → "Mp4". Good enough for the chip.
  const sub = mimeType.split('/')[1] ?? mimeType
  return sub.charAt(0).toUpperCase() + sub.slice(1).split('.').pop()
}

function MimeIcon({ mimeType }: { mimeType: string }) {
  const IconCmp: Icon =
    mimeType === 'folder' || mimeType === 'application/vnd.google-apps.folder'
      ? Folder
      : mimeType === MIME_DOC
        ? FileDoc
        : mimeType === MIME_SHEET
          ? FileXls
          : mimeType === MIME_SLIDES
            ? FilePpt
            : File
  return (
    <div
      className="w-6 h-6 flex items-center justify-center"
      style={{ flexShrink: 0, color: 'var(--text-mute)' }}
    >
      <IconCmp size={20} weight="duotone" />
    </div>
  )
}

function RefreshDot({
  stale,
  refreshing,
  onClick,
}: {
  stale: boolean
  refreshing: boolean
  onClick: (e: React.MouseEvent) => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      title={stale ? 'Source updated — refresh' : 'Refresh from source'}
      aria-label="Refresh from source"
      className="inline-flex items-center justify-center transition-colors"
      style={{
        width: 22,
        height: 22,
        borderRadius: 999,
        color: stale ? 'var(--accent)' : 'var(--text-faint)',
        backgroundColor: stale ? 'var(--accent-fade)' : 'transparent',
        flexShrink: 0,
      }}
    >
      <ArrowClockwise
        size={12}
        weight={stale ? 'bold' : 'regular'}
        style={{ animation: refreshing ? 'mb-spin 800ms linear infinite' : 'none' }}
      />
    </button>
  )
}

function isStale(object: CanvasObject): boolean {
  const d = object.data as { modifiedTime?: string; fetchedAt?: string }
  if (!d.modifiedTime || !d.fetchedAt) return false
  const fetched = Date.parse(d.fetchedAt)
  const modified = Date.parse(d.modifiedTime)
  if (Number.isNaN(fetched) || Number.isNaN(modified)) return false
  return modified > fetched
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}
