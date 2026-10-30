import type {
  CanvasObject,
  FigmaFrameData,
  GroupState,
  SharedBoardSnapshotInput,
  SharedGroupSnapshot,
  ShareViewParsed,
} from '@moodboard/shared'
import { Check, Copy, Trash, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { groupBoundingBox, groupId, proximityGroups } from '@moodboard/shared'
import { displayFromSlot, listGroupStates, slotFromDisplay } from '@/lib/groupStateApi'
import { EASE_OUT_STANDARD } from '@/lib/motion'
import { createOrUpdateBoardShare, deleteBoardShare, getBoardShare } from '@/lib/sharesApi'
import { useCanvasStore } from '@/store/canvas'
import { showToast } from './Toast'

// ---------------------------------------------------------------------------
// Snapshot builder — assembles the SharedBoardSnapshot from the live
// canvas store + the team's per-group panel state on the server. The brief
// field is "the displayed brief at share-time", which captures any inline
// edits made via BriefReadout. Groups without a completed read simply omit
// the field.
// ---------------------------------------------------------------------------

// A Figma card is shared as its picture and names; the layer outline is for the
// team's agents and says more than the picture does.
function forSharing(o: CanvasObject): CanvasObject {
  if (o.type !== 'figma-frame') return o
  const { structure: _outline, ...data } = o.data as FigmaFrameData
  return { ...o, data }
}

export function buildSnapshot({
  boardName,
  objects,
  groupStates,
}: {
  boardName: string
  objects: CanvasObject[]
  groupStates: GroupState[]
}): SharedBoardSnapshotInput {
  const stateByKey = new Map(groupStates.map((g) => [g.groupKey, g]))
  const idGroups = proximityGroups(objects)
  const byId = new Map(objects.map((o) => [o.id, o]))
  const groups: SharedGroupSnapshot[] = idGroups.map((ids) => {
    const items = ids.map((id) => byId.get(id)!).filter(Boolean)
    const key = groupId(ids)
    const stored = stateByKey.get(key)
    const display = displayFromSlot(slotFromDisplay(stored?.display ?? null) ?? undefined)
    return {
      key,
      objectIds: ids,
      bounds: groupBoundingBox(items, 20),
      palette: stored?.aiPalette ?? [],
      ...(display ? { display } : {}),
    }
  })
  return {
    version: 1,
    boardName,
    capturedAt: new Date().toISOString(),
    objects: objects.map(forSharing),
    groups,
  }
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

type DialogStatus =
  | { kind: 'loading' }
  | { kind: 'no-share' }
  | { kind: 'has-share'; share: ShareViewParsed }
  | { kind: 'error'; message: string }

export function ShareDialog({
  open,
  onClose,
  boardId,
  boardName,
}: {
  open: boolean
  onClose: () => void
  boardId: string
  boardName: string
}) {
  const [status, setStatus] = useState<DialogStatus>({ kind: 'loading' })
  const [working, setWorking] = useState<null | 'create' | 'update' | 'delete'>(null)
  const [confirmRevoke, setConfirmRevoke] = useState(false)

  // Refresh whenever the dialog opens — the user may have created /
  // revoked a share since the last time we looked.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setStatus({ kind: 'loading' })
    setConfirmRevoke(false)
    getBoardShare(boardId)
      .then((share) => {
        if (cancelled) return
        if (share) setStatus({ kind: 'has-share', share })
        else setStatus({ kind: 'no-share' })
      })
      .catch((e: Error) => {
        if (cancelled) return
        setStatus({ kind: 'error', message: e.message })
      })
    return () => {
      cancelled = true
    }
  }, [open, boardId])

  // Esc closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const createOrUpdate = useCallback(
    async (mode: 'create' | 'update') => {
      setWorking(mode)
      try {
        const objects = useCanvasStore.getState().objects
        const groupStates = await listGroupStates(boardId)
        const snapshot = buildSnapshot({ boardName, objects, groupStates })
        const next = await createOrUpdateBoardShare(boardId, snapshot)
        setStatus({ kind: 'has-share', share: next })
        showToast(mode === 'create' ? 'Share link created' : 'Snapshot updated')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setStatus({ kind: 'error', message: msg })
      } finally {
        setWorking(null)
      }
    },
    [boardId, boardName],
  )

  const revoke = useCallback(async () => {
    setWorking('delete')
    try {
      await deleteBoardShare(boardId)
      setStatus({ kind: 'no-share' })
      setConfirmRevoke(false)
      showToast('Share revoked')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus({ kind: 'error', message: msg })
    } finally {
      setWorking(null)
    }
  }, [boardId])

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="share-scrim"
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
          {/* Flex-center wrapper because Framer Motion's animated
              transform on the inner card would otherwise clobber a
              translate(-50%, -50%) centering trick. */}
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
              key="share-dialog"
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ duration: 0.22, ease: EASE_OUT_STANDARD }}
              role="dialog"
              aria-modal="true"
              aria-label="Share board"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 'min(520px, 100%)',
                backgroundColor: 'var(--bg-card)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-modal)',
                padding: 22,
                pointerEvents: 'auto',
              }}
            >
              <header className="flex items-center justify-between gap-3">
                <h2
                  className="text-foreground"
                  style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.005em' }}
                >
                  Share this board
                </h2>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="text-[var(--text-mute)] hover:text-foreground transition-colors"
                  style={{ width: 24, height: 24 }}
                >
                  <X size={14} weight="bold" />
                </button>
              </header>

              <div style={{ marginTop: 16 }}>
                {status.kind === 'loading' && (
                  <p className="text-[13px] text-[var(--text-mute)]">Loading…</p>
                )}
                {status.kind === 'error' && (
                  <p className="text-[13px] text-destructive break-words">{status.message}</p>
                )}
                {status.kind === 'no-share' && (
                  <CreateState
                    busy={working === 'create'}
                    onCreate={() => createOrUpdate('create')}
                  />
                )}
                {status.kind === 'has-share' && (
                  <ManageState
                    share={status.share}
                    busy={working}
                    confirmRevoke={confirmRevoke}
                    setConfirmRevoke={setConfirmRevoke}
                    onUpdate={() => createOrUpdate('update')}
                    onRevoke={revoke}
                  />
                )}
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// State views
// ---------------------------------------------------------------------------

