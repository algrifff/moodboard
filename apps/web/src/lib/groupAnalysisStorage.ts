import type { AgentId } from '@moodboard/shared'
import type { SlotState } from '@/components/canvas/AIAnalysisPanel'

// Per-board localStorage cache of the analysis-panel state. Lives
// outside `GroupsLayer` because Phase 18's ShareDialog also reads from
// it — when the user mints a share, we bake the latest displayed brief
// for every group into the snapshot blob, so the viewer can render the
// brief without re-running any agents.

export type PersistedGroup = {
  // Last completed run for this group. The display is decoupled from
  // the current agent-row selection — only a fresh run replaces it.
  display: SlotState
  // The sorted agent IDs that produced `display`. Drives the
  // play-vs-refresh icon: refresh when current selection matches, play
  // when it differs.
  lastRunSelection: AgentId[]
  // What's currently in the agent row.
  currentSelection: AgentId[]
  // Palette hexes pushed to the ColorPaletteWidget (locks every slot).
  aiPalette: string[]
}
export type PersistedBoard = Record<string, PersistedGroup>

export const STORAGE_PREFIX = 'moodboard:analysis:'

export function storageKey(boardId: string): string {
  return `${STORAGE_PREFIX}${boardId}`
}

export function loadBoardState(boardId: string): PersistedBoard {
  try {
    const raw = localStorage.getItem(storageKey(boardId))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as PersistedBoard) : {}
  } catch {
    return {}
  }
}

export function saveBoardState(boardId: string, state: PersistedBoard): void {
  try {
    localStorage.setItem(storageKey(boardId), JSON.stringify(state))
  } catch {
    // Quota exceeded / storage disabled — best-effort, silent.
  }
}
