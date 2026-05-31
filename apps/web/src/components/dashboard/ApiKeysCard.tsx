import { Check, Copy, Key, Plus, Trash, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  deleteApiKey,
  listApiKeys,
  mintApiKey,
  type ApiKeyView,
  type MintedApiKey,
} from '@/lib/apiKeysApi'
import { EASE_OUT_STANDARD } from '@/lib/motion'

// Dashboard "API keys" card. Powers the MCP server's Bearer-token
// flow — the user mints a key here, copies it to their Claude
// Desktop / Claude Code MCP config, and never sees the plaintext
// again.

function formatWhen(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString()
}

export function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKeyView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [justCreated, setJustCreated] = useState<MintedApiKey | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await listApiKeys()
      setKeys(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onRevoke = async (id: string) => {
    if (!confirm('Revoke this key? Any client using it will lose access immediately.')) return
    try {
      await deleteApiKey(id)
      setKeys((k) => (k ? k.filter((x) => x.id !== id) : k))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const mcpHost = `${window.location.protocol}//${window.location.host}/api/mcp`

  return (
    <section
      className="bg-card p-5"
      style={{ borderRadius: 'var(--radius-lg)' }}
      aria-labelledby="api-keys-heading"
    >
      <header className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h3
            id="api-keys-heading"
            className="text-sm font-semibold text-foreground flex items-center gap-1.5"
          >
            <Key size={14} weight="regular" /> API keys
          </h3>
          <p className="mt-1 text-[12.5px] text-muted-foreground" style={{ lineHeight: 1.5 }}>
            Generate a Bearer token so Claude Desktop, Claude Code, Cursor, or any other MCP client
            can list, read, and build your moodboards. Point your client at{' '}
            <span className="font-mono text-foreground">{mcpHost}</span> and paste the token as the
            Authorization header.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-foreground bg-[var(--bg-elevated)] hover:bg-[var(--bg-muted)] transition-colors"
          style={{ padding: '6px 10px', borderRadius: 'var(--radius)' }}
        >
          <Plus size={13} weight="bold" /> New key
        </button>
      </header>

      {error && <p className="text-[12.5px] text-destructive mb-2">{error}</p>}

      {keys === null && <p className="text-[12.5px] text-muted-foreground">Loading…</p>}

      {keys !== null && keys.length === 0 && (
        <p className="text-[12.5px] text-muted-foreground italic">
          No keys yet. Click <span className="text-foreground font-medium">New key</span> to
          generate one.
        </p>
      )}

      {keys !== null && keys.length > 0 && (
        <ul className="divide-y divide-[var(--border-soft)]">
          {keys.map((k) => (
            <li
              key={k.id}
              className="py-2.5 flex items-center justify-between gap-3"
              style={{ minHeight: 36 }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-medium text-foreground truncate">{k.name}</span>
                  <span
                    className="text-[11px] text-muted-foreground font-mono"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {k.prefix}…
                  </span>
                </div>
                <p className="text-[11px] text-[var(--text-faint)] mt-0.5">
                  Created {formatWhen(k.createdAt)} · Last used {formatWhen(k.lastUsedAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onRevoke(k.id)}
                className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-[var(--bg-elevated)] transition-colors"
                style={{ borderRadius: 'var(--radius)' }}
                aria-label="Revoke key"
                title="Revoke key"
              >
                <Trash size={13} weight="regular" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <CreateKeyDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(minted) => {
          setShowCreate(false)
          setJustCreated(minted)
          void refresh()
        }}
      />
      <KeyRevealDialog
        minted={justCreated}
        onClose={() => setJustCreated(null)}
        mcpHost={mcpHost}
      />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Create flow
// ---------------------------------------------------------------------------

function CreateKeyDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (key: MintedApiKey) => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName('')
      setBusy(false)
      setErr(null)
    }
  }, [open])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setErr(null)
    try {
      const minted = await mintApiKey(trimmed)
      onCreated(minted)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <DialogShell open={open} onClose={onClose} title="Create API key">
      <form onSubmit={onSubmit}>
        <label className="block text-[12px] text-muted-foreground" htmlFor="api-key-name">
          Name
        </label>
        <input
          id="api-key-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Claude Desktop"
          maxLength={60}
          className="mt-1 w-full bg-[var(--bg-elevated)] text-[13px] text-foreground outline-none focus:ring-2 focus:ring-[var(--accent)]"
          style={{ padding: '8px 10px', borderRadius: 'var(--radius)' }}
        />
        <p className="mt-2 text-[11.5px] text-[var(--text-faint)]" style={{ lineHeight: 1.5 }}>
          Used to identify the key in this list. The actual token is shown only once, on the next
          screen.
        </p>
        {err && <p className="mt-2 text-[12px] text-destructive break-words">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-[12.5px] font-medium text-muted-foreground hover:text-foreground transition-colors"
            style={{ padding: '7px 12px' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-primary-foreground bg-primary hover:brightness-110 disabled:opacity-50 transition-[filter,opacity]"
            style={{ padding: '7px 13px', borderRadius: 'var(--radius)' }}
          >
            {busy ? 'Creating…' : 'Create key'}
          </button>
        </div>
      </form>
    </DialogShell>
  )
}

function KeyRevealDialog({
  minted,
  onClose,
  mcpHost,
}: {
  minted: MintedApiKey | null
  onClose: () => void
  mcpHost: string
}) {
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    if (!minted) return
    try {
      await navigator.clipboard.writeText(minted.plaintext)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // ignore — user can hand-select the input.
    }
  }

  return (
    <DialogShell open={Boolean(minted)} onClose={onClose} title="Your new key">
      {minted && (
        <div>
          <p className="text-[12.5px] text-[var(--text-soft)]" style={{ lineHeight: 1.55 }}>
            Copy this token now —{' '}
            <span className="text-foreground font-medium">you won't see it again</span>. Paste it as
            the Authorization Bearer header in your MCP client config alongside the URL{' '}
            <span className="font-mono text-foreground">{mcpHost}</span>.
          </p>
          <div
            className="mt-3 flex items-stretch gap-2"
            style={{
              padding: 6,
              borderRadius: 'var(--radius)',
              backgroundColor: 'var(--bg-elevated)',
            }}
          >
            <input
              readOnly
              value={minted.plaintext}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 bg-transparent text-[12.5px] font-mono text-foreground outline-none"
              style={{ padding: '6px 8px', minWidth: 0 }}
            />
            <button
              type="button"
              onClick={onCopy}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-foreground hover:bg-[var(--bg-card)] transition-colors"
              style={{ padding: '6px 10px', borderRadius: 'var(--radius)' }}
            >
              {copied ? <Check size={13} weight="bold" /> : <Copy size={13} weight="regular" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="text-[12.5px] font-medium text-foreground bg-[var(--bg-elevated)] hover:bg-[var(--bg-muted)] transition-colors"
              style={{ padding: '7px 13px', borderRadius: 'var(--radius)' }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </DialogShell>
  )
}

// ---------------------------------------------------------------------------
// Shared dialog shell (small modal)
// ---------------------------------------------------------------------------

function DialogShell({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE_OUT_STANDARD }}
            onClick={onClose}
            style={{
              position: 'fixed',
              inset: 0,
              backgroundColor: 'var(--scrim)',
              zIndex: 70,
            }}
          />
          <div
            style={{
              position: 'fixed',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 16,
              zIndex: 71,
              pointerEvents: 'none',
            }}
          >
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ duration: 0.22, ease: EASE_OUT_STANDARD }}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label={title}
              style={{
                width: 'min(480px, 100%)',
                backgroundColor: 'var(--bg-card)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-modal)',
                padding: 22,
                pointerEvents: 'auto',
              }}
            >
              <header className="flex items-center justify-between gap-2 mb-3">
                <h3 className="text-[14.5px] font-semibold text-foreground">{title}</h3>
                <button
                  type="button"
                  onClick={onClose}
                  className="text-[var(--text-mute)] hover:text-foreground transition-colors"
                  style={{ width: 22, height: 22 }}
                  aria-label="Close"
                >
                  <X size={13} weight="bold" />
                </button>
              </header>
              {children}
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}
