import { LinearLogo } from '../sourceLogos'
import { LinearIssuePicker } from '@/components/linear/LinearIssuePicker'
import { useAgentSidebarStore } from '@/store/agentSidebar'
import { useSourcePickerStore } from '@/store/sourcePicker'
import { Section } from './tiles'

// Linear issues in the sources drawer. Picking one starts an agent thread
// with the issue as the brief, in the sidebar.
export function LinearSection({ boardId, query }: { boardId: string; query: string }) {
  const startFromLinearIssue = useAgentSidebarStore((s) => s.startFromLinearIssue)
  const busy = useAgentSidebarStore((s) => s.run !== null)
  const closePicker = useSourcePickerStore((s) => s.closePicker)

  return (
    <Section
      title={
        <span className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.12em] text-[var(--text-mute)] font-semibold">
          <LinearLogo size={12} />
          Linear
        </span>
      }
    >
      <div className="px-1 pt-1">
        <LinearIssuePicker
          query={query}
          disabled={busy}
          onPick={(issue) => {
            closePicker()
            void startFromLinearIssue(boardId, issue)
          }}
        />
      </div>
    </Section>
  )
}
