import {
  boardResponseSchema,
  boardSummariesResponseSchema,
  saveBoardObjectsResponseSchema,
  type BoardSummary,
  type FullBoard,
  type SaveBoardObjectsRequest,
  type SaveBoardObjectsResponse,
} from '@moodboard/shared'

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json()
}

export async function listBoards(): Promise<BoardSummary[]> {
  const res = await fetch('/api/boards', { credentials: 'include' })
  const body = boardSummariesResponseSchema.parse(await jsonOrThrow(res))
  return body.boards
}

export async function createBoard(name?: string): Promise<FullBoard> {
  const res = await fetch('/api/boards', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(name ? { name } : {}),
  })
  return boardResponseSchema.parse(await jsonOrThrow(res)).board as FullBoard
}

// The stored objects' `data` passes through unparsed (see
// storedCanvasObjectSchema), so the cast to CanvasObject is where the client
// takes responsibility for the per-type shape — same as the old blob.
export async function getBoard(id: string): Promise<FullBoard> {
  const res = await fetch(`/api/boards/${id}`, { credentials: 'include' })
  return boardResponseSchema.parse(await jsonOrThrow(res)).board as FullBoard
}

export async function renameBoard(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/boards/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  await jsonOrThrow(res)
}

// `keepalive` lets the final flush on navigation complete after unmount.
export async function saveBoardObjects(
  id: string,
  request: SaveBoardObjectsRequest,
  options: { keepalive?: boolean } = {},
): Promise<SaveBoardObjectsResponse> {
  const res = await fetch(`/api/boards/${id}/objects`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    keepalive: options.keepalive ?? false,
  })
  return saveBoardObjectsResponseSchema.parse(await jsonOrThrow(res)) as SaveBoardObjectsResponse
}

export async function deleteBoard(id: string): Promise<void> {
  const res = await fetch(`/api/boards/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await jsonOrThrow(res)
}
