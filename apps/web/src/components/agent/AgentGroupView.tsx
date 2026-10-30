import type { AgentId } from '@moodboard/shared'
import { ArrowLeft, Crosshair } from '@phosphor-icons/react'
import { useMemo } from 'react'
import { AgentRow, type PlayState } from '@/components/canvas/AgentRow'
import { ArtDirectorReadout } from '@/components/canvas/readouts/ArtDirectorReadout'
import { BriefReadout } from '@/components/canvas/readouts/BriefReadout'
import { SectionedReadout } from '@/components/canvas/readouts/SectionedReadout'
import { VideoEditorReadout } from '@/components/canvas/readouts/VideoEditorReadout'
import { focusObjects } from '@/lib/canvasCamera'
import { useAgentSidebarStore } from '@/store/agentSidebar'
import { useCanvasStore } from '@/store/canvas'
import { useGroupPanelStore, type SlotState } from '@/store/groupPanels'
import { SaveKitPanel } from './SaveKitPanel'

const IDLE: SlotState = { kind: 'idle' }

// A group's full readout in the sidebar, with the agent row to run
// specialists by hand. Edits to a brief persist through the group-panel
// store (GroupsLayer saves it for the team).
export function AgentGroupView({
  boardId,
  groupKey,
  clientId,
}: {
  boardId: string
  groupKey: string
  clientId: string | null
}) {
  const showChat = useAgentSidebarStore((s) => s.showChat)
  const objects = useCanvasStore((s) => s.objects)
  const slot = useGroupPanelStore((s) => s.display[groupKey]) ?? IDLE
  const selected = useGroupPanelStore((s) => s.selected[groupKey]) ?? []
  const lastRun = useGroupPanelStore((s) => s.lastRun[groupKey]) ?? []
  const ids = useMemo(() => groupKey.split('|'), [groupKey])
  const items = useMemo(() => {
    const idSet = new Set(ids)
    return objects.filter((o) => idSet.has(o.id))
  }, [objects, ids])
  const onCanvas = items.length === ids.length

  // Images in the group the user could pin as the logo instead of the AD's
  // pick.
  const logoOptions = useMemo(
    () =>
      items.flatMap((o) => {
        const d = o.data as { url?: string; thumbnailUrl?: string }
        if (o.type === 'image' && typeof d.url === 'string') return [{ url: d.url }]
        if (o.type === 'pdf' && typeof d.thumbnailUrl === 'string') return [{ url: d.thumbnailUrl }]
        return []
      }),
    [items],
  )

  const sortedKey = (list: AgentId[]) => [...list].sort().join(',')
  const matchesDisplay = selected.length > 0 && sortedKey(selected) === sortedKey(lastRun)
  const ready =
    slot.kind === 'ready-ad' ||
    slot.kind === 'ready-sec' ||
    slot.kind === 'ready-video' ||
    slot.kind === 'ready-brief'
  const playState: PlayState =
    slot.kind === 'loading'
      ? 'loading'
      : slot.kind === 'error' && matchesDisplay
        ? 'error'
        : ready && matchesDisplay
          ? 'ready'
          : 'idle'

  const panels = useGroupPanelStore.getState
  const setSelected = (next: (current: AgentId[]) => AgentId[]) =>
    panels().setSelected((prev) => ({ ...prev, [groupKey]: next(prev[groupKey] ?? []) }))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border-soft)] px-3 py-2">
        <button
          type="button"
          onClick={showChat}
          className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-mute)] hover:text-foreground transition-colors"
        >
          <ArrowLeft size={13} />
          Thread
        </button>
        <div className="flex-1" />
        <span className="text-[12px] text-[var(--text-mute)]">
          Group · {ids.length} item{ids.length === 1 ? '' : 's'}
        </span>
        {onCanvas && (
          <button
            type="button"
            onClick={() => focusObjects(ids)}
            className="inline-flex items-center gap-1 text-[12px] text-[var(--text-mute)] hover:text-foreground transition-colors"
            title="Jump to on canvas"
          >
            <Crosshair size={13} weight="bold" />
          </button>
        )}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3"
        style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text)' }}
      >
        {!onCanvas ? (
          <p className="pt-4 text-[12.5px] text-[var(--text-mute)]">
            This group has changed or dissolved since. Open its new glance on the canvas, or ask the
            agent to regroup the items.
          </p>
        ) : (
          <>
            <AgentRow
              selectedIds={selected}
              playState={playState}
              onAddAgent={(id) => setSelected((c) => (c.includes(id) ? c : [...c, id]))}
              onRemoveAgent={(id) => setSelected((c) => c.filter((x) => x !== id))}
              onRun={() =>
                // Re-running the combo already shown is the explicit refresh.
                panels().runAgents(boardId, groupKey, ids, selected, matchesDisplay && ready)
              }
            />
            <div className="mt-4">
              {slot.kind === 'ready-brief' && (
                <div className="mb-4">
                  <SaveKitPanel brief={slot.data} items={items} clientId={clientId} />
                </div>
              )}
              {slot.kind === 'ready-brief' && (
                <BriefReadout
                  data={slot.data}
                  logoOverrideOptions={logoOptions}
                  onPatchBrief={(brief) => panels().patchBrief(groupKey, () => brief)}
                  onChangeLogos={(urls) =>
                    panels().patchBrief(groupKey, (brief) => {
                      const reasons = new Map(brief.logo.map((l) => [l.url, l.reason]))
                      return {
                        ...brief,
                        logo: urls.map((url) => ({ url, reason: reasons.get(url) ?? '' })),
                      }
                    })
                  }
                />
              )}
              {slot.kind === 'ready-ad' && <ArtDirectorReadout data={slot.data} />}
              {slot.kind === 'ready-sec' && <SectionedReadout data={slot.data} />}
              {slot.kind === 'ready-video' && <VideoEditorReadout data={slot.data} />}
              {slot.kind === 'loading' && (
                <div className="text-shimmer text-[12.5px]">Reading the group…</div>
              )}
              {slot.kind === 'error' && (
                <div className="text-[12.5px] text-destructive break-words">{slot.message}</div>
              )}
              {slot.kind === 'idle' && (
                <p className="text-[12.5px] text-[var(--text-mute)]">
                  Pick specialists above and hit play, or ask the agent in the thread.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
