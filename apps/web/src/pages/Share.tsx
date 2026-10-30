import type {
  CanvasObject,
  DriveFileData,
  DriveFolderData,
  PDFData,
  SpotifyAlbumData,
  SpotifyPlaylistData,
  SpotifyTrackData,
  StickyData,
  TextData,
  VideoClipData,
  VoiceNoteData,
  WebPageData,
  FontData,
  ImageData,
  OutputCardData,
  SharedGroupSnapshot,
  ShareViewParsed,
} from '@moodboard/shared'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ReadOnlyProvider } from '@/lib/readOnlyContext'
import { getShareByToken, rewriteAssetUrl } from '@/lib/sharesApi'
import { ArtDirectorReadout } from '@/components/canvas/readouts/ArtDirectorReadout'
import { BriefReadout } from '@/components/canvas/readouts/BriefReadout'
import { SectionedReadout } from '@/components/canvas/readouts/SectionedReadout'
import { VideoEditorReadout } from '@/components/canvas/readouts/VideoEditorReadout'
import { SnapshotCanvas } from '@/components/canvas/SnapshotCanvas'

// ---------------------------------------------------------------------------
// Asset URL rewriting — every /api/files/<x> in the snapshot becomes
// /api/shares/<token>/files/<x> before any component sees it. Single
// pass over the snapshot at load time; no rewriter in node components.
// ---------------------------------------------------------------------------

function rewriteObjectAssets(o: CanvasObject, token: string): CanvasObject {
  // Walk every string field on `data`; rewriteAssetUrl is a no-op on
  // non-matching strings, so it's safe to apply liberally.
  const data = o.data as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') {
      next[k] = rewriteAssetUrl(v, token)
    } else if (Array.isArray(v)) {
      next[k] = v.map((item) => {
        if (item && typeof item === 'object') {
          const child: Record<string, unknown> = {}
          for (const [ck, cv] of Object.entries(item)) {
            child[ck] = typeof cv === 'string' ? rewriteAssetUrl(cv, token) : cv
          }
          return child
        }
        return item
      })
    } else {
      next[k] = v
    }
  }
  return { ...o, data: next as CanvasObject['data'] }
}

function rewriteSnapshot(view: ShareViewParsed, token: string): ShareViewParsed {
  return {
    ...view,
    snapshot: {
      ...view.snapshot,
      objects: view.snapshot.objects.map((o) => rewriteObjectAssets(o, token)),
    },
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; view: ShareViewParsed }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }

