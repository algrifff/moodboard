import type {
  AgentToolPayload,
  AgentToolResultBlock,
  AgentToolUseBlock,
  AIAnalysis,
  SectionedParagraphs,
  SynthesisBrief,
  VideoEditorBreakdown,
} from '@moodboard/shared'
import {
  ArrowsOutCardinal,
  ArrowSquareOut,
  BoundingBox,
  Buildings,
  CheckCircle,
  Code,
  FilmSlate,
  Crosshair,
  Eye,
  Images,
  Palette,
  Swatches,
  Image as ImageIcon,
  Layout,
  PencilSimple,
  LinkSimple,
  MagicWand,
  NoteBlank,
  PaperPlaneTilt,
  Sparkle,
  TextT,
  Warning,
  Wrench,
  type Icon,
} from '@phosphor-icons/react'
import { AGENT_META } from '@/components/canvas/AgentRow'
import { DesignRunCard } from './DesignRunCard'
import { RenderJobCard, VideoRunCard } from './VideoCards'
import { AssetsToolCard, KitToolCard, OutputToolCard } from './DesignToolCards'
import { ArtDirectorGlance } from '@/components/canvas/readouts/ArtDirectorReadout'
import { BriefGlance } from '@/components/canvas/readouts/BriefReadout'
import { SectionedGlance } from '@/components/canvas/readouts/SectionedReadout'
import { VideoEditorGlance } from '@/components/canvas/readouts/VideoEditorReadout'
import { focusObjects } from '@/lib/canvasCamera'
import { toolPayload, useAgentSidebarStore } from '@/store/agentSidebar'

const TOOL_META: Record<string, { icon: Icon; running: string }> = {
  get_board: { icon: Eye, running: 'Reading the board' },
  add_note: { icon: NoteBlank, running: 'Adding a note' },
  add_text: { icon: TextT, running: 'Adding text' },
  add_url: { icon: LinkSimple, running: 'Importing a link' },
  add_image: { icon: ImageIcon, running: 'Importing an image' },
  move_objects: { icon: ArrowsOutCardinal, running: 'Moving items' },
  group_objects: { icon: BoundingBox, running: 'Pulling items into a group' },
  analyze_group: { icon: Sparkle, running: 'Running specialists' },
  list_clients: { icon: Buildings, running: 'Looking up clients' },
  list_kits: { icon: Swatches, running: 'Looking up style kits' },
  get_style_kit: { icon: Palette, running: 'Reading the style kit' },
  search_assets: { icon: Images, running: 'Searching the asset library' },
  get_linear_issue: { icon: LinkSimple, running: 'Reading the Linear issue' },
  list_templates: { icon: Layout, running: 'Looking up templates' },
  create_output: { icon: Layout, running: 'Creating an output' },
  get_output: { icon: Layout, running: 'Reading the output' },
  update_output_slots: { icon: PencilSimple, running: 'Editing the output' },
  update_output_html: { icon: Code, running: 'Editing the output’s HTML' },
  place_output_on_board: { icon: Layout, running: 'Placing the output' },
  add_asset_to_board: { icon: Images, running: 'Adding an asset to the board' },
  design_output: { icon: MagicWand, running: 'Designing' },
  design_video: { icon: FilmSlate, running: 'Making a film' },
  render_video: { icon: FilmSlate, running: 'Queuing the render' },
  get_render_job: { icon: FilmSlate, running: 'Checking the render' },
  pick_design_variant: { icon: CheckCircle, running: 'Picking the option' },
  post_linear_comment: { icon: PaperPlaneTilt, running: 'Posting to Linear' },
}

// Consecutive successful adds of one kind fold into one card.
const PLURAL: Record<string, (n: number) => string> = {
  add_note: (n) => `Added ${n} notes`,
  add_text: (n) => `Added ${n} text items`,
  add_url: (n) => `Added ${n} links`,
  add_image: (n) => `Added ${n} images`,
}

export type ToolCall = { use: AgentToolUseBlock; result: AgentToolResultBlock | undefined }

// Splits an assistant turn's tool calls into cards, folding runs of the
// same add_* tool together.
export function foldToolCalls(calls: ToolCall[]): ToolCall[][] {
  const out: ToolCall[][] = []
  for (const call of calls) {
    const last = out.at(-1)
    const prev = last?.[0]
    const foldable =
      prev &&
      PLURAL[call.use.name] &&
      prev.use.name === call.use.name &&
      call.result &&
      !call.result.is_error &&
      prev.result &&
      !prev.result.is_error
    if (last && foldable) last.push(call)
    else out.push([call])
  }
  return out
}

