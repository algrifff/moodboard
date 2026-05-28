import type { AgentId, CanvasObject } from '@moodboard/shared'
import { AnimatePresence } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { groupBoundingBox, groupId, proximityGroups } from '@/lib/aabb'
import { analyzeGroup, synthesizeGroupApi } from '@/lib/analyzeApi'
import { AIAnalysisPanel, type SlotState } from './AIAnalysisPanel'
import { ColorPaletteWidget } from './ColorPaletteWidget'
import { GroupOutline } from './GroupOutline'

type GroupSlots = Partial<Record<AgentId, SlotState>>

const EMPTY_SLOTS: Record<AgentId, SlotState> = {
  'art-director': { kind: 'idle' },
  'business-analyst': { kind: 'idle' },
  'audience-profiler': { kind: 'idle' },
  'channel-strategist': { kind: 'idle' },
  copywriter: { kind: 'idle' },
}

const IDLE_SLOT: SlotState = { kind: 'idle' }

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
    const idGroups = proximityGroups(objects, 24)
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

  // Per-(groupKey × agentId) slots for single agents.
  const [slotsByGroup, setSlotsByGroup] = useState<Record<string, GroupSlots>>({})
  // Combined slots keyed by groupKey → sortedIds.join(',') → SlotState.
  const [combinedByGroup, setCombinedByGroup] = useState<Record<string, Record<string, SlotState>>>(
    {},
  )
  // Which agents are in each group's avatar row right now.
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, AgentId[]>>({})
  // Palette hexes captured from the latest AD or synthesis run for each
  // group. ColorPaletteWidget consumes this — when set, it overrides the
  // image-extracted swatches and locks every slot.
  const [aiPaletteByGroup, setAiPaletteByGroup] = useState<Record<string, string[]>>({})
  const visibleKeysRef = useRef<Set<string>>(new Set())
  // Per-group request queue so multiple rapid clicks serialise.
  const queueByGroup = useRef<Map<string, Promise<void>>>(new Map())

  // Purge state for groups that no longer exist.
  useEffect(() => {
    const nextKeys = new Set(groups.map((g) => g.key))
    visibleKeysRef.current = nextKeys
    const purge = <T,>(prev: Record<string, T>): Record<string, T> => {
      const next: Record<string, T> = {}
      for (const key of nextKeys) {
        if (prev[key] !== undefined) next[key] = prev[key]
      }
      return next
    }
    setSlotsByGroup(purge)
    setCombinedByGroup(purge)
    setSelectedByGroup(purge)
    setAiPaletteByGroup(purge)
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
      setSlotsByGroup((s) => ({
        ...s,
        [key]: { ...(s[key] ?? {}), [agentId]: { kind: 'loading' } },
      }))

      return enqueue(key, async () => {
        try {
          const res = await analyzeGroup(boardId, ids, agentId, { force })
          if (!visibleKeysRef.current.has(key)) return
          setSlotsByGroup((s) => ({
            ...s,
            [key]: {
              ...(s[key] ?? {}),
              [agentId]:
                res.agentId === 'art-director'
                  ? { kind: 'ready-ad', data: res.data, cached: res.cached }
                  : { kind: 'ready-sec', data: res.data, cached: res.cached },
            },
          }))
          // Push the Art Director's curated palette into the colour widget
          // — locked. Synthesis runs (below) do the same with the brief's
          // palette and will overwrite this when they land.
          if (res.agentId === 'art-director' && res.data.palette.length > 0) {
            const palette = res.data.palette
            setAiPaletteByGroup((p) => ({ ...p, [key]: palette }))
          }
        } catch (e) {
          if (!visibleKeysRef.current.has(key)) return
          setSlotsByGroup((s) => ({
            ...s,
            [key]: {
              ...(s[key] ?? {}),
              [agentId]: {
                kind: 'error',
                message: e instanceof Error ? e.message : String(e),
              },
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
      const slotKey = sortedIds.join(',')

      setCombinedByGroup((c) => ({
        ...c,
        [key]: { ...(c[key] ?? {}), [slotKey]: { kind: 'loading' } },
      }))

      return enqueue(key, async () => {
        try {
          const res = await synthesizeGroupApi(boardId, ids, sortedIds, { force })
          if (!visibleKeysRef.current.has(key)) return
          setCombinedByGroup((c) => ({
            ...c,
            [key]: {
              ...(c[key] ?? {}),
              [slotKey]: { kind: 'ready-brief', data: res.data, cached: res.cached },
            },
          }))
          // Same as the AD path — push the brief's palette into the colour
          // widget. Synthesis takes precedence when both have run because
          // it lands later in the user's flow.
          if (res.data.palette.length > 0) {
            const hexes = res.data.palette.map((p) => p.hex)
            setAiPaletteByGroup((p) => ({ ...p, [key]: hexes }))
          }
        } catch (e) {
          if (!visibleKeysRef.current.has(key)) return
          setCombinedByGroup((c) => ({
            ...c,
            [key]: {
              ...(c[key] ?? {}),
              [slotKey]: {
                kind: 'error',
                message: e instanceof Error ? e.message : String(e),
              },
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
        const slots = { ...EMPTY_SLOTS, ...(slotsByGroup[g.key] ?? {}) }
        const selectedAgentIds = selectedByGroup[g.key] ?? []
        const combinedKey = [...selectedAgentIds].sort().join(',')
        const combinedSlot: SlotState =
          (selectedAgentIds.length >= 2 && combinedByGroup[g.key]?.[combinedKey]) || IDLE_SLOT

        const handleRun = () => {
          if (selectedAgentIds.length === 0) return
          if (selectedAgentIds.length === 1) {
            const only = selectedAgentIds[0]!
            const existing = slotsByGroup[g.key]?.[only]?.kind
            const force = existing === 'ready-ad' || existing === 'ready-sec'
            runAgent(g.key, g.ids, only, force)
          } else {
            const existing = combinedByGroup[g.key]?.[combinedKey]?.kind
            const force = existing === 'ready-brief'
            runCombined(g.key, g.ids, selectedAgentIds, force)
          }
        }

        return (
          <AIAnalysisPanel
            key={`panel-${g.key}`}
            bounds={g.bounds}
            scale={scale}
            offset={offset}
            slots={slots}
            combinedSlot={combinedSlot}
            selectedAgentIds={selectedAgentIds}
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
