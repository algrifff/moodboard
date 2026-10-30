import type {
  AgentId,
  AIAnalysis,
  GroupState,
  SectionedParagraphs,
  SynthesisBrief,
  VideoEditorBreakdown,
} from '@moodboard/shared'
import { create } from 'zustand'
import { analyzeGroup, synthesizeGroupApi } from '@/lib/analyzeApi'
import { persistedBody, slotFromDisplay } from '@/lib/groupStateApi'

// Per-group analysis-panel state for the open board, shared by the
// floating glance on the canvas (GroupsLayer) and the full readout in the
// agent sidebar. GroupsLayer owns hydration, persistence and the
// purge/transfer on membership change; anyone can read or patch.

export type SlotState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready-ad'; data: AIAnalysis; cached: boolean }
  | { kind: 'ready-sec'; data: SectionedParagraphs; cached: boolean }
  | { kind: 'ready-video'; data: VideoEditorBreakdown; cached: boolean }
  | { kind: 'ready-brief'; data: SynthesisBrief; cached: boolean }
  | { kind: 'error'; message: string }

type ByGroup<T> = Record<string, T>
type Update<T> = ByGroup<T> | ((prev: ByGroup<T>) => ByGroup<T>)

function resolve<T>(update: Update<T>, prev: ByGroup<T>): ByGroup<T> {
  return typeof update === 'function' ? update(prev) : update
}

type GroupPanelsState = {
  // The analysis each group shows. Only a run (or a server push) replaces
  // it; toggling agents in the row doesn't.
  display: ByGroup<SlotState>
  // The sorted agent ids that produced `display`.
  lastRun: ByGroup<AgentId[]>
  // The agent row selection.
  selected: ByGroup<AgentId[]>
  // Palette hexes from the latest AD or brief; locks the palette widget.
  aiPalette: ByGroup<string[]>

  setDisplay: (u: Update<SlotState>) => void
  setLastRun: (u: Update<AgentId[]>) => void
  setSelected: (u: Update<AgentId[]>) => void
  setAiPalette: (u: Update<string[]>) => void

  // Folds server rows in (hydrate, or the agent sidebar's tool results) and
  // records them as already persisted so they aren't PUT straight back.
  applyServerGroups: (groups: GroupState[], opts?: { keepLocal?: boolean }) => void
  runAgents: (
    boardId: string,
    key: string,
    ids: string[],
    agentIds: AgentId[],
    force?: boolean,
  ) => void
  patchBrief: (key: string, patch: (brief: SynthesisBrief) => SynthesisBrief) => void
  reset: () => void
}

// Not reactive: bookkeeping GroupsLayer and runAgents share.
export const groupPanelSync = {
  // Last body PUT per group key, so only groups that changed are re-sent.
  lastSent: new Map<string, string>(),
  // Groups currently on the canvas — a finished run for a group that has
  // since dissolved is dropped.
  visibleKeys: new Set<string>(),
  // Per-group request queue so rapid runs serialise.
  queue: new Map<string, Promise<void>>(),
}

export const useGroupPanelStore = create<GroupPanelsState>()((set, get) => ({
  display: {},
  lastRun: {},
  selected: {},
  aiPalette: {},

  setDisplay: (u) => set((s) => ({ display: resolve(u, s.display) })),
  setLastRun: (u) => set((s) => ({ lastRun: resolve(u, s.lastRun) })),
  setSelected: (u) => set((s) => ({ selected: resolve(u, s.selected) })),
  setAiPalette: (u) => set((s) => ({ aiPalette: resolve(u, s.aiPalette) })),

  applyServerGroups: (groups, { keepLocal = false } = {}) => {
    const display: ByGroup<SlotState> = {}
    const lastRun: ByGroup<AgentId[]> = {}
    const selected: ByGroup<AgentId[]> = {}
    const aiPalette: ByGroup<string[]> = {}
    for (const g of groups) {
      const slot = slotFromDisplay(g.display)
      if (slot) display[g.groupKey] = slot
      lastRun[g.groupKey] = g.agentIds
      selected[g.groupKey] = g.selectedAgentIds
      if (g.aiPalette.length > 0) aiPalette[g.groupKey] = g.aiPalette
      groupPanelSync.lastSent.set(
        g.groupKey,
        JSON.stringify(
          persistedBody(slot ?? undefined, g.agentIds, g.selectedAgentIds, g.aiPalette),
        ),
      )
    }
    // Hydrate keeps anything the user touched before the fetch resolved;
    // a live push from the agent wins.
    const merge = <T>(server: ByGroup<T>, local: ByGroup<T>) =>
      keepLocal ? { ...server, ...local } : { ...local, ...server }
    set((s) => ({
      display: merge(display, s.display),
      lastRun: merge(lastRun, s.lastRun),
      selected: merge(selected, s.selected),
      aiPalette: merge(aiPalette, s.aiPalette),
    }))
  },

  runAgents: (boardId, key, ids, agentIds, force = false) => {
    if (agentIds.length === 0) return
    const sorted = [...agentIds].sort()
    get().setDisplay((s) => ({ ...s, [key]: { kind: 'loading' } }))
    get().setLastRun((s) => ({ ...s, [key]: sorted }))

    const exec = async () => {
      try {
        let slot: SlotState
        let palette: string[] = []
        if (sorted.length === 1) {
          const res = await analyzeGroup(boardId, ids, sorted[0]!, { force })
          slot =
            res.agentId === 'art-director'
              ? { kind: 'ready-ad', data: res.data, cached: res.cached }
              : res.agentId === 'video-editor'
                ? { kind: 'ready-video', data: res.data, cached: res.cached }
                : { kind: 'ready-sec', data: res.data, cached: res.cached }
          if (res.agentId === 'art-director') palette = res.data.palette
        } else {
          const res = await synthesizeGroupApi(boardId, ids, sorted, { force })
          slot = { kind: 'ready-brief', data: res.data, cached: res.cached }
          palette = res.data.palette.map((p) => p.hex)
        }
        if (!groupPanelSync.visibleKeys.has(key)) return
        get().setDisplay((s) => ({ ...s, [key]: slot }))
        if (palette.length > 0) get().setAiPalette((p) => ({ ...p, [key]: palette }))
      } catch (e) {
        if (!groupPanelSync.visibleKeys.has(key)) return
        const message = e instanceof Error ? e.message : String(e)
        get().setDisplay((s) => ({ ...s, [key]: { kind: 'error', message } }))
      }
    }
    const prev = groupPanelSync.queue.get(key) ?? Promise.resolve()
    groupPanelSync.queue.set(key, prev.then(exec, exec))
  },

  patchBrief: (key, patch) =>
    get().setDisplay((prev) => {
      const slot = prev[key]
      if (!slot || slot.kind !== 'ready-brief') return prev
      return { ...prev, [key]: { ...slot, data: patch(slot.data) } }
    }),

  reset: () => {
    groupPanelSync.lastSent.clear()
    groupPanelSync.visibleKeys.clear()
    groupPanelSync.queue.clear()
    set({ display: {}, lastRun: {}, selected: {}, aiPalette: {} })
  },
}))