export function AgentToolCard({ calls, running }: { calls: ToolCall[]; running: boolean }) {
  const first = calls[0]!
  const meta = TOOL_META[first.use.name] ?? { icon: Wrench, running: first.use.name }
  const IconCmp = meta.icon

  if (first.use.name === 'design_output' && !first.result?.is_error) {
    return (
      <DesignRunCard
        toolUseId={first.use.id}
        input={first.use.input}
        payload={first.result ? toolPayload(first.result.content) : null}
        running={running}
      />
    )
  }

  if (first.use.name === 'design_video' && !first.result?.is_error) {
    return (
      <VideoRunCard
        toolUseId={first.use.id}
        input={first.use.input}
        payload={first.result ? toolPayload(first.result.content) : null}
        running={running}
      />
    )
  }

  if (!first.result) {
    return (
      <CardRow icon={IconCmp}>
        <span className={running ? 'text-shimmer' : 'text-[var(--text-mute)]'}>
          {running ? `${meta.running}…` : `${meta.running} — interrupted`}
        </span>
      </CardRow>
    )
  }

  if (first.result.is_error) {
    return (
      <CardRow icon={Warning} tone="danger">
        <span className="text-[var(--text-soft)]">{first.result.content}</span>
      </CardRow>
    )
  }

  const payloads = calls.flatMap((c) => {
    const p = c.result ? toolPayload(c.result.content) : null
    return p ? [p] : []
  })
  const payload = payloads[0]
  if (!payload) return null
  const objectIds = [...new Set(payloads.flatMap((p) => p.objectIds ?? []))]
  const title =
    calls.length > 1 && PLURAL[first.use.name]
      ? PLURAL[first.use.name]!(calls.length)
      : payload.summary

  if (first.use.name === 'get_style_kit' && payload.kit) {
    return <KitToolCard payload={payload} title={title} />
  }
  if (
    (first.use.name === 'create_output' ||
      first.use.name === 'update_output_slots' ||
      first.use.name === 'update_output_html' ||
      first.use.name === 'get_output') &&
    payload.output
  ) {
    return <OutputToolCard payload={payload} title={title} />
  }
  if (
    (first.use.name === 'render_video' || first.use.name === 'get_render_job') &&
    payload.job !== undefined
  ) {
    return <RenderJobCard payload={payload} />
  }
  if (first.use.name === 'search_assets') {
    return <AssetsToolCard payload={payload} title={title} />
  }

  if (first.use.name === 'post_linear_comment' && typeof payload.commentUrl === 'string') {
    return (
      <CardRow
        icon={IconCmp}
        action={
          <a
            href={payload.commentUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-[var(--text-mute)] hover:text-foreground transition-colors"
          >
            <ArrowSquareOut size={12} weight="bold" />
            Open
          </a>
        }
      >
        <span className="text-foreground">{title}</span>
      </CardRow>
    )
  }

  if (first.use.name === 'analyze_group' && payload.display) {
    return <AnalysisCard payload={payload} title={title} objectIds={objectIds} />
  }

  return (
    <CardRow icon={IconCmp} action={objectIds.length > 0 ? <JumpButton ids={objectIds} /> : null}>
      <span
        className={first.use.name === 'get_board' ? 'text-[var(--text-mute)]' : 'text-foreground'}
      >
        {title}
      </span>
    </CardRow>
  )
}

function CardRow({
  icon: IconCmp,
  tone,
  action,
  children,
}: {
  icon: Icon
  tone?: 'danger'
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div
      className="flex items-start gap-2 px-2.5 py-2 text-[12.5px] leading-snug"
      style={{
        borderRadius: 'var(--radius-lg)',
        backgroundColor: 'var(--bg-elevated)',
      }}
    >
      <IconCmp
        size={14}
        weight={tone === 'danger' ? 'fill' : 'regular'}
        className={`mt-[1px] shrink-0 ${tone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--accent)]'}`}
      />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action}
    </div>
  )
}

function JumpButton({ ids, label }: { ids: string[]; label?: string }) {
  return (
    <button
      type="button"
      onClick={() => focusObjects(ids)}
      className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-[var(--text-mute)] hover:text-foreground transition-colors"
      title="Jump to on canvas"
    >
      <Crosshair size={12} weight="bold" />
      {label ?? 'Jump'}
    </button>
  )
}

function AnalysisCard({
  payload,
  title,
  objectIds,
}: {
  payload: AgentToolPayload
  title: string
  objectIds: string[]
}) {
  const openGroup = useAgentSidebarStore((s) => s.openGroup)
  const display = payload.display!
  const agents = Array.isArray(payload.agents) ? (payload.agents as string[]) : []
  const agentLabels = agents
    .map((id) => AGENT_META[id as keyof typeof AGENT_META]?.label ?? id)
    .join(' + ')
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
        <Sparkle size={14} weight="fill" className="shrink-0 text-[var(--accent)]" />
        <span className="font-medium text-foreground">{title}</span>
        {payload.cached === true && (
          <span className="text-[11px] text-[var(--text-faint)]" title="Served from the cache">
            cached
          </span>
        )}
      </div>
      {agentLabels && (
        <div className="px-3 pt-0.5 text-[11.5px] text-[var(--text-mute)]">{agentLabels}</div>
      )}
      <div className="px-3 py-3">
        {display.kind === 'brief' && <BriefGlance data={display.data as SynthesisBrief} />}
        {display.kind === 'ad' && <ArtDirectorGlance data={display.data as AIAnalysis} />}
        {display.kind === 'sectioned' && (
          <SectionedGlance data={display.data as SectionedParagraphs} />
        )}
        {display.kind === 'video' && (
          <VideoEditorGlance data={display.data as VideoEditorBreakdown} />
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-[var(--border-soft)] px-3 py-2">
        {payload.groupKey && (
          <button
            type="button"
            onClick={() => openGroup(payload.groupKey!)}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent)] hover:brightness-110"
          >
            <ArrowSquareOut size={13} weight="bold" />
            Open {display.kind === 'brief' ? 'brief' : 'read'}
          </button>
        )}
        <div className="flex-1" />
        {objectIds.length > 0 && <JumpButton ids={objectIds} label="Jump to on canvas" />}
      </div>
    </div>
  )
}
