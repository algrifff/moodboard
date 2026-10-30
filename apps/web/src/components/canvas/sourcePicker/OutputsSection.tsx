import {
  OUTPUT_FORMAT_LABELS,
  outputRenderPath,
  type CanvasObject,
  type OutputSummary,
} from '@moodboard/shared'
import { ArrowSquareOut } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { OutputFrame } from '@/components/outputs/OutputFrame'
import { pushServerObjects } from '@/lib/boardSync'
import { listOutputs, placeOutput } from '@/lib/outputsApi'
import { useSourcePickerStore } from '@/store/sourcePicker'
import { showToast } from '../Toast'
import { EmptyHint, Section } from './tiles'

const SHOWN = 6

// Design outputs, newest first, matched by the drawer's search box. Click
// one to drop it on the board as a live card.
export function OutputsSection({ boardId, query }: { boardId: string; query: string }) {
  const [outputs, setOutputs] = useState<OutputSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addingId, setAddingId] = useState<string | null>(null)
  const closePicker = useSourcePickerStore((s) => s.closePicker)

  useEffect(() => {
    listOutputs()
      .then(setOutputs)
      .catch((e: Error) => setError(e.message))
  }, [])

  const shown = useMemo(() => {
    if (!outputs) return null
    const q = query.trim().toLowerCase()
    const matches = q
      ? outputs.filter((o) =>
          [o.name, o.clientName, o.templateName].some((s) => s?.toLowerCase().includes(q)),
        )
      : outputs
    return matches.slice(0, SHOWN)
  }, [outputs, query])

  const add = async (output: OutputSummary) => {
    if (addingId) return
    setAddingId(output.id)
    try {
      const change = await placeOutput(output.id, boardId)
      pushServerObjects(boardId, [
        { object: change.object as CanvasObject, version: change.version },
      ])
      showToast(`Added ${output.name}`)
      closePicker()
    } catch (e) {
      showToast(`Couldn’t add it: ${e instanceof Error ? e.message : 'unknown error'}`)
    } finally {
      setAddingId(null)
    }
  }

  return (
    <Section
      title={
        <div className="flex w-full items-center">
          <span className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--text-mute)] font-semibold">
            Outputs
          </span>
          <a
            href="/outputs"
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--text-mute)] hover:text-foreground transition-colors"
          >
            Open
            <ArrowSquareOut size={11} />
          </a>
        </div>
      }
    >
      {error ? (
        <div className="px-2 py-2 text-[12px] text-destructive">{error}</div>
      ) : shown === null ? null : shown.length === 0 ? (
        <EmptyHint text={query ? 'No outputs match.' : 'No outputs yet.'} />
      ) : (
        <ul className="grid grid-cols-2 gap-1.5 px-1 pt-1">
          {shown.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                disabled={addingId === o.id}
                onClick={() => void add(o)}
                aria-label={`Add ${o.name} to the board`}
                title={`${o.name} — ${OUTPUT_FORMAT_LABELS[o.format]}`}
                className="block w-full overflow-hidden bg-[var(--bg-elevated)] text-left transition-opacity hover:opacity-90 disabled:opacity-40"
                style={{ borderRadius: 'var(--radius)' }}
              >
                <OutputFrame
                  src={outputRenderPath(o.id, { version: o.latestVersion })}
                  viewport={o.viewport}
                  title={o.name}
                  className="aspect-[16/10] w-full"
                  shadow={false}
                />
                <span className="block truncate px-2 py-1.5 text-[11.5px] text-foreground">
                  {o.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
