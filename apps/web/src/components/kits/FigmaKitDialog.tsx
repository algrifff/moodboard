import {
  parseFigmaUrl,
  type Client,
  type FigmaKitResponse,
  type KitSummary,
} from '@moodboard/shared'
import { X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FigmaLogo } from '@/components/canvas/sourceLogos'
import { ClientSelect } from '@/components/clients/ClientSelect'
import { ghostButton, inputClass, labelClass, primaryButton } from '@/components/ui'
import { figmaKit } from '@/lib/figmaApi'
import { ApiError } from '@/lib/http'
import { useFigmaStore } from '@/store/figma'

// "Style kit from a Figma file": read the file's colour and text styles (and
// variables, where the plan allows), show what maps to kit tokens and what was
// left behind, then land it as a new kit or a new version of this one. The
// first read saves nothing.
type Props =
  | {
      mode: 'new'
      clients: Client[]
      defaultClientId: string | null
      onClose: () => void
      onSaved: (kit: KitSummary) => void
    }
  | {
      mode: 'version'
      kit: KitSummary
      onClose: () => void
      onSaved: (kit: KitSummary) => void
    }

export function FigmaKitDialog(props: Props) {
  const status = useFigmaStore((s) => s.status)
  const load = useFigmaStore((s) => s.load)
  const connect = useFigmaStore((s) => s.connect)
  const connecting = useFigmaStore((s) => s.connecting)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [clientId, setClientId] = useState<string | null>(
    props.mode === 'new' ? props.defaultClientId : null,
  )
  const [result, setResult] = useState<FigmaKitResponse | null>(null)
  const [busy, setBusy] = useState<'read' | 'save' | null>(null)
  const [error, setError] = useState<{ message: string; reconnect: boolean } | null>(null)
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose

  useEffect(() => {
    void load()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [load])

  const ref = parseFigmaUrl(url)
  const request = {
    url: url.trim(),
    ...(props.mode === 'version' ? { kitId: props.kit.id } : { clientId: clientId ?? undefined }),
    ...(props.mode === 'new' && name.trim() ? { name: name.trim() } : {}),
  }

  const fail = (e: unknown) => {
    const api = e instanceof ApiError ? e : null
    setError({
      message: e instanceof Error ? e.message : String(e),
      reconnect: api?.code === 'reconnect' || api?.code === 'not-connected',
    })
  }

  const read = async () => {
    setBusy('read')
    setError(null)
    try {
      const preview = await figmaKit({ ...request, preview: true })
      setResult(preview)
      if (props.mode === 'new' && !name.trim()) setName(preview.fileName.slice(0, 80))
    } catch (e) {
      setResult(null)
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setBusy('save')
    setError(null)
    try {
      const saved = await figmaKit({
        ...request,
        preview: false,
        ...(props.mode === 'version' ? { baseVersion: props.kit.latestVersion } : {}),
      })
      if (saved.kit) props.onSaved(saved.kit)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const connected = status?.connection != null
  const canRead = ref !== null && ref.kind !== 'make' && connected && busy === null
  const canSave =
    result !== null &&
    busy === null &&
    (props.mode === 'version' || (clientId !== null && name.trim().length > 0))

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto px-4 py-10"
      style={{ backgroundColor: 'var(--scrim)' }}
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Style kit from a Figma file"
        className="w-full max-w-xl bg-card p-5"
        style={{ borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-modal)' }}
      >
        <div className="flex items-center gap-2">
          <FigmaLogo size={16} />
          <h2 className="flex-1 text-base font-semibold text-foreground">
            {props.mode === 'version'
              ? `Update “${props.kit.name}” from Figma`
              : 'Style kit from a Figma file'}
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            className="text-[var(--text-mute)] hover:text-foreground"
          >
            <X size={14} weight="bold" />
          </button>
        </div>
        <p className="mt-1 text-sm text-[var(--text-soft)]">
          Reads the file’s colour and text styles{' '}
          <span className="text-[var(--text-mute)]">(and variables, on plans that have them)</span>{' '}
          and maps them to palette roles and display, body and mono fonts.
          {props.mode === 'version'
            ? ' The new version keeps this kit’s logos, voice and imagery rules.'
            : ''}{' '}
          Read-only — nothing is written to Figma.
        </p>

        {status && !status.configured && (
          <p className="mt-4 text-sm text-destructive">
            Figma isn’t set up on this server (see the README for the FIGMA_* variables).
          </p>
        )}
        {status?.configured && !connected && (
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              className={primaryButton}
              disabled={connecting}
              onClick={() => void connect()}
            >
              {connecting ? 'Waiting for Figma…' : 'Connect Figma'}
            </button>
            <span className="text-sm text-[var(--text-mute)]">to read a file.</span>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-3">
          <label>
            <span className={`${labelClass} mb-1 block`}>Figma file link</span>
            <input
              autoFocus
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                setResult(null)
              }}
              placeholder="https://www.figma.com/design/…"
              className={inputClass}
            />
          </label>
          {url.trim() && !ref && (
            <p className="text-sm text-destructive">That isn’t a Figma file link.</p>
          )}
          {ref?.kind === 'make' && (
            <p className="text-sm text-destructive">Figma Make files can’t be read for styles.</p>
          )}
          {props.mode === 'new' && (
            <div className="flex flex-wrap gap-3">
              <label className="min-w-[180px] flex-1">
                <span className={`${labelClass} mb-1 block`}>Kit name</span>
                <input
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="From the file’s name"
                  className={inputClass}
                />
              </label>
              <div className="w-48">
                <span className={`${labelClass} mb-1 block`}>Client</span>
                <ClientSelect
                  clients={props.clients}
                  value={clientId}
                  allowNone={false}
                  onChange={setClientId}
                  label="Client for the new kit"
                  className="w-full"
                />
              </div>
            </div>
          )}
          <div>
            <button
              type="button"
              className={ghostButton}
              disabled={!canRead}
              onClick={() => void read()}
            >
              {busy === 'read' ? 'Reading the file…' : result ? 'Read again' : 'Read the file'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-3 text-sm text-destructive">
            {error.message}
            {error.reconnect && (
              <button
                type="button"
                className={`${ghostButton} ml-2`}
                onClick={() => void connect()}
              >
                Reconnect Figma
              </button>
            )}
          </div>
        )}

        {result && <Mapping result={result} />}

        {result && (
          <div className="mt-5 flex items-center justify-end gap-2">
            <button type="button" className={ghostButton} onClick={props.onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={!canSave}
              onClick={() => void save()}
            >
              {busy === 'save'
                ? 'Saving…'
                : props.mode === 'version'
                  ? `Save as v${props.kit.latestVersion + 1}`
                  : 'Create kit'}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function Mapping({ result }: { result: FigmaKitResponse }) {
  const colours = result.report.mapped.filter((m) => m.kind === 'colour')
  const fonts = result.report.mapped.filter((m) => m.kind === 'font')
  return (
    <div className="mt-5 flex flex-col gap-4" data-testid="figma-kit-mapping">
      <div>
        <h3 className={`${labelClass} mb-2`}>Mapped from “{result.fileName}”</h3>
        {colours.length === 0 && fonts.length === 0 && (
          <p className="text-sm text-[var(--text-mute)]">
            Nothing in this file maps to kit tokens (no colour or text styles found).
          </p>
        )}
        {colours.length > 0 && (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {colours.map((c) => (
              <li key={c.label + c.detail} className="flex min-w-0 items-center gap-2 text-sm">
                <span
                  className="h-4 w-4 shrink-0"
                  style={{
                    backgroundColor: c.swatch,
                    borderRadius: 999,
                    boxShadow: 'var(--shadow-small), var(--swatch-inset)',
                  }}
                />
                <span className="min-w-0 flex-1 truncate text-foreground">{c.label}</span>
                <span className="shrink-0 font-mono text-xs text-[var(--text-mute)]">
                  {c.swatch}
                </span>
              </li>
            ))}
          </ul>
        )}
        {fonts.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1">
            {fonts.map((f) => (
              <li key={f.label} className="flex items-baseline gap-2 text-sm">
                <span className="w-28 shrink-0 text-[var(--text-mute)]">{f.label}</span>
                <span className="text-foreground">{f.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {result.report.skipped.length > 0 && (
        <div>
          <h3 className={`${labelClass} mb-2`}>Left behind</h3>
          <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto">
            {result.report.skipped.map((s, i) => (
              <li key={`${s.label}-${i}`} className="text-sm">
                <span className="text-foreground">{s.label}</span>
                <span className="text-[var(--text-mute)]"> — {s.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
