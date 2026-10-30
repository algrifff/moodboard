import {
  FIGMA_IMPORT_MAX_FRAMES,
  parseFigmaUrl,
  type FigmaFileTree,
  type FigmaRef,
} from '@moodboard/shared'
import { CaretDown, CaretRight, CheckSquare, Square } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ghostButton, inputClass, primaryButton } from '@/components/ui'
import { connectFigma, importFigmaToBoard } from '@/lib/figmaPaste'
import { getFigmaFile } from '@/lib/figmaApi'
import { ApiError } from '@/lib/http'
import { useFigmaStore } from '@/store/figma'
import { useSourcePickerStore } from '@/store/sourcePicker'
import { FigmaLogo } from '../sourceLogos'
import { showToast } from '../Toast'
import { Section } from './tiles'

// Figma in the sources drawer: paste a file or frame link (or put one in the
// drawer's search box), browse a file's pages and top-level frames, tick the
// ones to bring in. Each becomes an image card on the board, rendered from
// Figma and saved to the asset library. Read-only.
export function FigmaSection({ boardId, query }: { boardId: string; query: string }) {
  const status = useFigmaStore((s) => s.status)
  const statusError = useFigmaStore((s) => s.statusError)
  const load = useFigmaStore((s) => s.load)
  const connecting = useFigmaStore((s) => s.connecting)
  const connectError = useFigmaStore((s) => s.connectError)
  const figmaUrl = useSourcePickerStore((s) => s.figmaUrl)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Section
      title={
        <span className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.12em] text-[var(--text-mute)] font-semibold">
          <FigmaLogo size={11} />
          Figma
        </span>
      }
    >
      <div className="px-1 pt-1">
        {statusError ? (
          <Note tone="error">{statusError}</Note>
        ) : !status ? (
          <Note>Checking Figma…</Note>
        ) : !status.configured ? (
          <div
            className="flex flex-col gap-1.5 px-3 py-3 text-[12.5px] leading-relaxed text-[var(--text-mute)]"
            style={{ borderRadius: 'var(--radius-lg)', boxShadow: '0 0 0 1px var(--border-soft)' }}
          >
            <span className="font-medium text-foreground">Figma isn’t set up on this server</span>
            <p>
              Create a Figma OAuth app and set <code className="font-mono">FIGMA_CLIENT_ID</code>,{' '}
              <code className="font-mono">FIGMA_CLIENT_SECRET</code> and{' '}
              <code className="font-mono">FIGMA_REDIRECT_URI</code> on the API, then reload. The
              README has the steps.
            </p>
          </div>
        ) : !status.connection ? (
          <div
            className="flex flex-col items-start gap-2.5 px-3 py-3"
            style={{ borderRadius: 'var(--radius-lg)', boxShadow: '0 0 0 1px var(--border-soft)' }}
          >
            <p className="text-[12.5px] leading-relaxed text-[var(--text-mute)]">
              Bring frames from a Figma file onto the board as images the agents can use as
              references. Read-only: nothing is ever written to Figma.
            </p>
            <button
              type="button"
              className={primaryButton}
              disabled={connecting}
              onClick={() => void connectFigma(boardId)}
            >
              {connecting ? 'Waiting for Figma…' : 'Connect Figma'}
            </button>
            {connectError && <p className="text-[12px] text-destructive">{connectError}</p>}
          </div>
        ) : (
          <Browser
            boardId={boardId}
            query={query}
            seed={figmaUrl}
            who={status.connection.handle ?? status.connection.accountEmail}
          />
        )}
      </div>
    </Section>
  )
}

function Note({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <p
      className={`px-1 py-3 text-[12.5px] leading-relaxed ${
        tone === 'error' ? 'text-destructive' : 'text-[var(--text-mute)]'
      }`}
    >
      {children}
    </p>
  )
}

