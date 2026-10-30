import {
  matchNamed,
  OUTPUT_FORMAT_LABELS,
  outputThumbnailPath,
  type Client,
  type KitSummary,
  type OutputFormat,
  type TemplateSummary,
} from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { searchAssets } from './assetLibrary'
import type { ToolContext, ToolOutcome } from './canvasTools'
import { getClient, listClients } from './clients'
import { runDesign, type DesignAsset, type DesignContext } from './designer'
import { DESIGNER_MODEL_TAG, designCacheKey } from './designHash'
import {
  chooseDesignVariant,
  clientAssetIds,
  createDesignRun,
  dbDesignCache,
  getDesignRun,
  postToLinear,
  runForOutput,
  setRunVariants,
} from './designRuns'
import { designToolbox } from './designToolbox'
import { getKitDetail, listKits } from './kits'
import { LinearApiError, parseIssueRef } from './linear'
import { LinearUnavailableError } from './linearConnection'
import { figmaReferenceKey, resolveFigmaReferences, type FigmaReference } from './figmaTools'
import { defaultModelClient } from './orchestrator'
import { getOutputSummary } from './outputs'
import { outputRef, outputUrl, resolveOutput } from './outputTools'
import { listTemplates } from './templates'

// Bodies of design_output (the designer agent), pick_design_variant and
// post_linear_comment. Registered in canvasTools.ts (CANVAS_TOOLS).

type Fail = Extract<ToolOutcome, { ok: false }>
const fail = (error: string): Fail => ({ ok: false, error })

const ASSET_SHORTLIST = 8

async function boardClient(boardId: string): Promise<Client | null> {
  const [row] = await db
    .select({ clientId: schema.board.clientId })
    .from(schema.board)
    .where(eq(schema.board.id, boardId))
    .limit(1)
  return row?.clientId ? getClient(row.clientId) : null
}

export type DesignTarget = {
  client: Client
  kit: DesignContext['kit']
  kitId: string | null
  templates: TemplateSummary[]
  assets: DesignAsset[]
  assetIds: string[]
}

// Who the work is for and what it is made from: the client (asked for, or the
// board's), their kit (the only one, or the one named), the templates for the
// format and a first look at the library. A failure is the question to put to
// the person.
export async function resolveDesignTarget(
  ctx: ToolContext,
  input: { format: OutputFormat; client?: string; kit?: string },
): Promise<({ ok: true } & DesignTarget) | Fail> {
  const clients = await listClients()
  let client: Client | null
  if (input.client) {
    const m = matchNamed(clients, input.client)
    if (m.kind !== 'found') {
      return fail(
        m.kind === 'ambiguous'
          ? `“${input.client}” matches ${m.candidates.map((c) => c.name).join(', ')} — which one?`
          : `No client matches “${input.client}”. Clients: ${clients.map((c) => c.name).join(', ') || 'none yet'}.`,
      )
    }
    client = m.item
  } else {
    client = await boardClient(ctx.boardId)
  }
  if (!client) {
    return fail(
      `Which client is this for? This board has none. Clients: ${clients.map((c) => c.name).join(', ') || 'none yet'}.`,
    )
  }

  const kits = await listKits({ clientId: client.id })
  let kit: KitSummary | null = null
  if (input.kit) {
    const m = matchNamed(kits, input.kit)
    if (m.kind !== 'found') {
      return fail(
        `No ${client.name} kit matches “${input.kit}”. Kits: ${kits.map((k) => k.name).join(', ') || 'none'}.`,
      )
    }
    kit = m.item
  } else if (kits.length === 1) {
    kit = kits[0]!
  } else if (kits.length > 1) {
    return fail(
      `${client.name} has ${kits.length} style kits (${kits.map((k) => k.name).join(', ')}) — which one?`,
    )
  }
  const kitDetail = kit ? await getKitDetail(kit.id) : null

  const templates = await listTemplates({ clientId: client.id, format: input.format })
  if (templates.length === 0) {
    return fail(`There are no ${OUTPUT_FORMAT_LABELS[input.format]} templates yet.`)
  }

  const [{ assets }, assetIds] = await Promise.all([
    searchAssets({ client: client.id, kind: 'image', limit: ASSET_SHORTLIST, offset: 0 }),
    clientAssetIds(client.id),
  ])
  return {
    ok: true,
    client,
    kitId: kit?.id ?? null,
    kit:
      kit && kitDetail
        ? {
            id: kit.id,
            name: kit.name,
            version: kitDetail.version.version,
            tokens: kitDetail.version.tokens,
          }
        : null,
    templates,
    assets: assets.map((a) => ({
      name: a.name,
      url: a.url,
      caption: a.caption,
      kind: a.kind,
      width: a.width,
      height: a.height,
      colors: a.colors,
    })),
    assetIds,
  }
}

