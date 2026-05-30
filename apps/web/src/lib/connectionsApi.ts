import {
  connectionsListResponseSchema,
  importDriveResponseSchema,
  importNotionResponseSchema,
  pickerChildrenResponseSchema,
  pickerRecentsResponseSchema,
  pickerSearchResponseSchema,
  type ConnectionSummary,
  type DriveFileData,
  type DriveFolderData,
  type ImageData,
  type NotionPageData,
  type PDFData,
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

export type DriveImportResult =
  | { kind: 'file'; data: DriveFileData }
  | { kind: 'folder'; data: DriveFolderData }
  | { kind: 'pdf'; data: PDFData }
  | { kind: 'image'; data: ImageData }

export async function importDriveFile(
  connectionId: string,
  fileId: string,
): Promise<DriveImportResult> {
  const res = await fetch('/api/external/drive/import', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId, fileId }),
  })
  return importDriveResponseSchema.parse(await jsonOrThrow(res)) as DriveImportResult
}

/**
 * Refresh an existing canvas object's snapshot from its source. Returns a
 * discriminated union — Notion pages stay as 'notion-page' kind for
 * type-narrowing on the caller side.
 */
export type RefreshResult =
  | { kind: 'notion-page'; data: NotionPageData }
  | { kind: 'file'; data: DriveFileData }
  | { kind: 'folder'; data: DriveFolderData }
  | { kind: 'pdf'; data: PDFData }
  | { kind: 'image'; data: ImageData }

export async function refreshExternal(boardId: string, objectId: string): Promise<RefreshResult> {
  const res = await fetch('/api/external/refresh', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boardId, objectId }),
  })
  const body = (await jsonOrThrow(res)) as { kind?: string; data?: unknown }
  // The server returns either { data } (notion) or { kind, data } (drive).
  if (body.kind === 'file' || body.kind === 'folder') {
    const parsed = importDriveResponseSchema.parse(body) as DriveImportResult
    return parsed as RefreshResult
  }
  if (body.kind === 'pdf' || body.kind === 'image') {
    const parsed = importDriveResponseSchema.parse(body) as DriveImportResult
    return parsed as RefreshResult
  }
  const notion = importNotionResponseSchema.parse(body)
  return { kind: 'notion-page', data: notion.data }
}
