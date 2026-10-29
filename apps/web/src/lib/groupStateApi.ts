import {
  groupStatesResponseSchema,
  type AgentId,
  type AIAnalysis,
  type GroupState,
  type PutGroupStateRequest,
  type SectionedParagraphs,
  type SharedAnalysisDisplay,
  type SynthesisBrief,
  type VideoEditorBreakdown,
} from '@moodboard/shared'
import type { SlotState } from '@/store/groupPanels'

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json()
}

export async function listGroupStates(boardId: string): Promise<GroupState[]> {
  const res = await fetch(`/api/boards/${boardId}/groups`, { credentials: 'include' })
  return groupStatesResponseSchema.parse(await jsonOrThrow(res)).groups
}

export async function putGroupState(
  boardId: string,
  groupKey: string,
  body: PutGroupStateRequest,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  const res = await fetch(`/api/boards/${boardId}/groups/${encodeURIComponent(groupKey)}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: options.keepalive ?? false,
  })
  await jsonOrThrow(res)
}

// Stored display data is loosely typed on read (older agent versions);
// the panel renders it the same way it rendered the old localStorage copy.
export function slotFromDisplay(display: GroupState['display']): SlotState | null {
  if (!display) return null
  switch (display.kind) {
    case 'ad':
      return { kind: 'ready-ad', data: display.data as AIAnalysis, cached: true }
    case 'sectioned':
      return { kind: 'ready-sec', data: display.data as SectionedParagraphs, cached: true }
    case 'video':
      return { kind: 'ready-video', data: display.data as VideoEditorBreakdown, cached: true }
    case 'brief':
      return { kind: 'ready-brief', data: display.data as SynthesisBrief, cached: true }
  }
}

// idle / loading / error aren't persisted — only a completed read is.
export function displayFromSlot(slot: SlotState | undefined): SharedAnalysisDisplay | null {
  switch (slot?.kind) {
    case 'ready-ad':
      return { kind: 'ad', data: slot.data }
    case 'ready-sec':
      return { kind: 'sectioned', data: slot.data }
    case 'ready-video':
      return { kind: 'video', data: slot.data }
    case 'ready-brief':
      return { kind: 'brief', data: slot.data }
    default:
      return null
  }
}

// The PUT body for a group's panel state. A display is only sent with the
// agents that produced it.
export function persistedBody(
  slot: SlotState | undefined,
  agentIds: AgentId[],
  selectedAgentIds: AgentId[],
  aiPalette: string[],
): PutGroupStateRequest {
  const display = displayFromSlot(slot)
  return {
    ...(display ? { display, agentIds } : {}),
    selectedAgentIds,
    aiPalette,
  }
}
