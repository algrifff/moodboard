import type { LinearIssueSummary, LinearView } from '@moodboard/shared'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { LinearLogo } from '@/components/canvas/sourceLogos'
import { ghostButton, primaryButton, relativeTime } from '@/components/ui'
import { ApiError } from '@/lib/http'
import { listLinearIssues } from '@/lib/linearApi'
import { useClients } from '@/store/clients'
import { useLinearStore } from '@/store/linear'

// Search / assigned / recent Linear issues, with the connect and
// not-configured states handled in place. Picking an issue is the manual
// trigger for a new agent thread (see startFromLinearIssue).

type Props = {
  onPick: (issue: LinearIssueSummary) => void
  // Controlled search text (the sources drawer's search box). Omit to show
  // the picker's own search field.
  query?: string
  disabled?: boolean
  autoFocus?: boolean
}

export function LinearIssuePicker({ onPick, query: controlled, disabled, autoFocus }: Props) {
  const status = useLinearStore((s) => s.status)
  const statusError = useLinearStore((s) => s.statusError)
  const load = useLinearStore((s) => s.load)

  useEffect(() => {
    void load()
  }, [load])

  if (statusError) return <Note tone="error">{statusError}</Note>
  if (!status) return <Note>Checking Linear…</Note>
  if (!status.configured) return <NotConfigured />
  if (!status.connection) return <ConnectPrompt />
  return (
    <IssueList
      onPick={onPick}
      controlled={controlled}
      disabled={disabled}
      autoFocus={autoFocus}
      who={status.connection.workspaceName ?? status.connection.accountEmail}
    />
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

function NotConfigured() {
  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-3 text-[12.5px] leading-relaxed text-[var(--text-mute)]"
      style={{ borderRadius: 'var(--radius-lg)', boxShadow: '0 0 0 1px var(--border-soft)' }}
    >
      <div className="flex items-center gap-2 text-foreground">
        <LinearLogo size={15} />
        <span className="font-medium">Linear isn’t set up on this server</span>
      </div>
      <p>
        Create a Linear OAuth app and set <code className="font-mono">LINEAR_CLIENT_ID</code>,{' '}
        <code className="font-mono">LINEAR_CLIENT_SECRET</code> and{' '}
        <code className="font-mono">LINEAR_REDIRECT_URI</code> on the API, then reload. The README
        has the steps.
      </p>
    </div>
  )
}

export function ConnectPrompt({ reconnect }: { reconnect?: boolean }) {
  const connect = useLinearStore((s) => s.connect)
  const connecting = useLinearStore((s) => s.connecting)
  const connectError = useLinearStore((s) => s.connectError)
  return (
    <div
      className="flex flex-col items-start gap-2.5 px-3 py-3"
      style={{ borderRadius: 'var(--radius-lg)', boxShadow: '0 0 0 1px var(--border-soft)' }}
    >
      <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
        <LinearLogo size={15} />
        {reconnect ? 'Reconnect Linear' : 'Connect Linear'}
      </div>
      <p className="text-[12.5px] leading-relaxed text-[var(--text-mute)]">
        {reconnect
          ? 'Your Linear connection has expired.'
          : 'Pick an issue and the agent starts a thread with it as the brief. Read-only.'}
      </p>
      <button
        type="button"
        className={primaryButton}
        disabled={connecting}
        onClick={() => void connect()}
      >
        {connecting ? 'Waiting for Linear…' : reconnect ? 'Reconnect' : 'Connect Linear'}
      </button>
      {connectError && <p className="text-[12px] text-destructive">{connectError}</p>}
    </div>
  )
}

function IssueList({
  onPick,
  controlled,
  disabled,
  autoFocus,
  who,
}: Props & { controlled: string | undefined; who: string }) {
  const { clients } = useClients()
  const [own, setOwn] = useState('')
  const [view, setView] = useState<LinearView>('assigned')
  const [issues, setIssues] = useState<LinearIssueSummary[] | null>(null)
  const [error, setError] = useState<{ message: string; reconnect: boolean } | null>(null)
  const [reload, setReload] = useState(0)
  const seq = useRef(0)

  const text = (controlled ?? own).trim()

  useEffect(() => {
    const s = ++seq.current
    setIssues(null)
    setError(null)
    const timer = setTimeout(
      () => {
        listLinearIssues({ q: text || undefined, view })
          .then((res) => {
            if (s === seq.current) setIssues(res)
          })
          .catch((e: unknown) => {
            if (s !== seq.current) return
            const api = e instanceof ApiError ? e : null
            setError({
              message: e instanceof Error ? e.message : String(e),
              reconnect: api?.code === 'reconnect' || api?.code === 'not-connected',
            })
          })
      },
      text ? 300 : 0,
    )
    return () => clearTimeout(timer)
  }, [text, view, reload])

  if (error?.reconnect) return <ConnectPrompt reconnect />

  return (
    <div className="flex flex-col gap-2">
      {controlled === undefined && (
        <div className="relative">
          <MagnifyingGlass
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
          />
          <input
            type="search"
            autoFocus={autoFocus}
            value={own}
            onChange={(e) => setOwn(e.target.value)}
            placeholder="Search issues, or paste LIN-123"
            aria-label="Search Linear issues"
            className="w-full bg-[var(--bg-elevated)] py-2 pl-8 pr-3 text-[13px] text-foreground outline-none placeholder:text-[var(--text-faint)]"
            style={{ borderRadius: 'var(--radius)' }}
          />
        </div>
      )}
      {!text && (
        <div className="flex items-center gap-1" role="group" aria-label="Issue list">
          {(
            [
              ['assigned', 'Assigned to me'],
              ['recent', 'Recently updated'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`px-2 py-1 text-[12px] transition-colors ${
                view === v
                  ? 'bg-[var(--accent-soft)] text-foreground'
                  : 'text-[var(--text-mute)] hover:text-foreground'
              }`}
              style={{ borderRadius: 'var(--radius)' }}
            >
              {label}
            </button>
          ))}
          <span className="ml-auto truncate text-[11px] text-[var(--text-faint)]">{who}</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-[12.5px] text-destructive">
          <span className="min-w-0 flex-1">{error.message}</span>
          <button type="button" className={ghostButton} onClick={() => setReload((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}
      {!error && issues === null && <Note>Loading issues…</Note>}
      {!error && issues?.length === 0 && (
        <Note>{text ? `No issues match “${text}”.` : 'Nothing here — try Recently updated.'}</Note>
      )}
      <ul className="flex flex-col gap-0.5">
        {issues?.map((issue) => {
          const client = clients.find((c) => c.id === issue.clientId)
          return (
            <li key={issue.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(issue)}
                className="flex w-full flex-col gap-0.5 px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-elevated)] disabled:opacity-50"
                style={{ borderRadius: 'var(--radius)' }}
              >
                <span className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-[11.5px] text-[var(--text-mute)]">
                    {issue.identifier}
                  </span>
                  <span className="line-clamp-2 text-[13px] text-foreground">{issue.title}</span>
                </span>
                <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--text-faint)]">
                  <span>{issue.stateName}</span>
                  {issue.assigneeName && <span>{issue.assigneeName}</span>}
                  <span>{relativeTime(issue.updatedAt)}</span>
                  {client ? (
                    <span className="text-[var(--accent)]">{client.name}</span>
                  ) : (
                    <span>no client mapped</span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
