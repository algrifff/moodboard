import {
  designVariantSchema,
  OUTPUT_FORMAT_LABELS,
  outputFormatSchema,
  outputThumbnailPath,
  type AgentToolPayload,
  type DesignProgress,
  type DesignRun,
  type DesignStage,
  type DesignVariant,
  type OutputFormat,
} from '@moodboard/shared'
import {
  ArrowSquareOut,
  CheckCircle,
  MagicWand,
  PaperPlaneTilt,
  Warning,
} from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { LinearLogo } from '@/components/canvas/sourceLogos'
import { chooseDesignVariant, getDesignRun, postDesignToLinear } from '@/lib/designApi'
import { AI_PANEL_DURATION, EASE_OUT_STANDARD, PALETTE_SWATCH_STAGGER } from '@/lib/motion'
import { useAgentSidebarStore } from '@/store/agentSidebar'

// design_output in the thread: live per-option progress while the designer
// works, then the options as cards with their rendered thumbnails. The
// person picks one here (or tells the agent), opens it to tweak, and — when
// the brief came from Linear — posts the pick back to the issue.

export const STAGE_LABEL: Record<DesignStage, string> = {
  queued: 'Waiting',
  script: 'Writing the script',
  outline: 'Planning the outline',
  template: 'Picking a template',
  assets: 'Searching the library',
  reference: 'Looking at the Figma reference',
  filling: 'Filling in copy and images',
  rendering: 'Rendering',
  critique: 'Looking at the render',
  revising: 'Revising',
  'render-queued': 'Queued the MP4 render',
  done: 'Done',
  cached: 'Reused from an earlier run',
  failed: 'Failed',
}

const ASPECT: Record<OutputFormat, string> = {
  thumbnail: '16 / 9',
  social: '1 / 1',
  deck: '16 / 9',
  landing: '16 / 10',
  'one-pager': '4 / 3',
  video: '16 / 9',
  other: '16 / 10',
}

const cardStyle = {
  borderRadius: 'var(--radius-lg)',
  backgroundColor: 'var(--bg)',
  boxShadow: '0 0 0 1px var(--border-soft)',
}

type Variant = DesignVariant & { thumbnailUrl?: string }

function parseFormat(raw: unknown): OutputFormat {
  const parsed = outputFormatSchema.safeParse(raw)
  return parsed.success ? parsed.data : 'other'
}

export function DesignRunCard({
  toolUseId,
  input,
  payload,
  running,
}: {
  toolUseId: string
  input: Record<string, unknown>
  payload: AgentToolPayload | null
  running: boolean
}) {
  const format = parseFormat(payload?.format ?? input.format)
  const brief = typeof input.brief === 'string' ? input.brief : ''
  const count = typeof input.variants === 'number' ? input.variants : 3
  const label = OUTPUT_FORMAT_LABELS[format].toLowerCase()

  if (!payload) {
    return (
      <div className="overflow-hidden text-[13px]" style={cardStyle}>
        <Header
          title={
            running
              ? `Designing ${count} ${label} option${count === 1 ? '' : 's'}…`
              : 'Design run interrupted'
          }
          shimmer={running}
        />
        {brief && <Brief text={brief} />}
        <LiveProgress toolUseId={toolUseId} running={running} format={format} />
      </div>
    )
  }
  return <Finished payload={payload} format={format} brief={brief} />
}

function Header({ title, shimmer, extra }: { title: string; shimmer?: boolean; extra?: string }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-2.5">
      <MagicWand size={14} weight="fill" className="shrink-0 text-[var(--accent)]" />
      <span className={`font-medium ${shimmer ? 'text-shimmer' : 'text-foreground'}`}>{title}</span>
      {extra && (
        <span
          className="text-[11px] text-[var(--text-faint)]"
          title="Same brief, kit, templates and library as an earlier run"
        >
          {extra}
        </span>
      )}
    </div>
  )
}

function Brief({ text }: { text: string }) {
  return (
    <p className="line-clamp-2 px-3 pt-1 text-[11.5px] leading-snug text-[var(--text-mute)]">
      {text}
    </p>
  )
}

