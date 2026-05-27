import {
  boardResponseSchema,
  boardSummariesResponseSchema,
  type BoardSummary,
  type FullBoard,
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
  const body = boardResponseSchema.parse(await jsonOrThrow(res))
  return body.board
}

export async function getBoard(id: string): Promise<FullBoard> {
  const res = await fetch(`/api/boards/${id}`, { credentials: 'include' })
  const body = boardResponseSchema.parse(await jsonOrThrow(res))
  return body.board
}

export async function updateBoard(
  id: string,
  patch: { name?: string; data?: unknown },
): Promise<FullBoard> {
  const res = await fetch(`/api/boards/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const body = boardResponseSchema.parse(await jsonOrThrow(res))
  return body.board
}

export async function deleteBoard(id: string): Promise<void> {
  const res = await fetch(`/api/boards/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await jsonOrThrow(res)
}
