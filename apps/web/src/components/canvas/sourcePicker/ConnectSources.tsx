import type { ConnectionSummary } from '@moodboard/shared'
import { CheckCircle, MagnifyingGlass, Plus } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { DriveLogo, SpotifyLogo } from '../sourceLogos'

// ---------------------------------------------------------------------------
// Empty state — no connections yet. Centred hero with both providers.
// ---------------------------------------------------------------------------

export function EmptySourcesState({
  loading,
  onConnectDrive,
  onConnectSpotify,
}: {
  loading: boolean
  onConnectDrive: () => void
  onConnectSpotify: () => void
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 text-center gap-4">
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center"
        style={{ backgroundColor: 'var(--bg-elevated)' }}
      >
        <MagnifyingGlass size={28} weight="duotone" />
      </div>
      <div className="space-y-1">
        <div className="text-base font-semibold text-foreground">No sources connected yet</div>
        <div className="text-[13px] text-[var(--text-faint)] max-w-[40ch]">
          Connect a workspace to pull pages and files onto the canvas alongside your visual
          references.
        </div>
      </div>
      <div className="flex flex-col gap-2 w-full max-w-[280px]">
        <ConnectProviderButton
          provider="drive"
          connectedCount={0}
          onClick={onConnectDrive}
          disabled={loading}
        />
        <ConnectProviderButton
          provider="spotify"
          connectedCount={0}
          onClick={onConnectSpotify}
          disabled={loading}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add another source — always-visible. New providers slot in by appending
// to the chip list.
// ---------------------------------------------------------------------------

export function AddSourceSection({
  connections,
  loading,
  onConnectDrive,
  onConnectSpotify,
}: {
  connections: ConnectionSummary[]
  loading: boolean
  onConnectDrive: () => void
  onConnectSpotify: () => void
}) {
  const driveCount = connections.filter((c) => c.provider === 'drive').length
  const spotifyCount = connections.filter((c) => c.provider === 'spotify').length

  return (
    <div
      className="mt-2 mb-3"
      style={{
        padding: '12px',
        borderRadius: 'var(--radius-lg)',
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-soft)',
      }}
    >
      <div className="flex items-center gap-1.5 mb-2.5 px-0.5">
        <Plus size={11} weight="bold" style={{ color: 'var(--text-mute)' }} />
        <span className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--text-mute)] font-semibold">
          Sources
        </span>
      </div>
      <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <ConnectProviderButton
          provider="drive"
          connectedCount={driveCount}
          onClick={onConnectDrive}
          disabled={loading}
        />
        <ConnectProviderButton
          provider="spotify"
          connectedCount={spotifyCount}
          onClick={onConnectSpotify}
          disabled={loading}
        />
      </div>
    </div>
  )
}

// Provider connect button. When the user already has at least one
// connection for this provider, the button label switches to "Add
// another" and a small accent checkmark indicates the connected state —
// extra accounts are first-class (Google allows multiple accounts).
function ConnectProviderButton({
  provider,
  connectedCount,
  onClick,
  disabled,
}: {
  provider: 'drive' | 'spotify'
  connectedCount: number
  onClick: () => void
  disabled?: boolean
}) {
  const label = provider === 'drive' ? 'Google Drive' : 'Spotify'
  const isConnected = connectedCount > 0
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileTap={{ scale: 0.97 }}
      transition={{ duration: 0.1, ease: [0.2, 0.8, 0.2, 1] }}
      className="inline-flex items-center gap-2 text-left transition-colors disabled:opacity-40 hover:bg-[var(--bg-card)]"
      style={{
        padding: '9px 12px',
        borderRadius: 'var(--radius)',
        backgroundColor: 'var(--bg-card)',
        color: 'var(--text)',
        border: '1px solid var(--border-soft)',
        cursor: 'pointer',
        minWidth: 0,
      }}
    >
      <ProviderGlyph provider={provider} size={18} />
      <div className="flex flex-col items-start flex-1 min-w-0">
        <span className="text-[12.5px] font-semibold leading-tight truncate w-full">{label}</span>
        <span className="text-[10px] text-[var(--text-faint)] leading-tight truncate w-full">
          {isConnected
            ? connectedCount === 1
              ? 'Connected · add another'
              : `${connectedCount} connected · add another`
            : 'Connect'}
        </span>
      </div>
      {isConnected && (
        <CheckCircle
          size={13}
          weight="fill"
          style={{ color: 'var(--accent)', flexShrink: 0 }}
          aria-label="Connected"
        />
      )}
    </motion.button>
  )
}

export function ProviderGlyph({
  provider,
  size = 14,
}: {
  provider: 'drive' | 'spotify'
  size?: number
}) {
  if (provider === 'drive') return <DriveLogo size={size} />
  return <SpotifyLogo size={size} />
}
