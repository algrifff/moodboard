import type { VideoClipBreakdown, VideoEditorBreakdown } from '@moodboard/shared'

// Senior Video Editor — one timestamped craft breakdown per clip in the group.
// Each video is watched + cached individually, so a group of clips renders a
// stacked section per clip. Empty group → the agent's `note` hint.
export function VideoEditorReadout({ data }: { data: VideoEditorBreakdown }) {
  if (data.clips.length === 0) {
    return (
      <div className="text-[12.5px] text-[var(--text-mute)] italic" style={{ lineHeight: 1.5 }}>
        {data.note ?? 'Group this agent with a video clip and it will break it down.'}
      </div>
    )
  }
  const multi = data.clips.length > 1
  return (
    <div className="space-y-5">
      {data.clips.map((clip, i) => (
        <div
          key={`${clip.videoId}-${i}`}
          className={i > 0 ? 'space-y-2 border-t border-[var(--border-soft)] pt-4' : 'space-y-2'}
        >
          {multi && <ClipHeader clip={clip} index={i} total={data.clips.length} />}
          <ClipBreakdownBody clip={clip} />
        </div>
      ))}
      {data.skipped ? (
        <div className="text-[11.5px] text-[var(--text-faint)] italic" style={{ lineHeight: 1.5 }}>
          {data.skipped} more clip{data.skipped > 1 ? 's' : ''} in this group{' '}
          {data.skipped > 1 ? "weren't" : "wasn't"} analysed (max {data.clips.length} per group) —
          put {data.skipped > 1 ? 'them' : 'it'} in a separate group to break{' '}
          {data.skipped > 1 ? 'them' : 'it'} down.
        </div>
      ) : null}
    </div>
  )
}

// Clip title row for multi-clip groups — index, title, platform tag.
function ClipHeader({
  clip,
  index,
  total,
}: {
  clip: VideoClipBreakdown
  index: number
  total: number
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] tabular-nums text-[var(--text-faint)] font-semibold flex-shrink-0">
        {index + 1}/{total}
      </span>
      <span className="text-[12.5px] font-semibold text-foreground truncate">
        {clip.title || 'Untitled clip'}
      </span>
      {clip.platform && clip.platform !== 'other' && (
        <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)] flex-shrink-0">
          {clip.platform}
        </span>
      )}
    </div>
  )
}