export async function designOutputTool(
  ctx: ToolContext,
  input: {
    format: OutputFormat
    brief: string
    client?: string
    kit?: string
    variants?: number
    regenerate?: boolean
    linearIssue?: string
    figmaFrames?: string[]
  },
): Promise<ToolOutcome> {
  if (input.format === 'video') {
    return fail('Films are made with design_video, not design_output.')
  }
  const target = await resolveDesignTarget(ctx, input)
  if (!target.ok) return target
  let figmaFrames: FigmaReference[] = []
  if (input.figmaFrames && input.figmaFrames.length > 0) {
    const resolved = await resolveFigmaReferences(ctx.boardId, input.figmaFrames)
    if (!resolved.ok) return resolved
    figmaFrames = resolved.frames
  }
  const { client, templates, assetIds } = target
  const kit = target.kit ? { id: target.kit.id } : null
  const linearIssue = input.linearIssue ? (parseIssueRef(input.linearIssue) ?? null) : null

  const context: DesignContext = {
    brief: input.brief,
    format: input.format,
    client: { id: client.id, name: client.name },
    kit: target.kit,
    templates,
    assets: target.assets,
    linearIssue,
    figmaFrames: figmaFrames.map((f) => ({
      name: f.name,
      fileName: f.fileName,
      width: f.width,
      height: f.height,
    })),
  }

  const runId = await createDesignRun({
    boardId: ctx.boardId,
    format: input.format,
    brief: input.brief,
    clientId: client.id,
    kitId: kit?.id ?? null,
    kitVersion: context.kit?.version ?? null,
    linearIssue,
    userId: ctx.userId,
  })

  const variants = await runDesign({
    model: ctx.model === undefined ? defaultModelClient() : ctx.model,
    context,
    count: input.variants ?? 3,
    toolboxFor: () =>
      designToolbox({
        boardId: ctx.boardId,
        userId: ctx.userId,
        clientId: client.id,
        kitId: kit?.id ?? null,
        templates,
        figmaFrames,
      }),
    cache: dbDesignCache(DESIGNER_MODEL_TAG),
    keyFor: (plan) =>
      designCacheKey({
        brief: input.brief,
        clientId: client.id,
        kitId: kit?.id ?? null,
        kitVersion: context.kit?.version ?? null,
        templates: templates.map((t) => ({ id: t.id, version: t.latestVersion })),
        assetIds,
        format: input.format,
        variantIndex: plan.index,
        modelTag: DESIGNER_MODEL_TAG,
        figmaFrames: figmaFrames.map(figmaReferenceKey),
      }),
    regenerate: input.regenerate,
    onProgress: ctx.onProgress ?? (() => undefined),
    signal: ctx.signal,
  })
  await setRunVariants(runId, variants)

  const done = variants.filter((v) => v.status === 'done')
  if (done.length === 0) {
    const reasons = [...new Set(variants.map((v) => v.error).filter(Boolean))]
    return fail(`The designer couldn’t make any options: ${reasons.join(' ')}`)
  }
  const label = OUTPUT_FORMAT_LABELS[input.format].toLowerCase()
  const allCached = done.every((v) => v.cached)
  return {
    ok: true,
    payload: {
      summary: `${done.length}${done.length < variants.length ? ` of ${variants.length}` : ''} ${label} option${variants.length === 1 ? '' : 's'} for ${client.name}${allCached ? ' (reused)' : ''}`,
      runId,
      format: input.format,
      client: client.name,
      kit: context.kit ? `${context.kit.name} v${context.kit.version}` : null,
      linearIssue,
      figmaFrames: figmaFrames.map((f) => f.name),
      cached: allCached,
      variants: variants.map((v) => ({
        ...v,
        ...(v.outputId
          ? {
              url: outputUrl(v.outputId),
              thumbnailUrl: outputThumbnailPath(v.outputId, v.version ?? undefined),
            }
          : {}),
      })),
      note: 'The user sees each option as a card with its thumbnail and picks one there. Post to Linear only after a pick and when asked.',
    },
  }
}

export async function pickDesignVariantTool(
  _ctx: ToolContext,
  input: { output: string },
): Promise<ToolOutcome> {
  const found = await resolveOutput(input.output)
  if ('ok' in found) return found
  const run = await runForOutput(found.item.id)
  if (!run) return fail(`“${found.item.name}” isn’t one of the designer’s options.`)
  const chosen = await chooseDesignVariant(run.id, found.item.id)
  if (!chosen.ok) return fail(chosen.error)
  return {
    ok: true,
    payload: {
      summary: `Picked “${found.item.name}”`,
      runId: run.id,
      output: outputRef(found.item),
      linearIssue: run.linearIssue,
    },
  }
}

export async function postLinearCommentTool(
  ctx: ToolContext,
  input: { run?: string; output?: string; issue?: string },
): Promise<ToolOutcome> {
  let outputId: string
  let runId: string | undefined
  if (input.output) {
    const found = await resolveOutput(input.output)
    if ('ok' in found) return found
    outputId = found.item.id
  } else if (input.run) {
    const run = await getDesignRun(input.run)
    if (!run) return fail(`No design run “${input.run}”.`)
    if (!run.chosenOutputId) {
      return fail(
        'Nothing has been picked yet. Pick an option first — only the picked one goes to Linear.',
      )
    }
    outputId = run.chosenOutputId
    runId = run.id
  } else {
    return fail('Say which: run (from design_output) or output.')
  }
  try {
    const posted = await postToLinear({ userId: ctx.userId, outputId, issue: input.issue, runId })
    if (!posted.ok) return fail(posted.error)
    const output = (await getOutputSummary(outputId))!
    return {
      ok: true,
      payload: {
        summary: `Posted “${output.name}” to ${posted.issueIdentifier}`,
        output: outputRef(output),
        issue: posted.issueIdentifier,
        commentUrl: posted.commentUrl,
        shareUrl: posted.shareUrl,
        imageAttached: posted.imageAttached,
        runId: posted.run?.id ?? null,
      },
    }
  } catch (e) {
    if (e instanceof LinearUnavailableError) return fail(e.message)
    if (e instanceof LinearApiError) return fail(`Linear: ${e.message}`)
    throw e
  }
}
