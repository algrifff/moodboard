import type {
  CanvasObject,
  DriveFileData,
  DriveFolderData,
  FontData,
  ImageData,
  NotionPageData,
  StickyData,
  TextData,
  WebPageData,
} from '@moodboard/shared'
import { createHash } from 'node:crypto'

// Per CLAUDE.md: cache key = stable hash of
// (sorted object IDs + per-object content hash + model version tag).
//
// Per-type content hash rules:
//   image   — URL (content lives on the volume; URL is its content identity)
//   sticky  — text + colour (both feed the analysis)
//   text    — body (font/size are presentation, not content)
//   pdf     — full data blob; PDFs are immutable post-upload so fetchedAt drift
//             isn't a concern
//   font    — family + url; the AD lists uploaded fonts as ground truth so a
//             family change must bust the cache. (Was previously omitted —
//             see 12a regression test.)
//   notion  — markdown + lastEditedAt; the cached snapshot IS the content the
//             AD reads, so hashing the markdown directly is what we want.
//             Refresh-with-no-change reuses the cache; refresh-with-new-content
//             invalidates.
export function analysisHash(objects: CanvasObject[], modelTag: string): string {
  const sorted = [...objects].sort((a, b) => a.id.localeCompare(b.id))
  const parts: string[] = []
  for (const o of sorted) {
    if (o.type === 'image') {
      const d = o.data as ImageData
      parts.push(`${o.id}|image|${d.url}`)
    } else if (o.type === 'sticky') {
      const d = o.data as StickyData
      parts.push(`${o.id}|sticky|${d.color}|${d.text}`)
    } else if (o.type === 'text') {
      const d = o.data as TextData
      parts.push(`${o.id}|text|${d.text}`)
    } else if (o.type === 'pdf') {
      parts.push(`${o.id}|pdf|${JSON.stringify(o.data)}`)
    } else if (o.type === 'font') {
      const d = o.data as FontData
      parts.push(`${o.id}|font|${d.family}|${d.url}`)
    } else if (o.type === 'notion-page') {
      const d = o.data as NotionPageData
      parts.push(`${o.id}|notion-page|${d.lastEditedAt ?? ''}|${d.markdown}`)
    } else if (o.type === 'drive-file') {
      // modifiedTime + excerpt — refresh updates both; cache picks up
      // content changes naturally when either drifts.
      const d = o.data as DriveFileData
      parts.push(`${o.id}|drive-file|${d.mimeType}|${d.modifiedTime ?? ''}|${d.excerpt}`)
    } else if (o.type === 'drive-folder') {
      const d = o.data as DriveFolderData
      parts.push(
        `${o.id}|drive-folder|${d.modifiedTime ?? ''}|${d.childCount}|${d.childPreview
          .map((c) => `${c.name}::${c.mimeType}`)
          .join(',')}`,
      )
    } else if (o.type === 'web-page') {
      // The AD reads url + title + readableText. Colours/fonts feed the
      // prompt as hints but aren't load-bearing — keep them out of the
      // hash so refetching a stylesheet-tweaked site doesn't bust the
      // cache. fetchedAt is also intentionally excluded; a manual refresh
      // that returns identical readableText should reuse the cache.
      const d = o.data as WebPageData
      parts.push(`${o.id}|web-page|${d.url}|${d.title}|${d.readableText}`)
    }
  }
  return createHash('sha256')
    .update(`${modelTag}\n${parts.join('\n')}`)
    .digest('hex')
}
