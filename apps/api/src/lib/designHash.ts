import { createHash } from 'node:crypto'
import { DEEP_MODEL } from './modelTags'

// Cache key for one designer variant (CLAUDE.md: AI cache discipline). The
// same brief for the same client, kit version, candidate templates and
// library, asked for the same format and variant slot, on the same model and
// prompt, reuses the earlier result instead of running the model again.
//
// - brief: whitespace-normalised, case kept (copy is case-sensitive)
// - templates: every template the designer could pick, as id@version
// - assetIds: the client's whole library (what search_assets can return),
//   so a new upload is a new key
// - modelTag: DEEP_MODEL + the designer prompt/tool version

// v1 = Phase 24 designer: outline/create/edit/render/finish tool set.
export const DESIGNER_MODEL_TAG = `designer@${DEEP_MODEL}@v1`

// v1 = Phase 25 video agent: script / create / edit / key frames / finish.
export const VIDEO_AGENT_MODEL_TAG = `video-agent@${DEEP_MODEL}@v1`

export type DesignCacheInput = {
  brief: string
  clientId: string | null
  kitId: string | null
  kitVersion: number | null
  templates: { id: string; version: number }[]
  assetIds: string[]
  format: string
  variantIndex: number
  modelTag: string
}

export function designCacheKey(input: DesignCacheInput): string {
  const parts = [
    input.modelTag,
    input.format,
    `variant:${input.variantIndex}`,
    `client:${input.clientId ?? ''}`,
    `kit:${input.kitId ?? ''}@${input.kitVersion ?? ''}`,
    `templates:${input.templates
      .map((t) => `${t.id}@${t.version}`)
      .sort()
      .join(',')}`,
    `assets:${[...new Set(input.assetIds)].sort().join(',')}`,
    `brief:${input.brief.replace(/\s+/g, ' ').trim()}`,
  ]
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}
