import {
  matchNamed,
  OUTPUT_FORMAT_LABELS,
  viewportSize,
  type KitSummary,
  type OutputFormat,
  type OutputSummary,
  type TemplateSummary,
} from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import type { ToolContext, ToolOutcome } from './canvasTools'
import { listClients } from './clients'
import { listKits } from './kits'
import {
  addOutputVersion,
  composeDoc,
  createOutput,
  getOutputDetail,
  getOutputSummary,
  listOutputs,
  outputRenderDoc,
  placeOutputOnBoard,
} from './outputs'
import { listTemplates } from './templates'

// Bodies of the template/output tools, registered in canvasTools.ts
// (CANVAS_TOOLS) so MCP and the sidebar orchestrator get the same set.
// Deliberately small: Phase 24's output agents build on these. Every write
// is a new output version.

type Fail = Extract<ToolOutcome, { ok: false }>
const fail = (error: string): Fail => ({ ok: false, error })

export function outputUrl(id: string): string {
  const base = process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'
  return `${base.replace(/\/$/, '')}/outputs/${id}`
}

async function boardClientId(boardId: string): Promise<string | null> {
  const [row] = await db
    .select({ clientId: schema.board.clientId })
    .from(schema.board)
    .where(eq(schema.board.id, boardId))
    .limit(1)
  return row?.clientId ?? null
}

function pick<T extends { id: string; name: string }>(
  noun: string,
  items: T[],
  query: string,
): { item: T } | Fail {
  const m = matchNamed(items, query)
  if (m.kind === 'found') return { item: m.item }
  if (m.kind === 'ambiguous') {
    return fail(
      `“${query}” matches more than one ${noun}: ${m.candidates.map((c) => c.name).join(', ')}. Use the exact name or id.`,
    )
  }
  return fail(`No ${noun} matches “${query}”.`)
}

const templateBrief = (t: TemplateSummary) => ({
  id: t.id,
  name: t.name,
  format: t.format,
  size: t.viewport.kind === 'fixed' ? `${t.viewport.width}×${t.viewport.height}` : 'responsive',
  client: t.clientName,
  version: t.latestVersion,
  slots: t.slots,
})

const outputRef = (o: OutputSummary) => ({
  id: o.id,
  name: o.name,
  format: o.format,
  template: o.templateName,
  client: o.clientName,
  kit: o.kitName,
  version: o.latestVersion,
  url: outputUrl(o.id),
})

export async function listTemplatesTool(
  _ctx: ToolContext,
  input: { format?: OutputFormat; client?: string },
): Promise<ToolOutcome> {
  let clientId: string | undefined
  if (input.client) {
    const found = pick('client', await listClients(), input.client)
    if ('ok' in found) return found
    clientId = found.item.id
  }
  const templates = await listTemplates({ clientId, format: input.format })
  return {
    ok: true,
    payload: {
      summary: `${templates.length} template${templates.length === 1 ? '' : 's'}${input.format ? ` (${OUTPUT_FORMAT_LABELS[input.format]})` : ''}`,
      templates: templates.map(templateBrief),
    },
  }
}

async function resolveOutput(query: string): Promise<{ item: OutputSummary } | Fail> {
  const direct = await getOutputSummary(query.trim())
  if (direct) return { item: direct }
  return pick('output', await listOutputs(), query)
}

