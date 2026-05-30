import {
  connectionsListResponseSchema,
  importDriveResponseSchema,
  importNotionResponseSchema,
  importWebResponseSchema,
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
  type WebPageData,
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

export type WebImportResult = {
  page: WebPageData
  logoImages: ImageData[]
}

/**
 * Snapshot a public web page by URL. No connection required — the server
 * fetches directly with SSRF guards. Returns the page card data plus 0–3
 * brand logo images saved to /data/uploads so they mount as regular
 * image objects next to the card.
 */
export async function importWebUrl(url: string): Promise<WebImportResult> {
  const res = await fetch('/api/external/web/import', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const body = importWebResponseSchema.parse(await jsonOrThrow(res))
  return { page: body.page, logoImages: body.logoImages }
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
  | { kind: 'web-page'; data: WebPageData }

export async function refreshExternal(boardId: string, objectId: string): Promise<RefreshResult> {
  const res = await fetch('/api/external/refresh', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boardId, objectId }),
  })
  const body = (await jsonOrThrow(res)) as { kind?: string; data?: unknown }
  // The server returns either { data } (notion), { kind, data } (drive), or
  // { kind: 'web-page', data, logoImages } for web pages.
  if (body.kind === 'file' || body.kind === 'folder') {
    const parsed = importDriveResponseSchema.parse(body) as DriveImportResult
    return parsed as RefreshResult
  }
  if (body.kind === 'pdf' || body.kind === 'image') {
    const parsed = importDriveResponseSchema.parse(body) as DriveImportResult
    return parsed as RefreshResult
  }
  if (body.kind === 'web-page') {
    // The /refresh response uses { kind, data, logoImages } so it slots
    // into the discriminated union here. We only swap the card data —
    // logo images keep their identity across refresh.
    const b = body as { kind: 'web-page'; data: unknown }
    const page = importWebResponseSchema.shape.page.parse(b.data)
    return { kind: 'web-page', data: page }
  }
  const notion = importNotionResponseSchema.parse(body)
  return { kind: 'notion-page', data: notion.data }
}
