import {
  kitTokensSchema,
  outputRenderPath,
  templateViewportSchema,
  type AgentToolPayload,
  type TemplateViewport,
} from '@moodboard/shared'
import { ArrowSquareOut, Palette, Images, Layout } from '@phosphor-icons/react'
import { OutputFrame } from '@/components/outputs/OutputFrame'
import { AssetThumb } from '@/components/library/AssetThumb'

// Cards for the kit, asset and output tools: enough of the result to see what the
// agent is working from, with a link to the full page.

type KitRef = { id: string; name: string; client: string; version: number }

export function KitToolCard({ payload, title }: { payload: AgentToolPayload; title: string }) {
  const kit = payload.kit as KitRef | undefined
  const tokens = kitTokensSchema.safeParse(payload.tokens)
  const t = tokens.success ? tokens.data : null
  const fonts = t
    ? [t.fonts.display, t.fonts.body, t.fonts.mono].flatMap((f) => (f ? [f.family] : []))
    : []
  return (
    <div
      className="overflow-hidden text-[13px]"
      style={{
        borderRadius: 'var(--radius-lg)',
        backgroundColor: 'var(--bg)',
        boxShadow: '0 0 0 1px var(--border-soft)',
      }}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <Palette size={14} weight="fill" className="shrink-0 text-[var(--accent)]" />
        <span className="font-medium text-foreground">{title}</span>
      </div>
      {t && (
        <div className="px-3 pb-3 pt-2">
          {t.palette.length > 0 && (
            <div className="flex h-7 overflow-hidden" style={{ borderRadius: 'var(--radius)' }}>
              {t.palette.map((c) => (
                <div
                  key={`${c.role}-${c.hex}`}
                  className="flex-1"
                  style={{ backgroundColor: c.hex }}
                  title={`${c.role} ${c.hex}`}
                />
              ))}
            </div>
          )}
          {fonts.length > 0 && (
            <p className="mt-2 text-[12px] text-[var(--text-mute)]">{fonts.join(' · ')}</p>
          )}
          {t.summary && <p className="mt-1 text-[12.5px] text-[var(--text-soft)]">{t.summary}</p>}
        </div>
      )}
      {kit && (
        <div className="border-t border-[var(--border-soft)] px-3 py-2">
          <a
            href={`/kits/${kit.id}?version=${kit.version}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent)] hover:brightness-110"
          >
            <ArrowSquareOut size={13} weight="bold" />
            Open kit
          </a>
        </div>
      )}
    </div>
  )
}

type AssetRef = {
  id: string
  name: string
  kind: 'image' | 'pdf' | 'font' | 'audio' | 'other'
  thumbnailUrl: string | null
}

export function AssetsToolCard({ payload, title }: { payload: AgentToolPayload; title: string }) {
  const assets = (Array.isArray(payload.assets) ? payload.assets : []) as AssetRef[]
  return (
    <div
      className="overflow-hidden text-[13px]"
      style={{
        borderRadius: 'var(--radius-lg)',
        backgroundColor: 'var(--bg)',
        boxShadow: '0 0 0 1px var(--border-soft)',
      }}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <Images size={14} weight="fill" className="shrink-0 text-[var(--accent)]" />
        <span className="font-medium text-foreground">{title}</span>
      </div>
      {assets.length > 0 && (
        <ul className="grid grid-cols-6 gap-1 px-3 pb-3 pt-2">
          {assets.slice(0, 12).map((a) => (
            <li
              key={a.id}
              className="aspect-square overflow-hidden bg-[var(--bg-elevated)]"
              style={{ borderRadius: 'var(--radius)' }}
              title={a.name}
            >
              <AssetThumb asset={a} />
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-[var(--border-soft)] px-3 py-2">
        <a
          href="/library"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent)] hover:brightness-110"
        >
          <ArrowSquareOut size={13} weight="bold" />
          Open the library
        </a>
      </div>
    </div>
  )
}

type OutputRef = { id: string; name: string; version: number; viewport?: TemplateViewport }

// create_output / update_output_slots / get_output: the document itself,
// small, with a link to the output view.
export function OutputToolCard({ payload, title }: { payload: AgentToolPayload; title: string }) {
  const output = payload.output as OutputRef
  const frame = templateViewportSchema.safeParse(output.viewport)
  const version = typeof payload.version === 'number' ? payload.version : output.version
  return (
    <div
      className="overflow-hidden text-[13px]"
      style={{
        borderRadius: 'var(--radius-lg)',
        backgroundColor: 'var(--bg)',
        boxShadow: '0 0 0 1px var(--border-soft)',
      }}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <Layout size={14} weight="fill" className="shrink-0 text-[var(--accent)]" />
        <span className="font-medium text-foreground">{title}</span>
      </div>
      <div className="px-3 pb-3 pt-2">
        <OutputFrame
          src={outputRenderPath(output.id, { version })}
          viewport={frame.success ? frame.data : { kind: 'responsive' }}
          title={output.name}
          className="aspect-[16/10] w-full bg-[var(--bg-elevated)]"
          shadow={false}
        />
      </div>
      <div className="border-t border-[var(--border-soft)] px-3 py-2">
        <a
          href={`/outputs/${output.id}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent)] hover:brightness-110"
        >
          <ArrowSquareOut size={13} weight="bold" />
          Open output
        </a>
      </div>
    </div>
  )
}