export async function createOutputTool(
  ctx: ToolContext,
  input: {
    template: string
    client?: string
    kit?: string
    name?: string
    slots?: Record<string, string>
  },
): Promise<ToolOutcome> {
  const template = pick('template', await listTemplates(), input.template)
  if ('ok' in template) return template

  let clientId: string | null
  if (input.client) {
    const found = pick('client', await listClients(), input.client)
    if ('ok' in found) return found
    clientId = found.item.id
  } else {
    clientId = (await boardClientId(ctx.boardId)) ?? template.item.clientId
  }

  let kit: KitSummary | null = null
  const kits = await listKits(clientId ? { clientId } : {})
  if (input.kit) {
    const found = pick('kit', kits, input.kit)
    if ('ok' in found) return found
    kit = found.item
  } else if (clientId && kits.length === 1) {
    kit = kits[0]!
  }

  const result = await createOutput({
    templateId: template.item.id,
    clientId,
    kitId: kit?.id ?? null,
    name: input.name,
    slotValues: input.slots,
    boardId: ctx.boardId,
    userId: ctx.userId,
  })
  if (!result.ok) return fail(result.error)
  const detail = (await getOutputDetail(result.output.id))!
  return {
    ok: true,
    payload: {
      summary: `Created “${result.output.name}” from ${template.item.name}`,
      output: outputRef(result.output),
      kit: kit ? { id: kit.id, name: kit.name, version: kit.latestVersion } : null,
      slots: detail.version.slots,
      note: kit
        ? undefined
        : 'No kit applied (house style). Pass kit, or update the output once the client has one.',
    },
  }
}

export async function getOutputTool(
  _ctx: ToolContext,
  input: { output: string; version?: number; includeSource?: boolean },
): Promise<ToolOutcome> {
  const found = await resolveOutput(input.output)
  if ('ok' in found) return found
  const detail = await getOutputDetail(found.item.id, input.version)
  if (!detail) return fail(`“${found.item.name}” has no version ${input.version}.`)
  const doc = (await outputRenderDoc(found.item.id, detail.version.version))!
  const composed = await composeDoc(doc)
  const { width, height } = viewportSize(detail.output.viewport)
  return {
    ok: true,
    payload: {
      summary: `“${detail.output.name}” v${detail.version.version}`,
      output: outputRef(detail.output),
      version: detail.version.version,
      viewport:
        detail.output.viewport.kind === 'fixed' ? { width, height } : { kind: 'responsive' },
      kit: detail.output.kitName
        ? { name: detail.output.kitName, version: detail.version.kitVersion }
        : null,
      templateVersion: detail.version.templateVersion,
      slots: detail.version.slots,
      document: {
        htmlChars: detail.version.html.length,
        cssChars: detail.version.css.length,
        composedBytes: Buffer.byteLength(composed.html),
        missingAssets: composed.missingAssets,
      },
      versions: detail.versions.slice(0, 10).map((v) => ({ version: v.version, note: v.note })),
      ...(input.includeSource ? { html: detail.version.html, css: detail.version.css } : {}),
    },
  }
}

export async function updateOutputSlotsTool(
  ctx: ToolContext,
  input: { output: string; slots: Record<string, string | null>; baseVersion?: number },
): Promise<ToolOutcome> {
  const found = await resolveOutput(input.output)
  if ('ok' in found) return found
  const result = await addOutputVersion({
    outputId: found.item.id,
    patch: { baseVersion: input.baseVersion ?? found.item.latestVersion, slotValues: input.slots },
    userId: ctx.userId,
  })
  if (!result.ok) {
    return fail(
      result.status === 409
        ? `Someone saved v${result.latest} in the meantime — call get_output and retry on top of it.`
        : result.error,
    )
  }
  const detail = (await getOutputDetail(found.item.id, result.version))!
  return {
    ok: true,
    payload: {
      summary: `Updated “${detail.output.name}” — v${result.version}`,
      output: outputRef(detail.output),
      version: result.version,
      slots: detail.version.slots,
    },
  }
}

export async function placeOutputTool(
  ctx: ToolContext,
  input: { output: string; x?: number; y?: number },
): Promise<ToolOutcome> {
  const found = await resolveOutput(input.output)
  if ('ok' in found) return found
  const at = input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : undefined
  const result = await placeOutputOnBoard({
    outputId: found.item.id,
    boardId: ctx.boardId,
    userId: ctx.userId,
    at,
  })
  if (!result.ok) return fail(result.error)
  return {
    ok: true,
    payload: {
      summary: `Placed “${found.item.name}” on the board`,
      objectIds: [result.added.object.id],
      output: outputRef(found.item),
    },
    effects: { objects: [result.added] },
  }
}
