import type { ConnectionSummary } from '@moodboard/shared'
import { CheckCircle, Plus } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { DriveLogo, LinearLogo, SpotifyLogo } from '../sourceLogos'

// ---------------------------------------------------------------------------
// Add another source — always-visible. New providers slot in by appending
// to the chip list.
// ---------------------------------------------------------------------------

export function AddSourceSection({
  connections,
  loading,
  onConnectDrive,
  onConnectSpotify,
  onConnectLinear,
}: {
  connections: ConnectionSummary[]
  loading: boolean
  onConnectDrive: () => void
  onConnectSpotify: () => void
  onConnectLinear: () => void
}) {
  const driveCount = connections.filter((c) => c.provider === 'drive').length
  const spotifyCount = connections.filter((c) => c.provider === 'spotify').length
  const linearCount = connections.filter((c) => c.provider === 'linear').length

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
      <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
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
        <ConnectProviderButton
          provider="linear"
          connectedCount={linearCount}
          onClick={onConnectLinear}
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
  provider: 'drive' | 'spotify' | 'linear'
  connectedCount: number
  onClick: () => void
  disabled?: boolean
}) {
  const label = provider === 'drive' ? 'Google Drive' : provider === 'linear' ? 'Linear' : 'Spotify'
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
  provider: 'drive' | 'spotify' | 'linear'
  size?: number
}) {
  if (provider === 'drive') return <DriveLogo size={size} />
  if (provider === 'linear') return <LinearLogo size={size} />
  return <SpotifyLogo size={size} />
}
