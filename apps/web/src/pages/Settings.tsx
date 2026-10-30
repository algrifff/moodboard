import { ArrowLeft } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import { ApiKeysSection } from '@/components/settings/ApiKeysSection'
import { FigmaSection } from '@/components/settings/FigmaSection'
import { LinearSection } from '@/components/settings/LinearSection'

// Settings page — entered from the dashboard header (click your email
// in the top-right). Structured as a vertical stack of sections so new
// surfaces (connections, profile, theme defaults) can land without
// re-thinking the page.

export function SettingsPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="max-w-3xl mx-auto px-6 pt-6 pb-3">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--text-mute)] hover:text-foreground transition-colors"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={13} weight="regular" />
          Back to boards
        </Link>
      </header>

      <main className="max-w-3xl mx-auto px-6 pt-3 pb-16">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
        <p className="mt-1.5 text-sm text-[var(--text-soft)]">
          Wire moodboard up to the rest of your stack.
        </p>

        <div className="mt-8 space-y-8">
          <LinearSection />
          <FigmaSection />
          <ApiKeysSection />
        </div>
      </main>
    </div>
  )
}
