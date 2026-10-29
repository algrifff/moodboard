import type { AgentId, CanvasObject, PutGroupStateRequest, SynthesisBrief } from '@moodboard/shared'
import { AnimatePresence } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { groupBoundingBox, groupId, proximityGroups } from '@moodboard/shared'
import { analyzeGroup, synthesizeGroupApi } from '@/lib/analyzeApi'
import {
  displayFromSlot,
  listGroupStates,
  putGroupState,
  slotFromDisplay,
} from '@/lib/groupStateApi'
import { AIAnalysisPanel, type SlotState } from './AIAnalysisPanel'
import { ColorPaletteWidget } from './ColorPaletteWidget'
import { GroupOutline } from './GroupOutline'

const IDLE_SLOT: SlotState = { kind: 'idle' }
const GROUP_STATE_SAVE_DEBOUNCE_MS = 400

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
  // Set once the server state for this boardId has been merged in. Saving
  // waits for it so an empty first render can't overwrite the team's state.
  const [hydratedFor, setHydratedFor] = useState<string | null>(null)
  // Last body PUT per group key, so only groups that actually changed are
  // re-sent.
  const lastSentRef = useRef<Map<string, string>>(new Map())
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
    lastSentRef.current = new Map()
    listGroupStates(boardId)
      .then((states) => {
        if (cancelled) return
        const display: Record<string, SlotState> = {}
        const lastRun: Record<string, AgentId[]> = {}
        const selected: Record<string, AgentId[]> = {}
        const palette: Record<string, string[]> = {}
        for (const g of states) {
          const slot = slotFromDisplay(g.display)
          if (slot) display[g.groupKey] = slot
          lastRun[g.groupKey] = g.agentIds
          selected[g.groupKey] = g.selectedAgentIds
          if (g.aiPalette.length > 0) palette[g.groupKey] = g.aiPalette
          lastSentRef.current.set(
            g.groupKey,
            JSON.stringify(
              persistedBody(slot ?? undefined, g.agentIds, g.selectedAgentIds, g.aiPalette),
            ),
          )
        }
        setDisplayByGroup((prev) => ({ ...display, ...prev }))
        setLastRunSelectionByGroup((prev) => ({ ...lastRun, ...prev }))
        setSelectedByGroup((prev) => ({ ...selected, ...prev }))
        setAiPaletteByGroup((prev) => ({ ...palette, ...prev }))
        setHydratedFor(boardId)
      })
      .catch((e) => console.error('loading group state failed', e))
    return () => {
      cancelled = true
    }
  }, [boardId])

  // Persist changed groups, debounced. Only completed reads are stored —
  // a loading/error slot sends no display, leaving the last good one.
  useEffect(() => {
    if (!boardId || hydratedFor !== boardId) return
    const pending = new Map<string, PutGroupStateRequest>()
    const keys = new Set<string>([
      ...Object.keys(displayByGroup),
      ...Object.keys(lastRunSelectionByGroup),
      ...Object.keys(selectedByGroup),
      ...Object.keys(aiPaletteByGroup),
    ])
    for (const key of keys) {
      const body = persistedBody(
        displayByGroup[key],
        lastRunSelectionByGroup[key] ?? [],
        selectedByGroup[key] ?? [],
        aiPaletteByGroup[key] ?? [],
      )
      if (lastSentRef.current.get(key) !== JSON.stringify(body)) pending.set(key, body)
    }
    if (pending.size === 0) return
    const flush = (keepalive: boolean) => {
      for (const [key, body] of pending) {
        lastSentRef.current.set(key, JSON.stringify(body))
        putGroupState(boardId, key, body, { keepalive }).catch((e) => {
          lastSentRef.current.delete(key)
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
  }, [
    boardId,
    hydratedFor,
    displayByGroup,
    lastRunSelectionByGroup,
    selectedByGroup,
    aiPaletteByGroup,
  ])

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
                : res.agentId === 'video-editor'
                  ? { kind: 'ready-video', data: res.data, cached: res.cached }
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

        // Patches the brief's logo set in place; the save effect persists
        // it. Only applies when the displayed slot is a ready-brief (synthesis output). Preserves the AD's
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

function persistedBody(
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
