import { z } from 'zod'
import { groupStateSchema, storedCanvasObjectSchema } from './schemas'

// Phase 21 — agent sidebar. Messages are stored in Anthropic content-block
// form (the subset we write), so a thread's history replays straight into
// the Messages API.

export const agentTextBlockSchema = z.object({ type: z.literal('text'), text: z.string() })
export const agentToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
})
// `content` is always a string: JSON (see agentToolPayloadSchema) on
// success, a plain message on error.
export const agentToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.string(),
  is_error: z.boolean().optional(),
})
export const agentContentBlockSchema = z.discriminatedUnion('type', [
  agentTextBlockSchema,
  agentToolUseBlockSchema,
  agentToolResultBlockSchema,
])
export type AgentTextBlock = z.infer<typeof agentTextBlockSchema>
export type AgentToolUseBlock = z.infer<typeof agentToolUseBlockSchema>
export type AgentToolResultBlock = z.infer<typeof agentToolResultBlockSchema>
export type AgentContentBlock = z.infer<typeof agentContentBlockSchema>

// What every successful canvas tool returns (JSON in the tool_result). The
// model reads all of it; the sidebar renders `summary` as the card title,
// jumps to `objectIds`, and shows a glance of `display`.
export const agentToolPayloadSchema = z
  .object({
    summary: z.string(),
    objectIds: z.array(z.string()).optional(),
    groupKey: z.string().optional(),
    display: z
      .object({ kind: z.enum(['ad', 'sectioned', 'video', 'brief']), data: z.unknown() })
      .optional(),
  })
  .passthrough()
export type AgentToolPayload = z.infer<typeof agentToolPayloadSchema>

export const agentRoleSchema = z.enum(['user', 'assistant'])

// `isError` marks a notice the server wrote on the assistant's behalf (model
// unavailable, step limit hit, stopped). Shown in the thread, never replayed
// to the model.
export const agentMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: agentRoleSchema,
  content: z.array(agentContentBlockSchema),
  isError: z.boolean(),
  createdAt: z.string(),
})
export type AgentMessage = z.infer<typeof agentMessageSchema>

export const agentThreadSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  title: z.string(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type AgentThread = z.infer<typeof agentThreadSchema>

export const agentThreadsResponseSchema = z.object({ threads: z.array(agentThreadSchema) })
export const agentThreadResponseSchema = z.object({
  thread: agentThreadSchema,
  messages: z.array(agentMessageSchema),
})
export type AgentThreadResponse = z.infer<typeof agentThreadResponseSchema>

export const createAgentThreadRequestSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
})
export type CreateAgentThreadRequest = z.infer<typeof createAgentThreadRequestSchema>

export const AGENT_MESSAGE_MAX_CHARS = 8000
export const postAgentMessageRequestSchema = z.object({
  text: z.string().trim().min(1).max(AGENT_MESSAGE_MAX_CHARS),
})
export type PostAgentMessageRequest = z.infer<typeof postAgentMessageRequestSchema>

export const boardObjectChangeSchema = z.object({
  object: storedCanvasObjectSchema,
  version: z.number().int(),
})

// SSE events on POST …/threads/:id/messages. `message` carries every
// persisted message in order (the user's, each assistant turn, each batch
// of tool results). `text` streams the in-progress assistant turn; it is
// superseded by that turn's `message`. `board` / `groups` carry what the
// tools changed so the open canvas can fold them in without a reload.
export const agentStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: agentMessageSchema }),
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({ type: z.literal('thread'), thread: agentThreadSchema }),
  z.object({
    type: z.literal('board'),
    objects: z.array(boardObjectChangeSchema),
    removed: z.array(z.string()),
  }),
  z.object({ type: z.literal('groups'), groups: z.array(groupStateSchema) }),
  z.object({ type: z.literal('done') }),
])
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>

// First line of the opening message, cut at a word boundary.
export function deriveThreadTitle(text: string, max = 60): string {
  const line = text.trim().split('\n')[0]!.trim().replace(/\s+/g, ' ')
  if (line.length <= max) return line || 'New thread'
  const cut = line.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:–-]+$/, '')}…`
}
