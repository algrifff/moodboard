import type { CanvasObject, ImageData, StickyData, TextData } from '@moodboard/shared'
import { createHash } from 'node:crypto'

// Per CLAUDE.md: cache key = stable hash of
// (sorted object IDs + per-object content hash + model version tag).
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
    }
  }
  return createHash('sha256')
    .update(`${modelTag}\n${parts.join('\n')}`)
    .digest('hex')
}
