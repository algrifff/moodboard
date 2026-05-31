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

// Settings → API keys. Powers the MCP server's Bearer-token flow. The
// MCP endpoint URL stays out of the body copy — it only surfaces in
// the reveal modal where it's needed alongside the just-minted token,
// so the settings page itself reads as plain key management.

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

export function ApiKeysSection() {
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

  return (
    <section
      className="bg-card p-6"
      style={{
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
      }}
      aria-labelledby="api-keys-heading"
    >
      <header className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h2
            id="api-keys-heading"
            className="text-base font-semibold text-foreground flex items-center gap-2"
          >
            <Key size={15} weight="regular" />
            API keys
          </h2>
          <p
            className="mt-1.5 text-[13px] text-[var(--text-soft)]"
            style={{ lineHeight: 1.55, maxWidth: '52ch' }}
          >
            Generate a token so external AI clients (Claude Desktop, Claude Code, Cursor) can list,
            read, and build your moodboards on your behalf.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium text-foreground bg-[var(--bg-elevated)] hover:bg-[var(--bg-muted)] transition-colors flex-shrink-0"
          style={{ padding: '7px 12px', borderRadius: 'var(--radius)' }}
        >
          <Plus size={13} weight="bold" />
          New key
        </button>
      </header>

      {error && <p className="text-[12.5px] text-[var(--danger)] mb-3 break-words">{error}</p>}

      {keys === null && <p className="text-[12.5px] text-[var(--text-mute)]">Loading…</p>}

      {keys !== null && keys.length === 0 && (
        <p className="text-[12.5px] text-[var(--text-mute)] italic">
          No keys yet. Click <span className="text-foreground font-medium">New key</span> to
          generate one.
        </p>
      )}

      {keys !== null && keys.length > 0 && (
        <ul className="divide-y divide-[var(--border-soft)]">
          {keys.map((k) => (
            <li
              key={k.id}
              className="py-3 flex items-center justify-between gap-3"
              style={{ minHeight: 40 }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2.5 min-w-0">
                  <span className="text-[13px] font-medium text-foreground truncate">{k.name}</span>
                  <span
                    className="text-[11.5px] text-[var(--text-mute)] font-mono flex-shrink-0"
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
                className="p-1.5 text-[var(--text-mute)] hover:text-[var(--danger)] hover:bg-[var(--bg-elevated)] transition-colors flex-shrink-0"
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
      <KeyRevealDialog minted={justCreated} onClose={() => setJustCreated(null)} />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Create dialog — name input only.
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
    <DialogShell open={open} onClose={onClose} title="New API key">
      <form onSubmit={onSubmit}>
        <label className="block text-[12px] text-[var(--text-mute)]" htmlFor="api-key-name">
          Name
        </label>
        <input
          id="api-key-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Claude Desktop"
          maxLength={60}
          className="mt-1.5 w-full bg-[var(--bg-elevated)] text-[13px] text-foreground outline-none focus:ring-2 focus:ring-[var(--accent)]"
          style={{ padding: '9px 12px', borderRadius: 'var(--radius)' }}
        />
        <p className="mt-2 text-[11.5px] text-[var(--text-faint)]" style={{ lineHeight: 1.5 }}>
          Labels the key in this list. The actual token shows once on the next screen — copy it
          immediately.
        </p>
        {err && <p className="mt-2 text-[12px] text-[var(--danger)] break-words">{err}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-[12.5px] font-medium text-[var(--text-mute)] hover:text-foreground transition-colors"
            style={{ padding: '8px 12px' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium text-primary-foreground bg-primary hover:brightness-110 disabled:opacity-50 transition-[filter,opacity]"
            style={{ padding: '8px 14px', borderRadius: 'var(--radius)' }}
          >
            {busy ? 'Creating…' : 'Create key'}
          </button>
        </div>
      </form>
    </DialogShell>
  )
}

// ---------------------------------------------------------------------------
// Reveal dialog — URL goes first (it's what every connector UI asks
// for), token sits below for clients that require an Authorization
// header. Reading the URL from window.location.origin means dev and
// prod surface their own correct host without us threading an env
// var through the SPA.
// ---------------------------------------------------------------------------

function KeyRevealDialog({
  minted,
  onClose,
}: {
  minted: MintedApiKey | null
  onClose: () => void
}) {
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [copiedToken, setCopiedToken] = useState(false)

  if (!minted) {
    return <DialogShell open={false} onClose={onClose} title="" />
  }

  const endpoint = typeof window === 'undefined' ? '/api/mcp' : `${window.location.origin}/api/mcp`

  const copy = async (text: string, mark: 'url' | 'token') => {
    try {
      await navigator.clipboard.writeText(text)
      if (mark === 'url') {
        setCopiedUrl(true)
        setTimeout(() => setCopiedUrl(false), 1400)
      } else {
        setCopiedToken(true)
        setTimeout(() => setCopiedToken(false), 1400)
      }
    } catch {
      // user can hand-select instead
    }
  }

  return (
    <DialogShell open={true} onClose={onClose} title="Your new key">
      <p className="text-[13px] text-[var(--text-soft)]" style={{ lineHeight: 1.55 }}>
        Paste the URL into your MCP client. If it asks for an Authorization header, use the token
        below.{' '}
        <span className="text-foreground font-medium">
          You won't see the token again after closing this.
        </span>
      </p>

      <div className="mt-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-[var(--text-faint)] font-semibold">
            Server URL
          </span>
          <button
            type="button"
            onClick={() => copy(endpoint, 'url')}
            className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] font-medium text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
            style={{ padding: '4px 8px', borderRadius: 'var(--radius)' }}
          >
            {copiedUrl ? <Check size={12} weight="bold" /> : <Copy size={12} weight="regular" />}
            {copiedUrl ? 'Copied' : 'Copy'}
          </button>
        </div>
        <input
          readOnly
          value={endpoint}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full bg-[var(--bg-elevated)] text-[12.5px] font-mono text-foreground outline-none"
          style={{ padding: '9px 12px', borderRadius: 'var(--radius)' }}
        />
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-[var(--text-faint)] font-semibold">
            Authorization token
          </span>
          <button
            type="button"
            onClick={() => copy(minted.plaintext, 'token')}
            className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] font-medium text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
            style={{ padding: '4px 8px', borderRadius: 'var(--radius)' }}
          >
            {copiedToken ? <Check size={12} weight="bold" /> : <Copy size={12} weight="regular" />}
            {copiedToken ? 'Copied' : 'Copy'}
          </button>
        </div>
        <input
          readOnly
          value={minted.plaintext}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full bg-[var(--bg-elevated)] text-[12px] font-mono text-foreground outline-none"
          style={{ padding: '9px 12px', borderRadius: 'var(--radius)' }}
        />
        <p className="mt-2 text-[11.5px] text-[var(--text-faint)]" style={{ lineHeight: 1.5 }}>
          Most connector UIs hide this under "Advanced settings" — paste as{' '}
          <span className="font-mono text-[var(--text-mute)]">Bearer {minted.prefix}…</span>
        </p>
      </div>

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="text-[12.5px] font-medium text-foreground bg-[var(--bg-elevated)] hover:bg-[var(--bg-muted)] transition-colors"
          style={{ padding: '8px 14px', borderRadius: 'var(--radius)' }}
        >
          Done
        </button>
      </div>
    </DialogShell>
  )
}

// ---------------------------------------------------------------------------
// Dialog shell — flex-centred so Framer-animated transforms on the
// card can't clobber a translate(-50%, -50%) trick. Same pattern as
// ShareDialog.
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
  children?: React.ReactNode
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
                width: 'min(560px, 100%)',
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
