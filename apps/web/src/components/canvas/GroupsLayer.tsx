import type { AgentId, CanvasObject, SynthesisBrief } from '@moodboard/shared'
import { AnimatePresence } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { groupBoundingBox, groupId, proximityGroups } from '@/lib/aabb'
import { analyzeGroup, synthesizeGroupApi } from '@/lib/analyzeApi'
import { AIAnalysisPanel, type SlotState } from './AIAnalysisPanel'
import { ColorPaletteWidget } from './ColorPaletteWidget'
import { GroupOutline } from './GroupOutline'

const IDLE_SLOT: SlotState = { kind: 'idle' }

// ---------------------------------------------------------------------------
// Persistence — per-board localStorage so the displayed analysis survives
// agent-row toggles, board navigation, and full reloads.
// ---------------------------------------------------------------------------

type PersistedGroup = {
  // Last completed run for this group. The display is decoupled from the
  // current agent-row selection — only a fresh run replaces it.
  display: SlotState
  // The sorted agent IDs that produced `display`. Drives the play-vs-refresh
  // icon: refresh when current selection matches, play when it differs.
  lastRunSelection: AgentId[]
  // What's currently in the agent row.
  currentSelection: AgentId[]
  // Palette hexes pushed to the ColorPaletteWidget (locks every slot).
  aiPalette: string[]
}
type PersistedBoard = Record<string, PersistedGroup>

const STORAGE_PREFIX = 'moodboard:analysis:'

function storageKey(boardId: string): string {
  return `${STORAGE_PREFIX}${boardId}`
}

function loadBoardState(boardId: string): PersistedBoard {
  try {
    const raw = localStorage.getItem(storageKey(boardId))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as PersistedBoard) : {}
  } catch {
    return {}
  }
}