export function SharePage() {
  const { token } = useParams<{ token: string }>()
  const [searchParams] = useSearchParams()
  const isPrint = searchParams.get('print') === '1'
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  // Force light theme on the viewer regardless of the user's preference
  // — the page is a presentation surface and the PDF render needs it.
  // Also flip a `data-print-mode` attribute when ?print=1 so the print
  // CSS rules (page breaks between groups) apply during the Playwright
  // PDF render even though that doesn't trigger the `@media print`
  // media query.
  useEffect(() => {
    const root = document.documentElement
    const prevTheme = root.getAttribute('data-theme')
    const prevPrint = root.getAttribute('data-print-mode')
    root.setAttribute('data-theme', 'light')
    if (isPrint) root.setAttribute('data-print-mode', '1')
    return () => {
      if (prevTheme === null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', prevTheme)
      if (prevPrint === null) root.removeAttribute('data-print-mode')
      else root.setAttribute('data-print-mode', prevPrint)
    }
  }, [isPrint])

  useEffect(() => {
    if (!token) {
      setStatus({ kind: 'not-found' })
      return
    }
    let cancelled = false
    getShareByToken(token)
      .then((view) => {
        if (cancelled) return
        setStatus({ kind: 'ready', view: rewriteSnapshot(view, token) })
      })
      .catch((e: Error) => {
        if (cancelled) return
        if (e.message.startsWith('404')) setStatus({ kind: 'not-found' })
        else setStatus({ kind: 'error', message: e.message })
      })
    return () => {
      cancelled = true
    }
  }, [token])

  // Set window.__SHARE_READY once Konva has drawn and all <img>
  // elements are complete. Playwright waits on this flag before
  // taking the PDF. Timeout-fallback so a single broken image doesn't
  // hang the render forever.
  useEffect(() => {
    if (status.kind !== 'ready') return
    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const start = Date.now()
    const HARD_TIMEOUT_MS = 25_000
    const check = () => {
      if (cancelled) return
      const imgs = Array.from(document.images)
      const allDone = imgs.every((img) => img.complete)
      if (allDone || Date.now() - start > HARD_TIMEOUT_MS) {
        ;(window as unknown as { __SHARE_READY?: boolean }).__SHARE_READY = true
        return
      }
      timeoutId = setTimeout(check, 200)
    }
    // Give Konva one tick to render its initial canvas state, then
    // start polling image loads.
    timeoutId = setTimeout(check, 50)
    return () => {
      cancelled = true
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [status.kind])

  if (status.kind === 'loading') {
    return <CenterMessage title="Loading…" body="One moment." />
  }
  if (status.kind === 'not-found') {
    return (
      <CenterMessage
        title="Share not found"
        body="This share link is invalid or has been revoked by the owner."
      />
    )
  }
  if (status.kind === 'error') {
    return <CenterMessage title="Couldn't load this share" body={status.message} />
  }

  return (
    <ReadOnlyProvider value={true}>
      <ShareBody view={status.view} isPrint={isPrint} token={token!} />
    </ReadOnlyProvider>
  )
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function ShareBody({
  view,
  isPrint,
  token,
}: {
  view: ShareViewParsed
  isPrint: boolean
  token: string
}) {
  const { snapshot } = view
  const objectsById = useMemo(
    () => new Map(snapshot.objects.map((o) => [o.id, o])),
    [snapshot.objects],
  )
  const groupedIds = useMemo(() => {
    const s = new Set<string>()
    for (const g of snapshot.groups) for (const id of g.objectIds) s.add(id)
    return s
  }, [snapshot.groups])
  const ungrouped = snapshot.objects.filter((o) => !groupedIds.has(o.id))

  const onDownloadPdf = useCallback(() => {
    window.location.href = `/api/shares/${encodeURIComponent(token)}/pdf`
  }, [token])

  const capturedDate = useMemo(() => {
    try {
      return new Date(view.capturedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    } catch {
      return view.capturedAt
    }
  }, [view.capturedAt])

  return (
    <div
      className="min-h-screen bg-background text-foreground"
      style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif',
      }}
    >
      <Header
        boardName={snapshot.boardName}
        capturedDate={capturedDate}
        onDownloadPdf={onDownloadPdf}
        isPrint={isPrint}
      />

      {/* Hero — fit-to-all snapshot of the canvas */}
      <section
        className="mx-auto"
        style={{
          maxWidth: 1120,
          padding: '0 24px',
        }}
      >
        <div
          style={{
            height: 'min(72vh, 720px)',
            borderRadius: 'var(--radius-lg)',
            backgroundColor: 'var(--bg-card)',
            boxShadow: 'var(--shadow-card)',
            overflow: 'hidden',
            marginBottom: 48,
          }}
        >
          <SnapshotCanvas
            objects={snapshot.objects}
            groups={snapshot.groups}
            pseudoBoardId={`share-${token}`}
          />
        </div>
      </section>

      {/* Doc section — brief per group + source cards */}
      <section
        className="mx-auto"
        style={{
          maxWidth: 880,
          padding: '0 24px 80px',
        }}
      >
        {snapshot.groups.length === 0 ? (
          <EmptyDoc />
        ) : (
          snapshot.groups.map((group, idx) => (
            <GroupSection
              key={group.key}
              group={group}
              index={idx}
              total={snapshot.groups.length}
              objectsById={objectsById}
            />
          ))
        )}
        {ungrouped.length > 0 && (
          <div
            style={{
              marginTop: snapshot.groups.length > 0 ? 64 : 0,
              paddingTop: 28,
              borderTop: snapshot.groups.length > 0 ? '1px solid var(--border-soft)' : 'none',
            }}
          >
            <SectionLabel>Other sources</SectionLabel>
            <div className="mt-3">
              <SourceGrid objects={ungrouped} />
            </div>
          </div>
        )}
      </section>

      <Footer />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header (with Download PDF button — hidden in print mode)
// ---------------------------------------------------------------------------

function Header({
  boardName,
  capturedDate,
  onDownloadPdf,
  isPrint,
}: {
  boardName: string
  capturedDate: string
  onDownloadPdf: () => void
  isPrint: boolean
}) {
  return (
    <header
      className="mx-auto"
      style={{
        maxWidth: 1120,
        padding: '32px 24px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
      }}
    >
      <div>
        <h1
          className="text-foreground"
          style={{
            fontFamily: 'ui-serif, Georgia, "Iowan Old Style", serif',
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            lineHeight: 1.15,
          }}
        >
          {boardName}
        </h1>
        <p className="text-[12px] text-[var(--text-mute)]" style={{ marginTop: 6 }}>
          Snapshot from {capturedDate}
        </p>
      </div>
      {!isPrint && (
        <button
          type="button"
          onClick={onDownloadPdf}
          className="inline-flex items-center gap-2 text-[13px] font-medium text-primary-foreground bg-primary hover:brightness-110 transition-[filter]"
          style={{
            padding: '8px 14px',
            borderRadius: 'var(--radius)',
          }}
        >
          Download PDF
        </button>
      )}
    </header>
  )
}

function Footer() {
  return (
    <footer
      className="mx-auto"
      style={{
        maxWidth: 1120,
        padding: '24px 24px 48px',
        textAlign: 'center',
        color: 'var(--text-faint)',
        fontSize: 11,
        letterSpacing: '0.04em',
      }}
    >
      Made with moodboard.ai
    </footer>
  )
}

// ---------------------------------------------------------------------------
// Per-group doc section
// ---------------------------------------------------------------------------

function GroupSection({
  group,
  index,
  total,
  objectsById,
}: {
  group: SharedGroupSnapshot
  index: number
  total: number
  objectsById: Map<string, CanvasObject>
}) {
  const items = group.objectIds
    .map((id) => objectsById.get(id))
    .filter((o): o is CanvasObject => Boolean(o))
  return (
    <article
      className="share-group"
      style={{
        // Print-only: force a page break before every group past the
        // first so the PDF sections sit on their own pages.
        marginTop: index === 0 ? 0 : 64,
        paddingTop: index === 0 ? 0 : 28,
        borderTop: index === 0 ? 'none' : '1px solid var(--border-soft)',
      }}
    >
      <div className="flex items-baseline justify-between gap-4">
        <SectionLabel>
          Group {index + 1} of {total}
        </SectionLabel>
        {group.palette.length > 0 && (
          <div className="flex items-center gap-1">
            {group.palette.slice(0, 6).map((hex, i) => (
              <span
                key={`${hex}-${i}`}
                title={hex.toUpperCase()}
                style={{
                  display: 'inline-block',
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  backgroundColor: hex,
                  boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.08)',
                }}
              />
            ))}
          </div>
        )}
      </div>
      <GroupReadout group={group} />

      <div className="mt-7">
        <SectionLabel>Sources</SectionLabel>
        <div className="mt-3">
          <SourceGrid objects={items} />
        </div>
      </div>
    </article>
  )
}

// Dispatches on the baked display kind (or the back-compat `brief` slot)
// to render whatever agent output the user had displayed at share-time.
// Single-agent runs (Art Director / Business Analyst / etc.) survive
// the snapshot the same way a multi-agent synthesis brief does.
function GroupReadout({ group }: { group: SharedGroupSnapshot }) {
  // Back-compat: shares minted before `display` was added carried only
  // a top-level `brief`. Treat it as a brief display.
  const display: SharedGroupSnapshot['display'] = group.display
    ? group.display
    : group.brief
      ? { kind: 'brief', data: group.brief }
      : undefined
  if (!display) {
    return (
      <p
        className="text-[13px] text-[var(--text-mute)] italic"
        style={{ marginTop: 12, lineHeight: 1.6 }}
      >
        This group hasn't been analysed — the summary block is empty.
      </p>
    )
  }
  return (
    <div className="mt-5" style={{ fontSize: 13.5, lineHeight: 1.65 }}>
      {display.kind === 'ad' && <ArtDirectorReadout data={display.data} />}
      {display.kind === 'sectioned' && <SectionedReadout data={display.data} />}
      {display.kind === 'video' && <VideoEditorReadout data={display.data} />}
      {display.kind === 'brief' && (
        <BriefReadout
          data={display.data}
          logoOverrideOptions={[]}
          onChangeLogos={() => undefined}
          onPatchBrief={() => undefined}
        />
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[10px] uppercase font-semibold text-[var(--text-faint)]"
      style={{ letterSpacing: '0.14em' }}
    >
      {children}
    </div>
  )
}

function EmptyDoc() {
  return (
    <div
      className="text-center text-[13px] text-[var(--text-mute)] italic"
      style={{ padding: '40px 0' }}
    >
      No groups on this board yet — drop two objects close together to form one.
    </div>
  )
}

function CenterMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground px-6">
      <div className="max-w-sm text-center">
        <h1 className="text-base font-semibold text-foreground">{title}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Source cards
// ---------------------------------------------------------------------------

function SourceGrid({ objects }: { objects: CanvasObject[] }) {
  if (objects.length === 0) {
    return <div className="text-[12.5px] text-[var(--text-faint)] italic">No sources captured.</div>
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 14,
      }}
    >
      {objects.map((o) => (
        <SourceCard key={o.id} object={o} />
      ))}
    </div>
  )
}

function SourceCard({ object }: { object: CanvasObject }) {
  const wrap: React.CSSProperties = {
    padding: 12,
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'var(--bg-card)',
    boxShadow: 'var(--shadow-card)',
    fontSize: 12,
    lineHeight: 1.45,
    color: 'var(--text)',
    minHeight: 0,
  }
  switch (object.type) {
    case 'image': {
      const d = object.data as ImageData
      return (
        <div style={wrap}>
          <img
            src={d.thumbnailUrl ?? d.url}
            alt=""
            loading="lazy"
            style={{
              width: '100%',
              height: 140,
              objectFit: 'cover',
              borderRadius: 'var(--radius)',
              backgroundColor: 'var(--bg-elevated)',
            }}
          />
        </div>
      )
    }
    case 'pdf': {
      const d = object.data as PDFData
      return (
        <div style={wrap}>
          {d.thumbnailUrl && (
            <img
              src={d.thumbnailUrl}
              alt="PDF first page"
              loading="lazy"
              style={{
                width: '100%',
                height: 160,
                objectFit: 'contain',
                borderRadius: 'var(--radius)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            />
          )}
          <div className="mt-2 flex items-center gap-1 text-[var(--text-mute)]">
            <span className="text-[10px] uppercase tracking-[0.1em] font-semibold">PDF</span>
            {d.pageCount && (
              <span className="text-[10px]">
                · {d.pageCount} page{d.pageCount > 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      )
    }
    case 'sticky': {
      const d = object.data as StickyData
      return (
        <div
          style={{
            ...wrap,
            backgroundColor: d.transparent ? 'var(--bg-card)' : d.color,
          }}
        >
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{d.text}</p>
        </div>
      )
    }
    case 'text': {
      const d = object.data as TextData
      return (
        <div style={wrap}>
          <p
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              fontFamily: d.font || 'inherit',
              fontSize: Math.min(d.fontSize, 18),
            }}
          >
            {d.text}
          </p>
        </div>
      )
    }
    case 'font': {
      const d = object.data as FontData
      return (
        <div style={wrap}>
          <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)] font-semibold">
            Font
          </div>
          <div
            className="mt-1 text-foreground"
            style={{ fontFamily: d.family, fontSize: 22, lineHeight: 1.2 }}
          >
            {d.sampleText && d.sampleText.length > 0 ? d.sampleText : d.family}
          </div>
        </div>
      )
    }
    case 'voice-note': {
      const d = object.data as VoiceNoteData
      return (
        <div style={wrap}>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)] font-semibold">
              Voice note
            </span>
            <span className="text-[10px] text-[var(--text-mute)]">· {d.durationSec}s</span>
          </div>
          <audio
            controls
            preload="none"
            src={d.url}
            style={{ width: '100%', marginTop: 6, height: 32 }}
          />
          {d.transcript && d.transcript.length > 0 && (
            <p
              className="text-[var(--text-soft)]"
              style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap' }}
            >
              {d.transcript}
            </p>
          )}
        </div>
      )
    }
    case 'output': {
      const d = object.data as OutputCardData
      return (
        <div style={wrap}>
          <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)] font-semibold">
            Design output
          </div>
          <div className="mt-1 text-foreground" style={{ fontSize: 14, fontWeight: 600 }}>
            {d.name}
          </div>
        </div>
      )
    }
    case 'video-clip': {
      const d = object.data as VideoClipData
      return (
        <a
          href={d.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...wrap, display: 'block', textDecoration: 'none', color: 'inherit' }}
        >
          {d.thumbnailUrl && (
            <img
              src={d.thumbnailUrl}
              alt={d.title}
              loading="lazy"
              style={{
                width: '100%',
                height: 130,
                objectFit: 'cover',
                borderRadius: 'var(--radius)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            />
          )}
          <div className="mt-2 flex items-baseline gap-1">
            <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)] font-semibold">
              {d.platform || 'Video'}
            </span>
            {d.durationSec > 0 && (
              <span className="text-[10px] text-[var(--text-mute)]">
                · {Math.floor(d.durationSec / 60)}:{String(d.durationSec % 60).padStart(2, '0')}
              </span>
            )}
          </div>
          <p
            className="mt-1 text-foreground font-medium"
            style={{ fontSize: 13, lineHeight: 1.3, margin: 0 }}
          >
            {d.title}
          </p>
          {d.channel && (
            <p className="text-[var(--text-mute)] mt-0.5" style={{ margin: 0 }}>
              {d.channel}
            </p>
          )}
        </a>
      )
    }
    case 'web-page': {
      const d = object.data as WebPageData
      return (
        <a
          href={d.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...wrap, display: 'block', textDecoration: 'none', color: 'inherit' }}
        >
          <div className="flex items-center gap-1.5">
            {d.faviconUrl && <img src={d.faviconUrl} alt="" style={{ width: 14, height: 14 }} />}
            <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)] font-semibold">
              {d.host}
            </span>
          </div>
          <p
            className="mt-2 text-foreground font-medium"
            style={{ fontSize: 13, lineHeight: 1.3, margin: 0 }}
          >
            {d.title}
          </p>
          {d.description && (
            <p
              className="mt-1 text-[var(--text-soft)]"
              style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45 }}
            >
              {d.description}
            </p>
          )}
        </a>
      )
    }
    case 'drive-file': {
      const d = object.data as DriveFileData
      return (
        <a
          href={d.webViewLink}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...wrap, display: 'block', textDecoration: 'none', color: 'inherit' }}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)] font-semibold">
              Drive
            </span>
          </div>
          <p
            className="mt-2 text-foreground font-medium"
            style={{ fontSize: 13, lineHeight: 1.3, margin: 0 }}
          >
            {d.name}
          </p>
        </a>
      )
    }
    case 'drive-folder': {
      const d = object.data as DriveFolderData
      return (
        <a
          href={d.webViewLink}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...wrap, display: 'block', textDecoration: 'none', color: 'inherit' }}
        >
          <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)] font-semibold">
            Drive folder
          </span>
          <p
            className="mt-2 text-foreground font-medium"
            style={{ fontSize: 13, lineHeight: 1.3, margin: 0 }}
          >
            {d.name}
          </p>
          <p className="text-[var(--text-mute)]" style={{ margin: '4px 0 0' }}>
            {d.childCount} item{d.childCount === 1 ? '' : 's'}
          </p>
        </a>
      )
    }
    case 'spotify-playlist':
    case 'spotify-track':
    case 'spotify-album': {
      const d = object.data as SpotifyPlaylistData | SpotifyTrackData | SpotifyAlbumData
      const cover =
        'coverUrl' in d
          ? d.coverUrl
          : 'albumCoverUrl' in d
            ? (d as SpotifyTrackData).albumCoverUrl
            : undefined
      const subtitle = 'ownerName' in d ? d.ownerName : 'artists' in d ? d.artists.join(', ') : ''
      return (
        <a
          href={d.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...wrap, display: 'block', textDecoration: 'none', color: 'inherit' }}
        >
          {cover && (
            <img
              src={cover}
              alt={d.name}
              loading="lazy"
              style={{
                width: '100%',
                aspectRatio: '1 / 1',
                objectFit: 'cover',
                borderRadius: 'var(--radius)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            />
          )}
          <span className="mt-2 inline-block text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)] font-semibold">
            Spotify
          </span>
          <p
            className="mt-1 text-foreground font-medium"
            style={{ fontSize: 13, lineHeight: 1.3, margin: 0 }}
          >
            {d.name}
          </p>
          {subtitle && (
            <p className="text-[var(--text-mute)] mt-0.5" style={{ margin: 0 }}>
              {subtitle}
            </p>
          )}
        </a>
      )
    }
    default:
      return null
  }
}
