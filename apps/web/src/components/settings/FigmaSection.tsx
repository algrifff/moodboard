import { useEffect } from 'react'
import { FigmaLogo } from '@/components/canvas/sourceLogos'
import { ghostButton, primaryButton } from '@/components/ui'
import { useFigmaStore } from '@/store/figma'

// Settings → Figma: the connection. Frames are imported from a board's
// Sources drawer (or by pasting a link on the canvas) and a kit is made from
// a file on the Kits page; the connection is yours, and read-only.
export function FigmaSection() {
  const status = useFigmaStore((s) => s.status)
  const statusError = useFigmaStore((s) => s.statusError)
  const load = useFigmaStore((s) => s.load)
  const connect = useFigmaStore((s) => s.connect)
  const connecting = useFigmaStore((s) => s.connecting)
  const connectError = useFigmaStore((s) => s.connectError)
  const disconnect = useFigmaStore((s) => s.disconnect)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section>
      <div className="flex items-center gap-2">
        <FigmaLogo size={16} />
        <h2 className="text-lg font-semibold text-foreground">Figma</h2>
      </div>
      <p className="mt-1 text-sm text-[var(--text-soft)]">
        Paste a Figma frame link on a board to bring it in as an image the agents can use as a
        visual reference, and turn a file’s styles into a style kit. Read-only — nothing is ever
        written to Figma.
      </p>

      <div className="mt-4">
        {statusError ? (
          <p className="text-sm text-destructive">{statusError}</p>
        ) : !status ? (
          <p className="text-sm text-muted-foreground">Checking Figma…</p>
        ) : !status.configured ? (
          <div
            className="bg-card p-4 text-sm leading-relaxed text-[var(--text-soft)]"
            style={{ borderRadius: 'var(--radius-lg)' }}
          >
            <p className="font-medium text-foreground">Figma isn’t configured on this server.</p>
            <p className="mt-1">
              Create an OAuth app at figma.com/developers/apps with the redirect URI{' '}
              <code className="font-mono">…/api/connections/figma/callback</code> and read scopes
              only, then set <code className="font-mono">FIGMA_CLIENT_ID</code>,{' '}
              <code className="font-mono">FIGMA_CLIENT_SECRET</code> and{' '}
              <code className="font-mono">FIGMA_REDIRECT_URI</code> on the API and restart it.
            </p>
          </div>
        ) : !status.connection ? (
          <div className="flex flex-col items-start gap-2">
            <button
              type="button"
              className={primaryButton}
              disabled={connecting}
              onClick={() => void connect()}
            >
              {connecting ? 'Waiting for Figma…' : 'Connect Figma'}
            </button>
            {connectError && <p className="text-sm text-destructive">{connectError}</p>}
          </div>
        ) : (
          <div
            className="flex items-center gap-3 bg-card px-4 py-3"
            style={{ borderRadius: 'var(--radius-lg)' }}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-foreground">
                {status.connection.accountEmail}
              </div>
              <div className="text-xs text-[var(--text-mute)]">
                {status.connection.handle ?? 'Figma account'}
              </div>
            </div>
            <button
              type="button"
              className={ghostButton}
              onClick={() => {
                if (confirm('Disconnect Figma? Frames already on boards stay.')) void disconnect()
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
