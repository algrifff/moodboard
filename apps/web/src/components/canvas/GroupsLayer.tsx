import type { CanvasObject, PutGroupStateRequest } from '@moodboard/shared'
import { AnimatePresence } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import { groupBoundingBox, groupId, proximityGroups } from '@moodboard/shared'
import { listGroupStates, persistedBody, putGroupState } from '@/lib/groupStateApi'
import { useAgentSidebarStore } from '@/store/agentSidebar'
import { useCanvasStore } from '@/store/canvas'
import { groupPanelSync, useGroupPanelStore, type SlotState } from '@/store/groupPanels'
import { AIAnalysisPanel } from './AIAnalysisPanel'
import { ColorPaletteWidget } from './ColorPaletteWidget'
import { GroupOutline } from './GroupOutline'

const IDLE_SLOT: SlotState = { kind: 'idle' }
const GROUP_STATE_SAVE_DEBOUNCE_MS = 400
const BRIEF_REQUEST = 'Give me a brief for this group.'

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

  const displayByGroup = useGroupPanelStore((s) => s.display)
  const lastRunByGroup = useGroupPanelStore((s) => s.lastRun)
  const selectedByGroup = useGroupPanelStore((s) => s.selected)
  const aiPaletteByGroup = useGroupPanelStore((s) => s.aiPalette)
  const sidebarGroupKey = useAgentSidebarStore((s) =>
    s.open && s.view.kind === 'group' ? s.view.groupKey : null,
  )

  // Set once the server state for this boardId has been merged in. Saving
  // waits for it so an empty first render can't overwrite the team's state.
  const [hydratedFor, setHydratedFor] = useState<string | null>(null)
  // Once we've ever seen objects on the canvas, the purge effect is
  // allowed to drop keys that no longer have a corresponding group.
  // Without this, the first render after mount runs with objects=[] (the
  // board API hasn't responded yet) and the purge wipes everything
  // hydrate just loaded. Then objects arrive, but the state is already
  // gone — that was the "log out / log in lost my work" bug.
  const objectsArrivedRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Hydrate from the server when boardId changes. Local state wins for any
  // key the user already touched before the fetch resolved.
  useEffect(() => {
    if (!boardId) return
    let cancelled = false
    setHydratedFor(null)
    useGroupPanelStore.getState().reset()
    listGroupStates(boardId)
      .then((states) => {
        if (cancelled) return
        useGroupPanelStore.getState().applyServerGroups(states, { keepLocal: true })
        setHydratedFor(boardId)
      })
      .catch((e) => console.error('loading group state failed', e))
    return () => {
      cancelled = true
      useGroupPanelStore.getState().reset()
    }
  }, [boardId])

  // Persist changed groups, debounced. Only completed reads are stored —
  // a loading/error slot sends no display, leaving the last good one.
  useEffect(() => {
    if (!boardId || hydratedFor !== boardId) return
    const pending = new Map<string, PutGroupStateRequest>()
    const keys = new Set<string>([
      ...Object.keys(displayByGroup),
      ...Object.keys(lastRunByGroup),
      ...Object.keys(selectedByGroup),
      ...Object.keys(aiPaletteByGroup),
    ])
    for (const key of keys) {
      const body = persistedBody(
        displayByGroup[key],
        lastRunByGroup[key] ?? [],
        selectedByGroup[key] ?? [],
        aiPaletteByGroup[key] ?? [],
      )
      if (groupPanelSync.lastSent.get(key) !== JSON.stringify(body)) pending.set(key, body)
    }
    if (pending.size === 0) return
    const flush = (keepalive: boolean) => {
      for (const [key, body] of pending) {
        groupPanelSync.lastSent.set(key, JSON.stringify(body))
        putGroupState(boardId, key, body, { keepalive }).catch((e) => {
          groupPanelSync.lastSent.delete(key)
          console.error('saving group state failed', e)
        })
      }
      pending.clear()
    }
    const timer = setTimeout(() => flush(false), GROUP_STATE_SAVE_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      // Unmount (navigation) — send now rather than drop the edit. On a
      // re-render the next effect run recomputes and re-schedules instead.
      if (pending.size > 0 && !mountedRef.current) flush(true)
    }
  }, [boardId, hydratedFor, displayByGroup, lastRunByGroup, selectedByGroup, aiPaletteByGroup])

  useEffect(() => {
    if (objects.length > 0) objectsArrivedRef.current = true
  }, [objects])

  // Purge state for groups that no longer exist on the canvas, AND
  // transfer state forward when a group's members change (added image,
  // removed image, merge, split). The group key is a sorted join of
  // object IDs (groupId in lib/aabb.ts), so we can decode any old key
  // back to its member set with split('|') and find the best-overlap
  // match for each new key that's lost its source.
  useEffect(() => {
    if (!objectsArrivedRef.current) return
    const nextKeys = new Set(groups.map((g) => g.key))
    groupPanelSync.visibleKeys = nextKeys

    const store = useGroupPanelStore.getState()
    const activeKeys = new Set<string>([
      ...Object.keys(store.display),
      ...Object.keys(store.lastRun),
      ...Object.keys(store.selected),
      ...Object.keys(store.aiPalette),
    ])

    // For each new group key without state, find the orphaned old key
    // with the highest member overlap. Ties resolve to whichever was
    // discovered first.
    const transfers = new Map<string, string>()
    for (const g of groups) {
      if (activeKeys.has(g.key)) continue
      const gSet = new Set(g.ids)
      let bestKey: string | undefined
      let bestOverlap = 0
      for (const oldKey of activeKeys) {
        if (nextKeys.has(oldKey)) continue // still a current group, can't be a source
        let overlap = 0
        for (const id of oldKey.split('|')) if (gSet.has(id)) overlap++
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
          if (srcKey && prev[srcKey] !== undefined) next[key] = prev[srcKey]
        }
      }
      return next
    }
    store.setDisplay(purgeAndTransfer)
    store.setLastRun(purgeAndTransfer)
    store.setSelected(purgeAndTransfer)
    store.setAiPalette(purgeAndTransfer)

    // Keep the sidebar readout on the same group as it changes shape.
    const { view, openGroup } = useAgentSidebarStore.getState()
    if (view.kind === 'group' && !nextKeys.has(view.groupKey)) {
      const moved = [...transfers].find(([, src]) => src === view.groupKey)?.[0]
      if (moved) openGroup(moved)
    }
  }, [groups])

  const askForBrief = (ids: string[]) => {
    if (!boardId) return
    useCanvasStore.getState().setSelection(ids)
    void useAgentSidebarStore.getState().send(boardId, BRIEF_REQUEST, ids)
  }

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

      {groups.map((g) => (
        <AIAnalysisPanel
          key={`panel-${g.key}`}
          bounds={g.bounds}
          scale={scale}
          offset={offset}
          slot={displayByGroup[g.key] ?? IDLE_SLOT}
          active={sidebarGroupKey === g.key}
          onOpen={() => useAgentSidebarStore.getState().openGroup(g.key)}
          onAsk={() => askForBrief(g.ids)}
        />
      ))}
    </div>
  )
}
