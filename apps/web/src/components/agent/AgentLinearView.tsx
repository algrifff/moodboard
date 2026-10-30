import { ArrowLeft } from '@phosphor-icons/react'
import { LinearLogo } from '@/components/canvas/sourceLogos'
import { LinearIssuePicker } from '@/components/linear/LinearIssuePicker'
import { useAgentSidebarStore } from '@/store/agentSidebar'

// Pick a Linear issue to start a thread from. Nothing runs until one is
// picked.
export function AgentLinearView({ boardId }: { boardId: string }) {
  const showChat = useAgentSidebarStore((s) => s.showChat)
  const startFromLinearIssue = useAgentSidebarStore((s) => s.startFromLinearIssue)
  const busy = useAgentSidebarStore((s) => s.run !== null)

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
        <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-mute)]">
          <LinearLogo size={13} />
          Start from a Linear issue
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-3">
        <p className="mb-3 px-1 text-[12.5px] leading-relaxed text-[var(--text-mute)]">
          The issue — description, comments and attachment links — becomes the brief for a new
          thread. The agent resolves the client from the issue’s team or project.
        </p>
        <LinearIssuePicker
          autoFocus
          disabled={busy}
          onPick={(issue) => void startFromLinearIssue(boardId, issue)}
        />
      </div>
    </div>
  )
}