function saveBoardState(boardId: string, state: PersistedBoard) {
  try {
    localStorage.setItem(storageKey(boardId), JSON.stringify(state))
  } catch {
    // Quota exceeded / storage disabled — best-effort, silent.
  }
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export function GroupsLayer({
  objects,
  scale,
  offset,
  boardId,
}: {
  objects: CanvasObject[]
  scale: number
  offset: { x: number; y: number }
  boardId?: string
}) {
  const groups = useMemo(() => {
    // No explicit threshold — picks up the canonical GROUP_PROXIMITY_PX
    // default from aabb.ts. Single source of truth for the rule.
    const idGroups = proximityGroups(objects)
    const byId = new Map(objects.map((o) => [o.id, o]))
    return idGroups.map((ids) => {
      const items = ids.map((id) => byId.get(id)!).filter(Boolean)
      return {
        key: groupId(ids),
        ids,
        items,
        bounds: groupBoundingBox(items, 20),
      }
    })
  }, [objects])

  // The single displayed analysis per group. Only changes when a run
  // completes (or starts — transitions to loading). Toggling agents in the
  // row does NOT change this.
  const [displayByGroup, setDisplayByGroup] = useState<Record<string, SlotState>>({})
  // The sorted agent IDs that produced the currently-displayed slot. Drives
  // the play button: matches current selection → "refresh", differs → "play".
  const [lastRunSelectionByGroup, setLastRunSelectionByGroup] = useState<Record<string, AgentId[]>>(
    {},
  )
  // Current agent-row state. Independent of `displayByGroup`.
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, AgentId[]>>({})
  // Palette hexes captured from the latest AD or synthesis run. The
  // ColorPaletteWidget consumes this — when set, it overrides image
  // extraction and locks every slot.
  const [aiPaletteByGroup, setAiPaletteByGroup] = useState<Record<string, string[]>>({})

  const visibleKeysRef = useRef<Set<string>>(new Set())
  // Per-group request queue so multiple rapid clicks serialise.
  const queueByGroup = useRef<Map<string, Promise<void>>>(new Map())
  // Tracks which boardId we've already hydrated for, so a re-render with
  // the same boardId doesn't trample fresh in-memory state with the (now
  // stale) localStorage snapshot.
  const hydratedForBoardRef = useRef<string | null>(null)
  // Once we've ever seen objects on the canvas, the purge effect is
  // allowed to drop keys that no longer have a corresponding group.
  // Without this, the first render after mount runs with objects=[] (the
  // board API hasn't responded yet) and the purge wipes everything
  // hydrate just loaded. Then objects arrive, but the state is already
  // gone — that was the "log out / log in lost my work" bug.
  const objectsArrivedRef = useRef(false)
  // Snapshot of every key that has any state. The purge-and-transfer
  // effect reads this to find candidate source keys whose membership
  // overlaps a new group (e.g. adding/removing an image changes the
  // group's key but most members are the same — transfer instead of
  // dropping).
  const allActiveKeysRef = useRef<Set<string>>(new Set())

  // Hydrate from localStorage when boardId changes. Loading kinds are
  // dropped — they're transient and shouldn't survive a reload.
  useEffect(() => {
    if (!boardId) return
    if (hydratedForBoardRef.current === boardId) return
    hydratedForBoardRef.current = boardId

    const persisted = loadBoardState(boardId)
    const nextDisplay: Record<string, SlotState> = {}
    const nextLastRun: Record<string, AgentId[]> = {}
    const nextSelected: Record<string, AgentId[]> = {}
    const nextPalette: Record<string, string[]> = {}
    for (const [key, group] of Object.entries(persisted)) {
      if (group.display && group.display.kind !== 'loading') {
        nextDisplay[key] = group.display
      }
      if (Array.isArray(group.lastRunSelection)) {
        nextLastRun[key] = group.lastRunSelection
      }
      if (Array.isArray(group.currentSelection)) {
        nextSelected[key] = group.currentSelection
      }
      if (Array.isArray(group.aiPalette) && group.aiPalette.length > 0) {
        nextPalette[key] = group.aiPalette
      }
    }
    setDisplayByGroup(nextDisplay)
    setLastRunSelectionByGroup(nextLastRun)
    setSelectedByGroup(nextSelected)
    setAiPaletteByGroup(nextPalette)
  }, [boardId])

  // Save to localStorage on every persisted-field change. Synchronous, no
  // debounce — none of these fields change at high frequency (selection
  // toggles, run start/end, palette push) so the cost is microseconds per
  // write. The earlier debounced version cancelled its pending save in
  // the cleanup, which meant navigating away before the 200ms elapsed
  // dropped the most recent state on the floor.
  //
  // Skipped until hydration completes for this boardId so we don't
  // overwrite the stored state with an empty initial in-memory state on
  // first mount.
  useEffect(() => {
    if (!boardId) return
    if (hydratedForBoardRef.current !== boardId) return
    const state: PersistedBoard = {}
    const allKeys = new Set<string>([
      ...Object.keys(displayByGroup),
      ...Object.keys(lastRunSelectionByGroup),
      ...Object.keys(selectedByGroup),
      ...Object.keys(aiPaletteByGroup),
    ])
    for (const key of allKeys) {
      const display = displayByGroup[key] ?? IDLE_SLOT
      // Don't persist the loading state — it would deadlock the panel
      // if the user closes the tab mid-run.
      if (display.kind === 'loading') continue
      state[key] = {
        display,
        lastRunSelection: lastRunSelectionByGroup[key] ?? [],
        currentSelection: selectedByGroup[key] ?? [],
        aiPalette: aiPaletteByGroup[key] ?? [],
      }
    }
    saveBoardState(boardId, state)
  }, [boardId, displayByGroup, lastRunSelectionByGroup, selectedByGroup, aiPaletteByGroup])

  // Once we've seen objects on the canvas, the purge effect is allowed
  // to run. See objectsArrivedRef comment above for why.
  useEffect(() => {
    if (objects.length > 0) objectsArrivedRef.current = true
  }, [objects])

  // Track every key that currently has state in any of the per-group
  // stores. The purge-and-transfer effect reads from this ref so it can
  // look up old keys that have been orphaned by a group-membership change.
  useEffect(() => {
    allActiveKeysRef.current = new Set<string>([
      ...Object.keys(displayByGroup),
      ...Object.keys(lastRunSelectionByGroup),
      ...Object.keys(selectedByGroup),
      ...Object.keys(aiPaletteByGroup),
    ])
  }, [displayByGroup, lastRunSelectionByGroup, selectedByGroup, aiPaletteByGroup])

  // Purge state for groups that no longer exist on the canvas, AND
  // transfer state forward when a group's members change (added image,
  // removed image, merge, split). The group key is a sorted join of
  // object IDs (groupId in lib/aabb.ts), so we can decode any old key
  // back to its member set with split('|') and find the best-overlap
  // match for each new key that's lost its source.
  useEffect(() => {
    if (!objectsArrivedRef.current) return
    const nextKeys = new Set(groups.map((g) => g.key))
    visibleKeysRef.current = nextKeys

    // For each new group key without state, find the orphaned old key
    // with the highest member overlap. Ties resolve to whichever was
    // discovered first — good enough; the alternative (largest old
    // group, most-recent-touched) doesn't have a clearly-better
    // semantic in practice.
    const transfers = new Map<string, string>()
    for (const g of groups) {
      if (allActiveKeysRef.current.has(g.key)) continue
      const gSet = new Set(g.ids)
      let bestKey: string | undefined
      let bestOverlap = 0
      for (const oldKey of allActiveKeysRef.current) {
        if (nextKeys.has(oldKey)) continue // still a current group, can't be a source
        const oldMembers = oldKey.split('|')
        let overlap = 0
        for (const id of oldMembers) {
          if (gSet.has(id)) overlap++
        }
        if (overlap > bestOverlap) {
          bestOverlap = overlap
          bestKey = oldKey
        }
      }
      if (bestKey && bestOverlap > 0) transfers.set(g.key, bestKey)
    }

    const purgeAndTransfer = <T,>(prev: Record<string, T>): Record<string, T> => {
      const next: Record<string, T> = {}
      for (const key of nextKeys) {
        if (prev[key] !== undefined) {
          next[key] = prev[key]
        } else {
          const srcKey = transfers.get(key)
          if (srcKey && prev[srcKey] !== undefined) {
            next[key] = prev[srcKey]
          }
        }
      }
      return next
    }
    setDisplayByGroup(purgeAndTransfer)
    setLastRunSelectionByGroup(purgeAndTransfer)
    setSelectedByGroup(purgeAndTransfer)
    setAiPaletteByGroup(purgeAndTransfer)
  }, [groups])

  const enqueue = (key: string, exec: () => Promise<void>) => {
    const prev = queueByGroup.current.get(key) ?? Promise.resolve()
    const next = prev.then(exec, exec)
    queueByGroup.current.set(key, next)
    return next
  }

  const runAgent = useCallback(
    (key: string, ids: string[], agentId: AgentId, force = false) => {
      if (!boardId) return
      // Transition to loading immediately so the panel reflects activity.
      // Record the selection-that-produced-this so the play button matches.
      setDisplayByGroup((s) => ({ ...s, [key]: { kind: 'loading' } }))
      setLastRunSelectionByGroup((s) => ({ ...s, [key]: [agentId] }))

      return enqueue(key, async () => {
        try {
          const res = await analyzeGroup(boardId, ids, agentId, { force })
          if (!visibleKeysRef.current.has(key)) return
          setDisplayByGroup((s) => ({
            ...s,
            [key]:
              res.agentId === 'art-director'
                ? { kind: 'ready-ad', data: res.data, cached: res.cached }
                : { kind: 'ready-sec', data: res.data, cached: res.cached },
          }))
          if (res.agentId === 'art-director' && res.data.palette.length > 0) {
            const palette = res.data.palette
            setAiPaletteByGroup((p) => ({ ...p, [key]: palette }))
          }
        } catch (e) {
          if (!visibleKeysRef.current.has(key)) return
          setDisplayByGroup((s) => ({
            ...s,
            [key]: {
              kind: 'error',
              message: e instanceof Error ? e.message : String(e),
            },
          }))
        }
      })
    },
    [boardId],
  )

  const runCombined = useCallback(
    (key: string, ids: string[], agentIds: AgentId[], force = false) => {
      if (!boardId) return
      const sortedIds = [...agentIds].sort()
      setDisplayByGroup((s) => ({ ...s, [key]: { kind: 'loading' } }))
      setLastRunSelectionByGroup((s) => ({ ...s, [key]: sortedIds }))

      return enqueue(key, async () => {
        try {
          const res = await synthesizeGroupApi(boardId, ids, sortedIds, { force })
          if (!visibleKeysRef.current.has(key)) return
          setDisplayByGroup((s) => ({
            ...s,
            [key]: { kind: 'ready-brief', data: res.data, cached: res.cached },
          }))
          if (res.data.palette.length > 0) {
            const hexes = res.data.palette.map((p) => p.hex)
            setAiPaletteByGroup((p) => ({ ...p, [key]: hexes }))
          }
        } catch (e) {
          if (!visibleKeysRef.current.has(key)) return
          setDisplayByGroup((s) => ({
            ...s,
            [key]: {
              kind: 'error',
              message: e instanceof Error ? e.message : String(e),
            },
          }))
        }
      })
    },
    [boardId],
  )

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none' }}>
      <AnimatePresence>
        {groups.map((g) => (
          <GroupOutline key={g.key} bounds={g.bounds} scale={scale} offset={offset} />
        ))}
      </AnimatePresence>

      {groups.map((g) => (
        <ColorPaletteWidget
          key={`palette-${g.key}`}
          groupKey={g.key}
          objects={g.items}
          bounds={g.bounds}
          scale={scale}
          offset={offset}
          aiPalette={aiPaletteByGroup[g.key]}
        />
      ))}

      {groups.map((g) => {
        const displaySlot = displayByGroup[g.key] ?? IDLE_SLOT
        const selectedAgentIds = selectedByGroup[g.key] ?? []
        const lastRunSelection = lastRunSelectionByGroup[g.key] ?? []

        // Images the user could pin as the logo — same group, image or
        // PDF objects with a URL. Passed to LogoBlock so the user can
        // override the AD's choice without re-running.
        const groupImageOptions: { url: string }[] = []
        for (const o of g.items) {
          if (o.type === 'image') {
            const url = (o.data as { url?: string }).url
            if (typeof url === 'string') groupImageOptions.push({ url })
          } else if (o.type === 'pdf') {
            const thumb = (o.data as { thumbnailUrl?: string }).thumbnailUrl
            if (typeof thumb === 'string') groupImageOptions.push({ url: thumb })
          }
        }

        // Patches the brief's logo URL in place. Persists via the existing
        // Patch the entire brief in place. Used by inline edits in the
        // BriefReadout — the user double-clicks a text field, types,
        // and the edit propagates up through the prop chain. The save
        // effect persists; on reload the edited brief is what comes
        // back. Re-running the AD/synth overwrites.
        const handlePatchBrief = (newBrief: SynthesisBrief) => {
          setDisplayByGroup((prev) => {
            const slot = prev[g.key]
            if (!slot || slot.kind !== 'ready-brief') return prev
            return {
              ...prev,
              [g.key]: { ...slot, data: newBrief },
            }
          })
        }

        // localStorage save effect. Only applies when the displayed slot
        // is a ready-brief (synthesis output). Preserves the AD's
        // `reason` for URLs that were already in the logo set; new URLs
        // (user-added overrides) get an empty reason.
        const handleChangeLogos = (newUrls: string[]) => {
          setDisplayByGroup((prev) => {
            const slot = prev[g.key]
            if (!slot || slot.kind !== 'ready-brief') return prev
            const reasonByUrl = new Map(slot.data.logo.map((l) => [l.url, l.reason]))
            const nextLogo = newUrls.map((url) => ({
              url,
              reason: reasonByUrl.get(url) ?? '',
            }))
            return {
              ...prev,
              [g.key]: {
                ...slot,
                data: { ...slot.data, logo: nextLogo },
              },
            }
          })
        }

        // Does the current row match the agents that produced the displayed
        // result? Empty selection never matches (clicking play would do
        // nothing anyway, the button is disabled).
        const currentSorted = [...selectedAgentIds].sort().join(',')
        const lastSorted = [...lastRunSelection].sort().join(',')
        const selectionMatchesDisplay = selectedAgentIds.length > 0 && currentSorted === lastSorted

        const handleRun = () => {
          if (selectedAgentIds.length === 0) return
          // Force a fresh call only if the user is re-running the same
          // combo that's currently displayed — that's the explicit
          // "refresh" intent. Different combo = new analysis, cache is fine.
          const isReady =
            displaySlot.kind === 'ready-ad' ||
            displaySlot.kind === 'ready-sec' ||
            displaySlot.kind === 'ready-brief'
          const force = selectionMatchesDisplay && isReady
          if (selectedAgentIds.length === 1) {
            runAgent(g.key, g.ids, selectedAgentIds[0]!, force)
          } else {
            runCombined(g.key, g.ids, selectedAgentIds, force)
          }
        }

        return (
          <AIAnalysisPanel
            key={`panel-${g.key}`}
            bounds={g.bounds}
            scale={scale}
            offset={offset}
            displaySlot={displaySlot}
            selectedAgentIds={selectedAgentIds}
            selectionMatchesDisplay={selectionMatchesDisplay}
            logoOverrideOptions={groupImageOptions}
            onChangeLogos={handleChangeLogos}
            onPatchBrief={handlePatchBrief}
            onAddAgent={(id) =>
              setSelectedByGroup((prev) => {
                const current = prev[g.key] ?? []
                if (current.includes(id)) return prev
                return { ...prev, [g.key]: [...current, id] }
              })
            }
            onRemoveAgent={(id) =>
              setSelectedByGroup((prev) => {
                const current = prev[g.key] ?? []
                return { ...prev, [g.key]: current.filter((x) => x !== id) }
              })
            }
            onRun={handleRun}
          />
        )
      })}
    </div>
  )
}
