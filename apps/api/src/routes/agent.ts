import Anthropic from '@anthropic-ai/sdk'
import {
  createAgentThreadRequestSchema,
  deriveThreadTitle,
  postAgentMessageRequestSchema,
  type AgentStreamEvent,
} from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import type { Context, Next } from 'hono'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import {
  appendMessage,
  createThread,
  DEFAULT_THREAD_TITLE,
  deleteThread,
  getThread,
  listMessages,
  listThreads,
  setThreadTitle,
} from '../lib/agentThreads'
import { boardToolset } from '../lib/agentToolset'
import { anthropicModelClient, runOrchestrator, type ModelClient } from '../lib/orchestrator'
import { rateLimit } from '../lib/rateLimit'

type Variables = { user: AuthUser | null; session: AuthSession | null }

// Sidebar threads for a board. Mounted at /api/boards/:boardId/agent.
// Team-visible: anyone signed in can read and continue any thread.
export const agent = new Hono<{ Variables: Variables }>()

const modelClient: ModelClient | null = process.env.ANTHROPIC_API_KEY
  ? anthropicModelClient(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }))
  : null

// One run per thread at a time on this instance — a second send while the
// first is streaming would interleave two loops over the same history.
const runningThreads = new Set<string>()

const agentRateLimit = rateLimit({ scope: 'agent', limit: 20, windowMs: 60_000 })

async function requireBoard(c: Context<{ Variables: Variables }>, next: Next) {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401)
  const boardId = c.req.param('boardId') as string
  const [row] = await db
    .select({ id: schema.board.id })
    .from(schema.board)
    .where(eq(schema.board.id, boardId))
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  await next()
}

agent.use('*', requireBoard)

agent.get('/threads', async (c) => {
  return c.json({ threads: await listThreads(c.req.param('boardId') as string) })
})

agent.post('/threads', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = createAgentThreadRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  }
  const thread = await createThread(
    c.req.param('boardId') as string,
    c.get('user')!.id,
    parsed.data.title,
  )
  return c.json({ thread })
})

agent.get('/threads/:threadId', async (c) => {
  const thread = await getThread(c.req.param('boardId') as string, c.req.param('threadId'))
  if (!thread) return c.json({ error: 'Not found' }, 404)
  return c.json({ thread, messages: await listMessages(thread.id) })
})

agent.delete('/threads/:threadId', async (c) => {
  const threadId = c.req.param('threadId')
  if (runningThreads.has(threadId)) return c.json({ error: 'Thread is running' }, 409)
  const ok = await deleteThread(c.req.param('boardId') as string, threadId)
  if (!ok) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

// Sends a message and streams the agent's reply as SSE (AgentStreamEvent
// JSON per event). Closing the request stops the run.
agent.post('/threads/:threadId/messages', agentRateLimit, async (c) => {
  const boardId = c.req.param('boardId') as string
  const user = c.get('user')!
  const thread = await getThread(boardId, c.req.param('threadId') as string)
  if (!thread) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json().catch(() => null)
  const parsed = postAgentMessageRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  }
  if (runningThreads.has(thread.id)) {
    return c.json({ error: 'The agent is already working in this thread' }, 409)
  }
  runningThreads.add(thread.id)

  return streamSSE(c, async (stream) => {
    const controller = new AbortController()
    stream.onAbort(() => controller.abort())
    // Writes are chained so events reach the client in emit order.
    let writes = Promise.resolve()
    const emit = (event: AgentStreamEvent) => {
      writes = writes
        .then(() => stream.writeSSE({ data: JSON.stringify(event) }))
        .catch(() => undefined)
    }
    try {
      const prior = await listMessages(thread.id)
      const userMessage = await appendMessage(thread.id, 'user', [
        { type: 'text', text: parsed.data.text },
      ])
      emit({ type: 'message', message: userMessage })
      if (prior.length === 0 && thread.title === DEFAULT_THREAD_TITLE) {
        const titled = await setThreadTitle(boardId, thread.id, deriveThreadTitle(parsed.data.text))
        if (titled) emit({ type: 'thread', thread: titled })
      }
      await runOrchestrator({
        history: [...prior, userMessage],
        client: modelClient,
        tools: boardToolset({ boardId, userId: user.id }),
        store: {
          append: (role, content, isError) => appendMessage(thread.id, role, content, isError),
        },
        emit,
        signal: controller.signal,
      })
    } catch (e) {
      console.error('agent run failed', e)
      const notice = await appendMessage(
        thread.id,
        'assistant',
        [{ type: 'text', text: 'Something went wrong on our side. Try again.' }],
        true,
      ).catch(() => null)
      if (notice) emit({ type: 'message', message: notice })
    } finally {
      runningThreads.delete(thread.id)
      emit({ type: 'done' })
      await writes
    }
  })
})
