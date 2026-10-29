import type { AgentThread } from '@moodboard/shared'
import { CaretDown, NotePencil, SidebarSimple, Sparkle, Trash } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { AI_PANEL_DURATION, EASE_OUT_STANDARD } from '@/lib/motion'
import { AGENT_SIDEBAR_WIDTH, useAgentSidebarStore } from '@/store/agentSidebar'
import { AgentGroupView } from './AgentGroupView'
import { AgentThreadView } from './AgentThreadView'

// Docked to the left of the canvas, T3-chat style: the canvas viewport
// shrinks to make room rather than sliding under it.
export function AgentSidebar({ boardId }: { boardId: string }) {
  const open = useAgentSidebarStore((s) => s.open)
  const view = useAgentSidebarStore((s) => s.view)
  const enterBoard = useAgentSidebarStore((s) => s.enterBoard)
  const leaveBoard = useAgentSidebarStore((s) => s.leaveBoard)

  useEffect(() => {
    void enterBoard(boardId)
    return () => leaveBoard()
  }, [boardId, enterBoard, leaveBoard])

  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? AGENT_SIDEBAR_WIDTH : 0 }}
      transition={{ duration: AI_PANEL_DURATION, ease: EASE_OUT_STANDARD }}
      className="relative z-40 h-full shrink-0 overflow-hidden"
      style={{
        backgroundColor: 'var(--bg-card)',
        boxShadow: open ? '1px 0 0 var(--border-soft)' : 'none',
      }}
      aria-label="Agent"
      aria-hidden={!open}
      // Typing here must never reach the canvas shortcuts (undo, delete,
      // zoom) that listen on window.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex h-full flex-col" style={{ width: AGENT_SIDEBAR_WIDTH }}>
        <Header />
        {view.kind === 'group' ? (
          <AgentGroupView key={view.groupKey} boardId={boardId} groupKey={view.groupKey} />
        ) : (
          <AgentThreadView boardId={boardId} />
        )}
      </div>
    </motion.aside>
  )
}

function Header() {
  const setOpen = useAgentSidebarStore((s) => s.setOpen)
  const newThread = useAgentSidebarStore((s) => s.newThread)
  const threads = useAgentSidebarStore((s) => s.threads)
  const activeThreadId = useAgentSidebarStore((s) => s.activeThreadId)
  const running = useAgentSidebarStore((s) => s.run !== null)
  const [menuOpen, setMenuOpen] = useState(false)
  const active = threads.find((t) => t.id === activeThreadId)

  return (
    <div className="relative flex h-12 shrink-0 items-center gap-1 border-b border-[var(--border-soft)] pl-3 pr-2">
      <Sparkle size={15} weight="fill" className="shrink-0 text-[var(--accent)]" />
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="ml-1 inline-flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1 text-left text-[13px] font-medium text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
        style={{ borderRadius: 'var(--radius)' }}
        aria-expanded={menuOpen}
        title="Threads on this board"
      >
        <span className="truncate">{active?.title ?? 'New thread'}</span>
        <CaretDown size={11} weight="bold" className="shrink-0 text-[var(--text-mute)]" />
      </button>
      <IconButton
        label="New thread"
        disabled={running}
        onClick={() => {
          newThread()
          setMenuOpen(false)
        }}
      >
        <NotePencil size={16} />
      </IconButton>
      <IconButton label="Collapse sidebar" onClick={() => setOpen(false)}>
        <SidebarSimple size={16} />
      </IconButton>
      <AnimatePresence>
        {menuOpen && <ThreadMenu threads={threads} onClose={() => setMenuOpen(false)} />}
      </AnimatePresence>
    </div>
  )
}

function ThreadMenu({ threads, onClose }: { threads: AgentThread[]; onClose: () => void }) {
  const activeThreadId = useAgentSidebarStore((s) => s.activeThreadId)
  const selectThread = useAgentSidebarStore((s) => s.selectThread)
  const deleteThread = useAgentSidebarStore((s) => s.deleteThread)
  const runningId = useAgentSidebarStore((s) => s.run?.threadId ?? null)
  const loaded = useAgentSidebarStore((s) => s.threadsLoaded)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const header = ref.current?.parentElement
      if (header && !header.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    // Capture: the sidebar stops key events from bubbling (see above).
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.16, ease: EASE_OUT_STANDARD }}
      className="absolute left-2 right-2 top-[calc(100%+4px)] z-50 max-h-[60vh] overflow-y-auto py-1"
      style={{
        borderRadius: 'var(--radius-lg)',
        backgroundColor: 'var(--bg-card)',
        boxShadow: 'var(--shadow-popover), 0 0 0 1px var(--border-soft)',
      }}
      role="menu"
    >
      {threads.length === 0 ? (
        <div className="px-3 py-2.5 text-[12.5px] text-[var(--text-mute)]">
          {loaded ? 'No threads on this board yet.' : 'Loading…'}
        </div>
      ) : (
        threads.map((t) => (
          <div
            key={t.id}
            className={`group flex items-center gap-2 px-3 py-2 hover:bg-[var(--bg-elevated)] ${
              t.id === activeThreadId ? 'bg-[var(--bg-elevated)]' : ''
            }`}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void selectThread(t.id)
                onClose()
              }}
              className="min-w-0 flex-1 text-left"
            >
              <div className="truncate text-[12.5px] text-foreground">{t.title}</div>
              <div className="truncate text-[11px] text-[var(--text-faint)]">
                {[t.createdByName, relativeTime(t.updatedAt)].filter(Boolean).join(' · ')}
                {t.id === runningId && ' · working…'}
              </div>
            </button>
            {t.id !== runningId && (
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete “${t.title}” for everyone?`)) void deleteThread(t.id)
                }}
                className="shrink-0 text-[var(--text-faint)] opacity-0 hover:text-[var(--danger)] group-hover:opacity-100 focus:opacity-100 transition-opacity"
                aria-label="Delete thread"
                title="Delete thread"
              >
                <Trash size={13} />
              </button>
            )}
          </div>
        ))
      )}
    </motion.div>
  )
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text-mute)] hover:text-foreground hover:bg-[var(--bg-elevated)] disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
      style={{ borderRadius: 'var(--radius)' }}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
