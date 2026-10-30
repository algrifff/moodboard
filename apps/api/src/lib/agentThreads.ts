import type { AgentContentBlock, AgentMessage, AgentThread } from '@moodboard/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, schema } from '../db'

// Persistence for sidebar threads. Every message — the user's, each
// assistant turn (incl. tool_use blocks) and each batch of tool results —
// is a row, so a thread resumes exactly where it stopped.

export const DEFAULT_THREAD_TITLE = 'New thread'

const threadColumns = {
  id: schema.agentThread.id,
  boardId: schema.agentThread.boardId,
  title: schema.agentThread.title,
  createdByName: schema.user.name,
  createdAt: schema.agentThread.createdAt,
  updatedAt: schema.agentThread.updatedAt,
}

type ThreadRow = {
  id: string
  boardId: string
  title: string
  createdByName: string | null
  createdAt: Date
  updatedAt: Date
}

function toThread(r: ThreadRow): AgentThread {
  return {
    ...r,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function listThreads(boardId: string): Promise<AgentThread[]> {
  const rows = await db
    .select(threadColumns)
    .from(schema.agentThread)
    .leftJoin(schema.user, eq(schema.user.id, schema.agentThread.createdBy))
    .where(eq(schema.agentThread.boardId, boardId))
    .orderBy(desc(schema.agentThread.updatedAt))
    .limit(100)
  return rows.map(toThread)
}

export async function getThread(boardId: string, threadId: string): Promise<AgentThread | null> {
  const [row] = await db
    .select(threadColumns)
    .from(schema.agentThread)
    .leftJoin(schema.user, eq(schema.user.id, schema.agentThread.createdBy))
    .where(and(eq(schema.agentThread.id, threadId), eq(schema.agentThread.boardId, boardId)))
    .limit(1)
  return row ? toThread(row) : null
}

export async function createThread(
  boardId: string,
  userId: string,
  title = DEFAULT_THREAD_TITLE,
): Promise<AgentThread> {
  const id = nanoid()
  await db.insert(schema.agentThread).values({ id, boardId, title, createdBy: userId })
  return (await getThread(boardId, id))!
}

export async function setThreadTitle(boardId: string, threadId: string, title: string) {
  await db
    .update(schema.agentThread)
    .set({ title })
    .where(and(eq(schema.agentThread.id, threadId), eq(schema.agentThread.boardId, boardId)))
  return getThread(boardId, threadId)
}

export async function deleteThread(boardId: string, threadId: string): Promise<boolean> {
  const rows = await db
    .delete(schema.agentThread)
    .where(and(eq(schema.agentThread.id, threadId), eq(schema.agentThread.boardId, boardId)))
    .returning({ id: schema.agentThread.id })
  return rows.length > 0
}

export async function listMessages(threadId: string): Promise<AgentMessage[]> {
  const rows = await db
    .select()
    .from(schema.agentMessage)
    .where(eq(schema.agentMessage.threadId, threadId))
    .orderBy(asc(schema.agentMessage.seq))
  return rows.map((r) => ({
    id: r.id,
    threadId: r.threadId,
    role: r.role as AgentMessage['role'],
    content: r.content as AgentContentBlock[],
    isError: r.isError,
    createdAt: r.createdAt.toISOString(),
  }))
}

export async function appendMessage(
  threadId: string,
  role: AgentMessage['role'],
  content: AgentContentBlock[],
  isError = false,
): Promise<AgentMessage> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.agentMessage)
      .values({ id: nanoid(), threadId, role, content, isError })
      .returning()
    await tx
      .update(schema.agentThread)
      .set({ updatedAt: new Date() })
      .where(eq(schema.agentThread.id, threadId))
    return {
      id: row!.id,
      threadId,
      role,
      content,
      isError,
      createdAt: row!.createdAt.toISOString(),
    }
  })
}
