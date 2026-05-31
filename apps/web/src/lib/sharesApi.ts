import {
  shareResponseSchema,
  type ShareViewParsed,
  type SharedBoardSnapshotInput,
} from '@moodboard/shared'

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json()
}

// Owner-side: read the current share for a board (or 404). Used by the
// ShareDialog to decide create-vs-manage state.
export async function getBoardShare(boardId: string): Promise<ShareViewParsed | null> {
  const res = await fetch(`/api/boards/${boardId}/share`, { credentials: 'include' })
  if (res.status === 404) return null
  const body = shareResponseSchema.parse(await jsonOrThrow(res))
  return body.share
}

// Upsert. Creating + "Update snapshot" both POST here.
export async function createOrUpdateBoardShare(
  boardId: string,
  snapshot: SharedBoardSnapshotInput,
): Promise<ShareViewParsed> {
  const res = await fetch(`/api/boards/${boardId}/share`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot }),
  })
  const body = shareResponseSchema.parse(await jsonOrThrow(res))
  return body.share
}

export async function deleteBoardShare(boardId: string): Promise<void> {
  const res = await fetch(`/api/boards/${boardId}/share`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await jsonOrThrow(res)
}

// Public — no credentials. Anyone with the token can read.
export async function getShareByToken(token: string): Promise<ShareViewParsed> {
  const res = await fetch(`/api/shares/${encodeURIComponent(token)}`)
  const body = shareResponseSchema.parse(await jsonOrThrow(res))
  return body.share
}

// Builds a viewer-side URL (relative path) for any /api/files/<x> string
// in a snapshot, rewriting it to /api/shares/<token>/files/<x>. External
// URLs (https://…) pass through unchanged.
export function rewriteAssetUrl(url: string, token: string): string {
  const prefix = '/api/files/'
  if (!url.startsWith(prefix)) return url
  const filename = url.slice(prefix.length)
  return `/api/shares/${encodeURIComponent(token)}/files/${filename}`
}
