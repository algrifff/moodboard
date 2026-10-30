import { OUTPUT_FORMAT_LABELS, type OutputShareView } from '@moodboard/shared'
import { DownloadSimple } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { OutputFrame } from '@/components/outputs/OutputFrame'
import { ghostButton } from '@/components/ui'
import { getSharedOutput, shareRenderUrl } from '@/lib/outputsApi'

// Public viewer for a shared output: no sign-in. The document itself comes
// from the token-gated render route, in the same sandboxed frame the app
// uses, and downloads as the same single HTML file.
export function OutputSharePage() {
  const { token = '' } = useParams()
  const [share, setShare] = useState<OutputShareView | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    getSharedOutput(token)
      .then((s) => {
        setShare(s)
        document.title = s.name
      })
      .catch(() => setMissing(true))
  }, [token])

  if (missing) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6 text-center">
        <div>
          <h1 className="text-base font-semibold text-foreground">This link isn’t available</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            It may have been turned off by the people who shared it.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-[var(--bg-muted)]">
      <header className="flex h-12 shrink-0 items-center gap-3 bg-card px-4 shadow-[0_1px_0_var(--border-soft)]">
        <span className="text-[13px] font-semibold tracking-tight text-foreground">
          moodboard.ai
        </span>
        {share && (
          <>
            <span className="text-[var(--text-faint)]">/</span>
            <span className="min-w-0 truncate text-[13px] text-foreground">{share.name}</span>
            <span className="hidden text-[12px] text-[var(--text-mute)] sm:inline">
              {OUTPUT_FORMAT_LABELS[share.format]}
            </span>
          </>
        )}
        <div className="flex-1" />
        {share && (
          <a href={shareRenderUrl(token, true)} className={ghostButton} download>
            <DownloadSimple size={14} />
            Download HTML
          </a>
        )}
      </header>
      {share && (
        <OutputFrame
          src={shareRenderUrl(token)}
          viewport={share.viewport}
          deviceWidth={1440}
          interactive
          title={share.name}
          className="min-h-0 flex-1 p-4 sm:p-8"
        />
      )}
    </div>
  )
}
