import type { CanvasObject, GroupState, PutGroupStateRequest } from '@moodboard/shared'
import { groupId } from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, schema } from '../db'

// Writer/reader for board_group_display — the team-shared analysis-panel
// state per group. Upsert key: (boardId, groupKey).

export type DisplayKind = 'ad' | 'sectioned' | 'video' | 'brief'

// The palette the widget locks to after a run: the AD's hexes, or the
// brief's palette swatches. Other agents don't produce one.
export function paletteFromDisplay(kind: DisplayKind, data: unknown): string[] | null {
  if (!data || typeof data !== 'object') return null
  const palette = (data as { palette?: unknown }).palette
  if (!Array.isArray(palette)) return null
  if (kind === 'ad') return palette.filter((p): p is string => typeof p === 'string')
  if (kind === 'brief') {
    return palette
      .map((p) => (p && typeof p === 'object' ? (p as { hex?: unknown }).hex : null))
      .filter((h): h is string => typeof h === 'string')
  }
  return null
}

// Called by analyze/synthesize on completion, so the result lands for the
// whole team even if the requesting tab has closed.
export async function recordGroupDisplay(args: {
  boardId: string
  objects: CanvasObject[]
  agentIds: string[]
  kind: DisplayKind
  data: unknown
}): Promise<void> {
  const palette = paletteFromDisplay(args.kind, args.data)
  const set = {
    kind: args.kind,
    data: args.data as object,
    agentIds: args.agentIds,
    ...(palette && palette.length > 0 ? { aiPalette: palette } : {}),
    updatedAt: new Date(),
  }
  await db
    .insert(schema.boardGroupDisplay)
    .values({
      id: nanoid(),
      boardId: args.boardId,
      groupKey: groupId(args.objects.map((o) => o.id)),
      selectedAgentIds: args.agentIds,
      ...set,
    })
    .onConflictDoUpdate({
      target: [schema.boardGroupDisplay.boardId, schema.boardGroupDisplay.groupKey],
      set,
    })
}

export async function putGroupState(
  boardId: string,
  groupKey: string,
  req: PutGroupStateRequest,
): Promise<void> {
  const set = {
    ...(req.display ? { kind: req.display.kind, data: req.display.data as object } : {}),
    ...(req.agentIds ? { agentIds: req.agentIds } : {}),
    ...(req.selectedAgentIds ? { selectedAgentIds: req.selectedAgentIds } : {}),
    ...(req.aiPalette ? { aiPalette: req.aiPalette } : {}),
    updatedAt: new Date(),
  }
  await db
    .insert(schema.boardGroupDisplay)
    .values({ id: nanoid(), boardId, groupKey, ...set })
    .onConflictDoUpdate({
      target: [schema.boardGroupDisplay.boardId, schema.boardGroupDisplay.groupKey],
      set,
    })
}

export async function listGroupStates(boardId: string): Promise<GroupState[]> {
  const rows = await db
    .select()
    .from(schema.boardGroupDisplay)
    .where(eq(schema.boardGroupDisplay.boardId, boardId))
  return rows.map((r) => ({
    groupKey: r.groupKey,
    display:
      r.kind && r.data !== null ? { kind: r.kind as DisplayKind, data: r.data as unknown } : null,
    agentIds: r.agentIds as GroupState['agentIds'],
    selectedAgentIds: r.selectedAgentIds as GroupState['selectedAgentIds'],
    aiPalette: r.aiPalette,
    updatedAt: r.updatedAt.toISOString(),
  }))
}