// One clip's breakdown body. When the clip couldn't be analysed (unsupported /
// download failure / no key) `unavailableReason` is set and arrays are empty.
function ClipBreakdownBody({ clip }: { clip: VideoClipBreakdown }) {
  if (clip.unavailableReason) {
    return (
      <div className="text-[12.5px] text-[var(--text-mute)] italic" style={{ lineHeight: 1.5 }}>
        {clip.unavailableReason}
      </div>
    )
  }
  return (
    <div className="space-y-3.5">
      {clip.summary && (
        <p className="text-[12.5px] text-[var(--text-soft)]" style={{ lineHeight: 1.55 }}>
          {clip.summary}
        </p>
      )}

      <VideoSection heading="Hooks">
        {clip.hooks.map((h, i) => (
          <div key={i} className="space-y-0.5">
            <div className="flex items-baseline gap-2">
              <Stamp>{h.timestamp}</Stamp>
              <span className="text-[12.5px] font-medium text-foreground">{h.what}</span>
            </div>
            <div className="text-[12px] text-[var(--text-soft)]" style={{ lineHeight: 1.5 }}>
              <span className="text-[var(--text-faint)]">Why it works — </span>
              {h.whyItWorks}
            </div>
            <div className="text-[12px] text-[var(--text-soft)]" style={{ lineHeight: 1.5 }}>
              <span className="text-[var(--text-faint)]">Replicate — </span>
              {h.howToReplicate}
            </div>
          </div>
        ))}
      </VideoSection>

      <VideoSection heading="Transitions">
        {clip.transitions.map((t, i) => (
          <div key={i} className="flex items-baseline gap-2">
            <Stamp>{t.timestamp}</Stamp>
            <span className="text-[12.5px] text-[var(--text-soft)]" style={{ lineHeight: 1.5 }}>
              <span className="font-medium text-foreground">{t.type}</span> — {t.description}
            </span>
          </div>
        ))}
      </VideoSection>

      <VideoSection heading="Sound design">
        {clip.soundDesign.map((s, i) => (
          <div key={i} className="flex items-baseline gap-2">
            <Stamp>{s.timestamp}</Stamp>
            <span className="text-[12.5px] text-[var(--text-soft)]" style={{ lineHeight: 1.5 }}>
              <span className="font-medium text-foreground">{s.element}</span> — {s.effect}
            </span>
          </div>
        ))}
      </VideoSection>

      <VideoSection heading="What's said">
        {clip.spokenBeats.map((s, i) => (
          <div key={i} className="space-y-0.5">
            <div className="flex items-baseline gap-2">
              <Stamp>{s.timestamp}</Stamp>
              <span className="text-[12.5px] text-foreground" style={{ lineHeight: 1.5 }}>
                “{s.quote}”
              </span>
            </div>
            <div className="text-[12px] text-[var(--text-faint)]" style={{ lineHeight: 1.5 }}>
              {s.delivery}
            </div>
          </div>
        ))}
      </VideoSection>

      {clip.pacing && (
        <div>
          <VideoHeading>Pacing</VideoHeading>
          <p className="mt-1 text-[12.5px] text-[var(--text-soft)]" style={{ lineHeight: 1.55 }}>
            {clip.pacing}
          </p>
        </div>
      )}

      {clip.replicationPlaybook.length > 0 && (
        <div>
          <VideoHeading>Replication playbook</VideoHeading>
          <ol className="mt-1.5 space-y-1.5">
            {clip.replicationPlaybook.map((step, i) => (
              <li key={i} className="flex gap-2 text-[12.5px] text-[var(--text-soft)]">
                <span className="text-[var(--text-faint)] tabular-nums">{i + 1}.</span>
                <span style={{ lineHeight: 1.5 }}>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}

function VideoSection({ heading, children }: { heading: string; children: React.ReactNode[] }) {
  if (!children || children.length === 0) return null
  return (
    <div>
      <VideoHeading>{heading}</VideoHeading>
      <div className="mt-1.5 space-y-2">{children}</div>
    </div>
  )
}

export function VideoHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)] font-semibold">
      {children}
    </div>
  )
}

export function Stamp({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-[10px] font-medium tabular-nums flex-shrink-0"
      style={{
        color: 'var(--accent-foreground)',
        backgroundColor: 'var(--accent-soft)',
        padding: '1px 5px',
        borderRadius: 4,
      }}
    >
      {children}
    </span>
  )
}

export function VideoEditorGlance({ data }: { data: VideoEditorBreakdown }) {
  if (data.clips.length === 0) {
    return (
      <div className="text-[12px] text-[var(--text-faint)] italic">
        {data.note ?? 'No clips to break down yet.'}
      </div>
    )
  }
  const analysed = data.clips.filter((c) => !c.unavailableReason)
  const totalHooks = analysed.reduce((n, c) => n + c.hooks.length, 0)
  const first = analysed[0]
  const firstHook = first?.hooks[0]
  const lead = firstHook?.what ?? first?.summary ?? data.clips[0]?.unavailableReason ?? ''
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-faint)] font-semibold">
        {data.clips.length} clip{data.clips.length > 1 ? 's' : ''} · {totalHooks} hook
        {totalHooks === 1 ? '' : 's'}
      </div>
      <p className="text-[12.5px] text-[var(--text-soft)] line-clamp-2" style={{ lineHeight: 1.5 }}>
        {lead}
      </p>
    </div>
  )
}
