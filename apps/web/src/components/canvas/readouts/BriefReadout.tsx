import type { SynthesisBrief } from '@moodboard/shared'
import {
  FontsBlock,
  LogoBlock,
  PaletteBlock,
  ThroughlineBlock,
  TypographyBlock,
} from './briefIdentityBlocks'
import {
  AudienceBlock,
  BodyCopyBlock,
  ChannelBlock,
  HooksBlock,
  NotesBlock,
  PositioningBlock,
  ReferencesBlock,
  StatementsBlock,
  TensionsBlock,
  VideoDirectionBlock,
  WatchForsBlock,
} from './briefStrategyBlocks'

// ---------------------------------------------------------------------------
// Brief renderer — the synthesiser's structured output rendered as a
// presentation-style layout. Every block self-skips when its data is empty
// so a 2-agent synthesis doesn't drag empty sections through the page.
// ---------------------------------------------------------------------------

export function BriefReadout({
  data,
  logoOverrideOptions,
  onChangeLogos,
  onPatchBrief,
}: {
  data: SynthesisBrief
  logoOverrideOptions: { url: string }[]
  onChangeLogos: (urls: string[]) => void
  onPatchBrief: (brief: SynthesisBrief) => void
}) {
  // Convenience wrapper — each block hands us its new slice of the brief
  // and we splice it onto the rest. Pass these into each block's
  // onChange prop.
  const patch =
    <K extends keyof SynthesisBrief>(key: K) =>
    (value: SynthesisBrief[K]) =>
      onPatchBrief({ ...data, [key]: value })
  const hasPositioning =
    data.positioning.model.trim().length > 0 ||
    data.positioning.niche.trim().length > 0 ||
    data.positioning.category.trim().length > 0
  return (
    <div className="space-y-5">
      {data.throughline.trim().length > 0 && (
        <ThroughlineBlock
          text={data.throughline}
          source={data.throughlineSource}
          onChange={patch('throughline')}
        />
      )}
      {hasPositioning && (
        <PositioningBlock data={data.positioning} onChange={patch('positioning')} />
      )}
      {data.logo.length > 0 && (
        <LogoBlock
          logos={data.logo}
          overrideOptions={logoOverrideOptions}
          onChange={onChangeLogos}
          onChangeReason={(i, reason) =>
            patch('logo')(data.logo.map((l, j) => (j === i ? { ...l, reason } : l)))
          }
        />
      )}
      {data.palette.length > 0 && <PaletteBlock items={data.palette} onChange={patch('palette')} />}
      {data.typography.feel.trim().length > 0 && (
        <TypographyBlock
          feel={data.typography.feel}
          onChange={(feel) => patch('typography')({ feel })}
        />
      )}
      {data.fonts.length > 0 && <FontsBlock items={data.fonts} onChange={patch('fonts')} />}
      {data.references.length > 0 && (
        <ReferencesBlock items={data.references} onChange={patch('references')} />
      )}
      {data.tensions.length > 0 && (
        <TensionsBlock items={data.tensions} onChange={patch('tensions')} />
      )}
      {data.audiences.length > 0 && (
        <AudienceBlock items={data.audiences} onChange={patch('audiences')} />
      )}
      {data.channels.length > 0 && (
        <ChannelBlock items={data.channels} onChange={patch('channels')} />
      )}
      {(data.video.hooks.length > 0 ||
        data.video.transitions.length > 0 ||
        data.video.pacing.trim().length > 0) && (
        <VideoDirectionBlock data={data.video} onChange={patch('video')} />
      )}
      {data.hooks.length > 0 && <HooksBlock items={data.hooks} onChange={patch('hooks')} />}
      {data.bodyCopy.trim().length > 0 && (
        <BodyCopyBlock text={data.bodyCopy} onChange={patch('bodyCopy')} />
      )}
      {data.statements.length > 0 && (
        <StatementsBlock items={data.statements} onChange={patch('statements')} />
      )}
      {data.watchFors.length > 0 && (
        <WatchForsBlock items={data.watchFors} onChange={patch('watchFors')} />
      )}
      {data.notes.length > 0 && <NotesBlock items={data.notes} onChange={patch('notes')} />}
    </div>
  )
}

// Glance — collapsed snapshot. Throughline + a thin palette row if present.
export function BriefGlance({ data }: { data: SynthesisBrief }) {
  return (
    <div className="space-y-2">
      {data.throughline.trim().length > 0 && (
        <div
          className="font-medium text-foreground"
          style={{
            fontFamily: 'ui-serif, Georgia, "Iowan Old Style", serif',
            fontSize: 15,
            lineHeight: 1.4,
          }}
        >
          {data.throughline}
        </div>
      )}
      {data.palette.length > 0 && (
        <div className="flex items-center gap-1.5">
          {data.palette.slice(0, 6).map((p, i) => (
            <span
              key={`${p.hex}-${i}`}
              title={`${p.hex.toUpperCase()} — ${p.role}`}
              style={{
                display: 'inline-block',
                width: 18,
                height: 18,
                borderRadius: 'var(--radius)',
                backgroundColor: p.hex,
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)',
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
