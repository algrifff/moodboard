import type { LibraryAsset } from '@moodboard/shared'
import { FileAudio, FilePdf, File as FileIcon, TextAa } from '@phosphor-icons/react'
import { useState } from 'react'

// Preview for any library asset: the image itself, a PDF's first page, or a
// glyph for fonts and audio.
export function AssetThumb({
  asset,
  fit = 'cover',
  className = '',
}: {
  asset: Pick<LibraryAsset, 'kind' | 'thumbnailUrl' | 'name'>
  fit?: 'cover' | 'contain'
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  if (asset.thumbnailUrl && !failed) {
    return (
      <img
        src={asset.thumbnailUrl}
        alt={asset.name}
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
        className={`h-full w-full ${fit === 'cover' ? 'object-cover' : 'object-contain'} ${className}`}
      />
    )
  }
  const Glyph =
    asset.kind === 'font'
      ? TextAa
      : asset.kind === 'pdf'
        ? FilePdf
        : asset.kind === 'audio'
          ? FileAudio
          : FileIcon
  return (
    <div
      className={`flex h-full w-full items-center justify-center text-[var(--text-faint)] ${className}`}
    >
      <Glyph size={28} weight="duotone" />
    </div>
  )
}
