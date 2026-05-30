import {
  connectionsListResponseSchema,
  importNotionResponseSchema,
  pickerChildrenResponseSchema,
  pickerRecentsResponseSchema,
  pickerSearchResponseSchema,
  type ConnectionSummary,
  type NotionPageData,
  type PickerTile,
} from '@moodboard/shared'

// Thin wrapper around the Phase 12+ connection / external endpoints.
// Mirrors the shape of apps/web/src/lib/boardsApi.ts — parse the wire body
// with the shared zod schemas at the boundary so any drift between API and
// frontend trips a clear error rather than corrupting the canvas state.

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json()
}

export async function listConnections(): Promise<ConnectionSummary[]> {
  const res = await fetch('/api/connections', { credentials: 'include' })
  const body = connectionsListResponseSchema.parse(await jsonOrThrow(res))
  return body.connections
}

export async function deleteConnection(id: string): Promise<void> {
  const res = await fetch(`/api/connections/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await jsonOrThrow(res)
}

export async function searchConnection(
  connectionId: string,
  query: string,
  cursor?: string,
): Promise<{ tiles: PickerTile[]; nextCursor?: string }> {
  const res = await fetch(`/api/connections/${connectionId}/search`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, cursor }),
  })
  const body = pickerSearchResponseSchema.parse(await jsonOrThrow(res))
  return { tiles: body.tiles, nextCursor: body.nextCursor }
}

export async function listRecents(connectionId: string): Promise<PickerTile[]> {
  const res = await fetch(`/api/connections/${connectionId}/recents`, {
    credentials: 'include',
  })
  const body = pickerRecentsResponseSchema.parse(await jsonOrThrow(res))
  return body.tiles
}

/** Expand a parent page to its direct sub-pages — drives the tree view. */
export async function listChildPages(
  connectionId: string,
  parentId: string,
): Promise<PickerTile[]> {
  const res = await fetch(`/api/connections/${connectionId}/children`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId }),
  })
  const body = pickerChildrenResponseSchema.parse(await jsonOrThrow(res))
  return body.tiles
}

export async function importNotionPage(
  connectionId: string,
  pageId: string,
): Promise<NotionPageData> {
  const res = await fetch('/api/external/notion/import', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId, pageId }),
  })
  const body = importNotionResponseSchema.parse(await jsonOrThrow(res))
  return body.data
}

/** Refresh an existing canvas object's snapshot from its source. */
export async function refreshExternal(boardId: string, objectId: string): Promise<NotionPageData> {
  const res = await fetch('/api/external/refresh', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boardId, objectId }),
  })
  // Refresh currently only supports notion-page; when Drive lands, the
  // response shape will be a discriminated union and this parser changes.
  const body = importNotionResponseSchema.parse(await jsonOrThrow(res))
  return body.data
}