function LiveProgress({
  toolUseId,
  running,
  format,
}: {
  toolUseId: string
  running: boolean
  format: OutputFormat
}) {
  const progress = useAgentSidebarStore((s) => s.toolProgress[toolUseId])
  const rows = Object.values(progress ?? {}).sort((a, b) => a.variant - b.variant)
  if (rows.length === 0) return <div className="h-2.5" />
  return (
    <ul className="flex flex-col gap-1.5 px-3 pb-3 pt-2.5">
      {rows.map((p) => (
        <ProgressRow key={p.variant} progress={p} running={running} format={format} />
      ))}
    </ul>
  )
}

function ProgressRow({
  progress: p,
  running,
  format,
}: {
  progress: DesignProgress
  running: boolean
  format: OutputFormat
}) {
  const seen =
    p.outputId && p.version && ['critique', 'revising', 'done', 'cached'].includes(p.stage)
  const finished = p.stage === 'done' || p.stage === 'cached' || p.stage === 'failed'
  return (
    <li className="flex items-center gap-2.5">
      <div
        className="h-9 w-16 shrink-0 overflow-hidden bg-[var(--bg-elevated)]"
        style={{ borderRadius: 'var(--radius)', aspectRatio: ASPECT[format] }}
      >
        {seen && (
          <img
            src={outputThumbnailPath(p.outputId!, p.version)}
            alt=""
            className="h-full w-full object-cover"
          />
        )}
      </div>
      <div className="min-w-0 flex-1 leading-snug">
        <div className="text-[12px] font-medium text-foreground">Option {p.variant}</div>
        <div
          className={`truncate text-[11.5px] ${
            p.stage === 'failed'
              ? 'text-[var(--danger)]'
              : running && !finished
                ? 'text-shimmer'
                : 'text-[var(--text-mute)]'
          }`}
        >
          {STAGE_LABEL[p.stage]}
          {p.detail ? ` · ${p.detail}` : ''}
        </div>
      </div>
    </li>
  )
}

