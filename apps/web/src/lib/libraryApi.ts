import {
  libraryAssetResponseSchema,
  libraryResponseSchema,
  uploadResponseSchema,
  type LibraryAsset,
  type LibraryQuery,
  type UpdateAssetRequest,
} from '@moodboard/shared'
import { boardObjectChangeSchema } from '@moodboard/shared'
import { jsonBody, requestJson } from './http'

// dataTransfer type for a library asset dragged out of the sources drawer.
export const ASSET_DRAG_TYPE = 'application/x-moodboard-asset'

export type LibraryFilter = Pick<LibraryQuery, 'q' | 'client' | 'kind' | 'tag'>

export async function searchLibrary(
  filter: LibraryFilter,
  page: { limit?: number; offset?: number } = {},
): Promise<{ assets: LibraryAsset[]; nextOffset: number | null }> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...filter, ...page })) {
    if (v !== undefined && v !== '') params.set(k, String(v))
  }
  return libraryResponseSchema.parse(await requestJson(`/api/library?${params}`))
}

export async function updateLibraryAsset(
  id: string,
  patch: UpdateAssetRequest,
): Promise<LibraryAsset> {
  const body = await requestJson(`/api/library/${id}`, { method: 'PATCH', body: jsonBody(patch) })
  return libraryAssetResponseSchema.parse(body).asset
}

export async function addLibraryAssetToBoard(
  assetId: string,
  boardId: string,
  position?: { x: number; y: number },
) {
  const body = await requestJson(`/api/library/${assetId}/add-to-board`, {
    method: 'POST',
    body: jsonBody({ boardId, ...(position ? { position } : {}) }),
  })
  return boardObjectChangeSchema.parse(body)
}

// Uploads go through the shared upload route; the optional client lands the
// new asset in that client's library.
export async function uploadToLibrary(file: File, clientId?: string) {
  const fd = new FormData()
  fd.append('file', file, file.name)
  if (clientId) fd.append('clientId', clientId)
  return uploadResponseSchema.parse(await requestJson('/api/upload', { method: 'POST', body: fd }))
}
