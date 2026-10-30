// Class strings shared by the Phase 22 pages (kits, library, settings) so
// inputs and buttons read as one family.

export const inputClass =
  'w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors placeholder:text-[var(--text-faint)] focus:border-[var(--accent)] disabled:opacity-50'

export const selectClass = `${inputClass} appearance-none pr-7`

export const primaryButton =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-[filter,opacity] hover:brightness-110 disabled:opacity-50'

export const ghostButton =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-foreground disabled:opacity-40'

export const labelClass = 'text-micro uppercase tracking-[0.12em] text-[var(--text-mute)]'

export function relativeTime(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString()
}