function CreateState({ busy, onCreate }: { busy: boolean; onCreate: () => void }) {
  return (
    <div>
      <p className="text-[13px] text-[var(--text-soft)]" style={{ lineHeight: 1.55, margin: 0 }}>
        Creating a share link captures a snapshot of your moodboard as it is now. Anyone with the
        link can view the board and the synthesis brief — but{' '}
        <span className="text-foreground font-medium">future edits won't appear</span> until you
        choose to update the snapshot.
      </p>
      <div style={{ marginTop: 18 }} className="flex justify-end">
        <button
          type="button"
          onClick={onCreate}
          disabled={busy}
          className="inline-flex items-center gap-2 text-[13px] font-medium text-primary-foreground bg-primary hover:brightness-110 transition-[filter] disabled:opacity-50"
          style={{ padding: '8px 14px', borderRadius: 'var(--radius)' }}
        >
          {busy ? 'Creating…' : 'Create share link'}
        </button>
      </div>
    </div>
  )
}

function ManageState({
  share,
  busy,
  confirmRevoke,
  setConfirmRevoke,
  onUpdate,
  onRevoke,
}: {
  share: ShareViewParsed
  busy: null | 'create' | 'update' | 'delete'
  confirmRevoke: boolean
  setConfirmRevoke: (v: boolean) => void
  onUpdate: () => void
  onRevoke: () => void
}) {
  const [copied, setCopied] = useState(false)
  const shareUrl = `${window.location.origin}/share/${share.token}`
  const capturedDate = (() => {
    try {
      return new Date(share.capturedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    } catch {
      return share.capturedAt
    }
  })()

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      showToast('Link copied')
      setTimeout(() => setCopied(false), 1400)
    } catch {
      showToast('Copy failed — select and copy manually')
    }
  }

  return (
    <div>
      <div
        className="flex items-stretch gap-2"
        style={{
          padding: 6,
          borderRadius: 'var(--radius)',
          backgroundColor: 'var(--bg-elevated)',
        }}
      >
        <input
          readOnly
          value={shareUrl}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 bg-transparent text-[12.5px] font-mono text-foreground outline-none"
          style={{ padding: '6px 8px', minWidth: 0 }}
          aria-label="Share URL"
        />
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-foreground hover:bg-[var(--bg-card)] transition-colors"
          style={{ padding: '6px 10px', borderRadius: 'var(--radius)' }}
          aria-label="Copy link"
        >
          {copied ? <Check size={13} weight="bold" /> : <Copy size={13} weight="regular" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <p className="text-[11.5px] text-[var(--text-faint)]" style={{ marginTop: 8 }}>
        Snapshot from {capturedDate}. Future edits won't appear in this share until you update the
        snapshot.
      </p>

      <div style={{ marginTop: 18 }} className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setConfirmRevoke(true)}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--danger)] hover:text-destructive transition-colors disabled:opacity-50"
        >
          <Trash size={13} weight="regular" />
          Revoke
        </button>
        <button
          type="button"
          onClick={onUpdate}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 text-[12.5px] font-medium text-foreground hover:bg-[var(--bg-elevated)] transition-colors disabled:opacity-50"
          style={{ padding: '7px 13px', borderRadius: 'var(--radius)' }}
        >
          {busy === 'update' ? 'Updating…' : 'Update snapshot'}
        </button>
      </div>

      {confirmRevoke && (
        <div
          style={{
            marginTop: 14,
            padding: 12,
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            backgroundColor: 'var(--bg-elevated)',
          }}
        >
          <p className="text-[12.5px] text-foreground">
            Revoke this share? The link will stop working immediately.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmRevoke(false)}
              disabled={busy === 'delete'}
              className="text-[12px] font-medium text-[var(--text-mute)] hover:text-foreground transition-colors"
              style={{ padding: '6px 10px' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onRevoke}
              disabled={busy === 'delete'}
              className="text-[12px] font-medium text-destructive hover:brightness-110 transition-[filter]"
              style={{
                padding: '6px 10px',
                borderRadius: 'var(--radius)',
                backgroundColor: 'var(--bg-card)',
              }}
            >
              {busy === 'delete' ? 'Revoking…' : 'Revoke share'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
