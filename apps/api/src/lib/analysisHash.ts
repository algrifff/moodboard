import type {
  CanvasObject,
  FontData,
  ImageData,
  NotionPageData,
  StickyData,
  TextData,
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
    }
  }
  return createHash('sha256')
    .update(`${modelTag}\n${parts.join('\n')}`)
    .digest('hex')
}
