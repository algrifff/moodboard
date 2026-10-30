import {
  agentStreamEventSchema,
  agentThreadResponseSchema,
  agentThreadSchema,
  agentThreadsResponseSchema,
  type AgentStreamEvent,
  type AgentThread,
  type AgentThreadResponse,
  type PostAgentMessageRequest,
} from '@moodboard/shared'

const base = (boardId: string) => `/api/boards/${boardId}/agent`

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export async function listAgentThreads(boardId: string): Promise<AgentThread[]> {
  const res = await fetch(`${base(boardId)}/threads`, { credentials: 'include' })
  return agentThreadsResponseSchema.parse(await jsonOrThrow(res)).threads
}

export async function getAgentThread(
  boardId: string,
  threadId: string,
): Promise<AgentThreadResponse> {
  const res = await fetch(`${base(boardId)}/threads/${threadId}`, { credentials: 'include' })
  return agentThreadResponseSchema.parse(await jsonOrThrow(res))
}

export async function createAgentThread(boardId: string): Promise<AgentThread> {
  const res = await fetch(`${base(boardId)}/threads`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const body = (await jsonOrThrow(res)) as { thread: unknown }
  return agentThreadSchema.parse(body.thread)
}

export async function deleteAgentThread(boardId: string, threadId: string): Promise<void> {
  const res = await fetch(`${base(boardId)}/threads/${threadId}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await jsonOrThrow(res)
}

// POSTs a message and feeds each SSE event to `onEvent` until the stream
// ends. EventSource can't POST, so this reads the body stream directly.
export async function streamAgentMessage(
  boardId: string,
  threadId: string,
  body: PostAgentMessageRequest,
  onEvent: (event: AgentStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${base(boardId)}/threads/${threadId}/messages`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) await jsonOrThrow(res)
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) {
        const parsed = agentStreamEventSchema.safeParse(JSON.parse(data))
        if (parsed.success) onEvent(parsed.data)
        else console.warn('unrecognised agent event', parsed.error)
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}