function Finished({
  payload,
  format,
  brief,
}: {
  payload: AgentToolPayload
  format: OutputFormat
  brief: string
}) {
  const runId = typeof payload.runId === 'string' ? payload.runId : null
  const variants: Variant[] = (Array.isArray(payload.variants) ? payload.variants : []).flatMap(
    (v) => {
      const parsed = designVariantSchema.safeParse(v)
      if (!parsed.success) return []
      const thumb = (v as { thumbnailUrl?: unknown }).thumbnailUrl
      return [{ ...parsed.data, thumbnailUrl: typeof thumb === 'string' ? thumb : undefined }]
    },
  )
  const issue = typeof payload.linearIssue === 'string' ? payload.linearIssue : null
  const [run, setRun] = useState<DesignRun | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!runId) return
    let live = true
    getDesignRun(runId)
      .then((r) => live && setRun(r))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [runId])

  const chosen = run?.chosenOutputId ?? null
  const pick = async (outputId: string) => {
    if (!runId || busy) return
    setBusy(outputId)
    setError(null)
    try {
      setRun(await chooseDesignVariant(runId, outputId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const post = async () => {
    if (!runId || busy) return
    setBusy('post')
    setError(null)
    try {
      const posted = await postDesignToLinear(runId)
      if (posted.run) setRun(posted.run)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="overflow-hidden text-[13px]" style={cardStyle}>
      <Header title={payload.summary} extra={payload.cached === true ? 'reused' : undefined} />
      {brief && <Brief text={brief} />}
      <ul className="flex flex-col gap-2.5 px-3 pb-3 pt-2.5">
        {variants.map((v, i) => (
          <motion.li
            key={v.index}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: AI_PANEL_DURATION,
              ease: EASE_OUT_STANDARD,
              delay: i * PALETTE_SWATCH_STAGGER * 2,
            }}
          >
            {v.status === 'done' && v.outputId ? (
              <OptionCard
                variant={v}
                format={format}
                chosen={chosen === v.outputId}
                canPick={!!runId}
                busy={busy === v.outputId}
                onPick={() => void pick(v.outputId!)}
              />
            ) : (
              <div className="flex items-start gap-2 text-[12px] text-[var(--text-mute)]">
                <Warning
                  size={13}
                  weight="fill"
                  className="mt-[2px] shrink-0 text-[var(--warning)]"
                />
                <span>
                  Option {v.index} ({v.angle}) failed{v.error ? `: ${v.error}` : ''}
                </span>
              </div>
            )}
          </motion.li>
        ))}
      </ul>
      {issue && (
        <div className="flex items-center gap-2 border-t border-[var(--border-soft)] px-3 py-2 text-[12px]">
          <LinearLogo size={13} />
          {run?.linearCommentUrl ? (
            <a
              href={run.linearCommentUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-[var(--accent)] hover:brightness-110"
            >
              Posted to {issue}
              <ArrowSquareOut size={12} weight="bold" />
            </a>
          ) : chosen ? (
            <button
              type="button"
              onClick={() => void post()}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 font-medium text-[var(--accent)] hover:brightness-110 disabled:opacity-50"
            >
              <PaperPlaneTilt size={13} weight="bold" />
              {busy === 'post' ? 'Posting…' : `Post the pick to ${issue}`}
            </button>
          ) : (
            <span className="text-[var(--text-mute)]">Pick one to post it to {issue}</span>
          )}
        </div>
      )}
      {error && (
        <div className="flex items-start gap-1.5 px-3 pb-2.5 text-[12px] text-[var(--danger)]">
          <Warning size={13} className="mt-[1px] shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}

function OptionCard({
  variant: v,
  format,
  chosen,
  canPick,
  busy,
  onPick,
}: {
  variant: Variant
  format: OutputFormat
  chosen: boolean
  canPick: boolean
  busy: boolean
  onPick: () => void
}) {
  const [broken, setBroken] = useState(false)
  const src = v.thumbnailUrl ?? outputThumbnailPath(v.outputId!, v.version ?? undefined)
  return (
    <div
      className="overflow-hidden"
      style={{
        borderRadius: 'var(--radius-lg)',
        backgroundColor: 'var(--bg-elevated)',
        boxShadow: chosen ? '0 0 0 1.5px var(--accent)' : '0 0 0 1px var(--border-soft)',
      }}
    >
      <a
        href={`/outputs/${v.outputId}`}
        target="_blank"
        rel="noreferrer"
        className="block bg-[var(--bg-muted)]"
        style={{ aspectRatio: ASPECT[format] }}
        title={`Open ${v.name}`}
      >
        {!broken && (
          <img
            src={src}
            alt={`${v.name} — rendered`}
            loading="lazy"
            onError={() => setBroken(true)}
            className="h-full w-full object-contain"
          />
        )}
      </a>
      <div className="px-2.5 pb-2.5 pt-2">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate font-medium text-foreground">{v.name}</span>
          <span className="shrink-0 text-[11px] text-[var(--text-faint)]">
            {v.angle}
            {v.template ? ` · ${v.template}` : ''}
          </span>
        </div>
        {v.critique && (
          <p className="mt-1 line-clamp-3 text-[12px] leading-snug text-[var(--text-soft)]">
            {v.critique}
          </p>
        )}
        <div className="mt-2 flex items-center gap-3">
          {chosen ? (
            <span className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent)]">
              <CheckCircle size={14} weight="fill" />
              Picked
            </span>
          ) : (
            <button
              type="button"
              onClick={onPick}
              disabled={!canPick || busy}
              className="inline-flex h-6 items-center bg-primary px-2.5 text-[12px] font-medium text-primary-foreground hover:brightness-110 disabled:opacity-50 transition-[filter,opacity]"
              style={{ borderRadius: 'var(--radius)' }}
            >
              {busy ? 'Picking…' : 'Pick this one'}
            </button>
          )}
          <a
            href={`/outputs/${v.outputId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12px] text-[var(--text-mute)] hover:text-foreground transition-colors"
          >
            <ArrowSquareOut size={12} weight="bold" />
            Open to tweak
          </a>
          {v.cached && <span className="ml-auto text-[11px] text-[var(--text-faint)]">cached</span>}
        </div>
      </div>
    </div>
  )
}
