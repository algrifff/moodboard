// Small JSON fetch for the Phase 22 endpoints. Failures carry the server's
// `error` text (and `code`, when it sends one) instead of a raw status line.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public body?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function requestJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const hasBody = init.body !== undefined && !(init.body instanceof FormData)
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null
    throw new ApiError(
      res.status,
      body?.error ?? `${res.status} ${res.statusText}`,
      body?.code,
      body,
    )
  }
  return res.json()
}

export const jsonBody = (value: unknown) => JSON.stringify(value)
