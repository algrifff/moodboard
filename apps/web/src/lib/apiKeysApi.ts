// Client helpers for the dashboard's API keys card. Keys are surfaced
// here only to be used as Bearer tokens against /api/mcp — the
// dashboard never sees the plaintext after the create-time modal.

export type ApiKeyView = {
  id: string
  name: string
  prefix: string
  lastUsedAt: string | null
  createdAt: string
}

export type MintedApiKey = {
  id: string
  name: string
  prefix: string
  plaintext: string
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json()
}

export async function listApiKeys(): Promise<ApiKeyView[]> {
  const res = await fetch('/api/keys', { credentials: 'include' })
  const body = (await jsonOrThrow(res)) as { keys: ApiKeyView[] }
  return body.keys
}

export async function mintApiKey(name: string): Promise<MintedApiKey> {
  const res = await fetch('/api/keys', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const body = (await jsonOrThrow(res)) as { key: MintedApiKey }
  return body.key
}

export async function deleteApiKey(id: string): Promise<void> {
  const res = await fetch(`/api/keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await jsonOrThrow(res)
}