function Browser({
  boardId,
  query,
  seed,
  who,
}: {
  boardId: string
  query: string
  seed: string
  who: string
}) {
  const closePicker = useSourcePickerStore((s) => s.closePicker)
  const [text, setText] = useState(seed)
  const [tree, setTree] = useState<FigmaFileTree | null>(null)
  const [error, setError] = useState<{ message: string; reconnect: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const seq = useRef(0)

  // A link pasted into the drawer's search box, or handed over by a paste on the canvas.
  useEffect(() => {
    if (seed) setText(seed)
  }, [seed])
  useEffect(() => {
    if (parseFigmaUrl(query)) setText(query.trim())
  }, [query])

  const ref: FigmaRef | null = useMemo(() => parseFigmaUrl(text), [text])
  const fileKey = ref?.fileKey ?? null
  const link = ref && ref.kind !== 'make' ? text.trim() : null

  useEffect(() => {
    const s = ++seq.current
    setTree(null)
    setError(null)
    setPicked(new Set())
    if (!link || !fileKey) return
    setLoading(true)
    getFigmaFile(link)
      .then((file) => {
        if (s !== seq.current) return
        setTree(file)
        setOpen(new Set(file.pages.slice(0, 1).map((p) => p.id)))
        // A frame link arrives with its frame ticked.
        if (ref?.nodeId) setPicked(new Set([ref.nodeId]))
      })
      .catch((e: unknown) => {
        if (s !== seq.current) return
        const api = e instanceof ApiError ? e : null
        setError({
          message: e instanceof Error ? e.message : String(e),
          reconnect: api?.code === 'reconnect' || api?.code === 'not-connected',
        })
      })
      .finally(() => s === seq.current && setLoading(false))
  }, [link, fileKey])

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else if (next.size < FIGMA_IMPORT_MAX_FRAMES) next.add(id)
      else showToast(`Up to ${FIGMA_IMPORT_MAX_FRAMES} frames at a time`)
      return next
    })

  const doImport = async () => {
    if (!link || picked.size === 0 || importing) return
    setImporting(true)
    showToast(`Rendering ${picked.size === 1 ? 'the frame' : `${picked.size} frames`} from Figma…`)
    try {
      await importFigmaToBoard(boardId, { url: link, nodeIds: [...picked] })
      closePicker()
    } catch (e) {
      showToast(`Figma import failed: ${e instanceof Error ? e.message : 'unknown error'}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        type="url"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste a Figma file or frame link…"
        aria-label="Figma link"
        className={inputClass}
      />
      <p className="px-0.5 text-[11px] text-[var(--text-faint)]">Connected as {who}</p>

      {text.trim() && !ref && <Note>That isn’t a Figma file or frame link.</Note>}
      {ref?.kind === 'make' && (
        <Note>Figma Make files can’t be imported — paste a Design or FigJam link.</Note>
      )}
      {loading && <Note>Reading the file…</Note>}
      {error && (
        <div className="flex flex-col items-start gap-1.5">
          <Note tone="error">{error.message}</Note>
          {error.reconnect && (
            <button
              type="button"
              className={ghostButton}
              onClick={() => void connectFigma(boardId)}
            >
              Reconnect Figma
            </button>
          )}
        </div>
      )}

      {tree && (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2 px-0.5">
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
              {tree.name}
            </span>
            <span className="shrink-0 text-[10.5px] text-[var(--text-faint)]">
              {tree.pages.reduce((n, p) => n + p.frames.length, 0)} frames
            </span>
          </div>
          <ul
            className="flex max-h-72 flex-col overflow-y-auto"
            style={{ borderRadius: 'var(--radius)', boxShadow: '0 0 0 1px var(--border-soft)' }}
          >
            {tree.pages.map((page) => {
              const expanded = open.has(page.id)
              return (
                <li key={page.id}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() =>
                      setOpen((prev) => {
                        const next = new Set(prev)
                        if (next.has(page.id)) next.delete(page.id)
                        else next.add(page.id)
                        return next
                      })
                    }
                    className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[12px] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-elevated)]"
                  >
                    {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
                    <span className="min-w-0 flex-1 truncate">{page.name}</span>
                    <span className="text-[10.5px] text-[var(--text-faint)]">
                      {page.frames.length}
                    </span>
                  </button>
                  {expanded && page.frames.length === 0 && (
                    <div className="px-7 pb-1.5 text-[11.5px] italic text-[var(--text-faint)]">
                      No frames on this page.
                    </div>
                  )}
                  {expanded &&
                    page.frames.map((f) => {
                      const on = picked.has(f.id)
                      return (
                        <button
                          key={f.id}
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          onClick={() => toggle(f.id)}
                          className="flex w-full items-center gap-2 py-1.5 pl-6 pr-2 text-left text-[12.5px] text-foreground transition-colors hover:bg-[var(--bg-elevated)]"
                        >
                          {on ? (
                            <CheckSquare
                              size={14}
                              weight="fill"
                              style={{ color: 'var(--accent)' }}
                            />
                          ) : (
                            <Square size={14} style={{ color: 'var(--text-faint)' }} />
                          )}
                          <span className="min-w-0 flex-1 truncate">{f.name}</span>
                          {f.width > 0 && (
                            <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--text-faint)]">
                              {f.width}×{f.height}
                            </span>
                          )}
                        </button>
                      )
                    })}
                </li>
              )
            })}
          </ul>
          <button
            type="button"
            className={`${primaryButton} mt-1 self-start`}
            disabled={picked.size === 0 || importing}
            onClick={() => void doImport()}
          >
            {importing
              ? 'Importing…'
              : picked.size === 0
                ? 'Pick frames to import'
                : `Import ${picked.size} frame${picked.size === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
    </div>
  )
}
