import {
  formatLinearIssue,
  kitToCss,
  matchNamed,
  type KitSummary,
  type AssetMediaKind,
  type NameMatch,
} from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { getLibraryAsset, searchAssets } from './assetLibrary'
import type { ToolContext, ToolOutcome } from './canvasTools'
import { getClient, listClients } from './clients'
import { getKitDetail, listKits } from './kits'
import { addAssetToBoard } from './libraryBoard'
import { LinearApiError } from './linear'
import { clientNameFor, getIssueDetail, LinearUnavailableError } from './linearConnection'

// Bodies of the client / kit / asset / Linear tools. They are registered in
// canvasTools.ts (CANVAS_TOOLS) next to the canvas tools so the MCP server
// and the sidebar orchestrator expose the same set.

type Fail = Extract<ToolOutcome, { ok: false }>

const fail = (error: string): Fail => ({ ok: false, error })

function describeMatch<T extends { name: string }>(
  noun: string,
  query: string,
  m: NameMatch<T>,
): Fail {
  if (m.kind === 'ambiguous') {
    return fail(
      `“${query}” matches more than one ${noun}: ${m.candidates.map((c) => c.name).join(', ')}. Use the exact name.`,
    )
  }
  return fail(`No ${noun} matches “${query}”.`)
}

export async function boardClientId(boardId: string): Promise<string | null> {
  const [row] = await db
    .select({ clientId: schema.board.clientId })
    .from(schema.board)
    .where(eq(schema.board.id, boardId))
    .limit(1)
  return row?.clientId ?? null
}

async function resolveClient(query: string) {
  const clients = await listClients()
  const m = matchNamed(clients, query)
  return m.kind === 'found' ? ({ client: m.item } as const) : describeMatch('client', query, m)
}

export async function listClientsTool(ctx: ToolContext): Promise<ToolOutcome> {
  const clients = await listClients()
  const forBoard = await boardClientId(ctx.boardId)
  const current = clients.find((c) => c.id === forBoard) ?? null
  return {
    ok: true,
    payload: {
      summary: `${clients.length} client${clients.length === 1 ? '' : 's'}`,
      clients: clients.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        boardCount: c.boardCount,
        kitCount: c.kitCount,
      })),
      boardClient: current ? { id: current.id, name: current.name, slug: current.slug } : null,
    },
  }
}

const kitBrief = (k: KitSummary) => ({
  id: k.id,
  name: k.name,
  client: k.clientName,
  clientSlug: k.clientSlug,
  latestVersion: k.latestVersion,
  palette: k.preview.palette,
  displayFont: k.preview.display,
  bodyFont: k.preview.body,
})

export async function listKitsTool(
  ctx: ToolContext,
  input: { client?: string },
): Promise<ToolOutcome> {
  let clientId: string | undefined
  let scope = ''
  if (input.client) {
    const found = await resolveClient(input.client)
    if ('ok' in found) return found
    clientId = found.client.id
    scope = ` for ${found.client.name}`
  }
  const kits = await listKits(clientId ? { clientId } : {})
  return {
    ok: true,
    payload: {
      summary: `${kits.length} kit${kits.length === 1 ? '' : 's'}${scope}`,
      kits: kits.map(kitBrief),
    },
  }
}

export async function getStyleKitTool(
  ctx: ToolContext,
  input: { kit?: string; client?: string; version?: number },
): Promise<ToolOutcome> {
  let candidates: KitSummary[]
  let clientName: string | null = null
  if (input.client) {
    const found = await resolveClient(input.client)
    if ('ok' in found) return found
    clientName = found.client.name
    candidates = await listKits({ clientId: found.client.id })
  } else if (input.kit) {
    candidates = await listKits()
  } else {
    // "Use the kit" with nothing else means this board's client.
    const clientId = await boardClientId(ctx.boardId)
    if (!clientId) {
      return fail(
        'No kit or client given, and this board has no client. Call list_kits (or list_clients) and ask which one.',
      )
    }
    clientName = (await getClient(clientId))?.name ?? null
    candidates = await listKits({ clientId })
  }

  let kit: KitSummary | undefined
  if (input.kit) {
    const m = matchNamed(candidates, input.kit)
    if (m.kind !== 'found') return describeMatch('kit', input.kit, m)
    kit = m.item
  } else if (candidates.length === 1) {
    kit = candidates[0]
  } else if (candidates.length === 0) {
    return fail(`${clientName ?? 'That client'} has no style kits yet.`)
  } else {
    return fail(
      `${clientName ?? 'That client'} has ${candidates.length} kits (${candidates.map((k) => k.name).join(', ')}). Pass kit with one of those names.`,
    )
  }

  const detail = await getKitDetail(kit!.id, input.version)
  if (!detail) return fail(`Kit “${kit!.name}” has no version ${input.version}.`)
  const { tokens } = detail.version
  return {
    ok: true,
    payload: {
      summary: `${kit!.clientName} kit “${kit!.name}” v${detail.version.version}`,
      kit: {
        id: kit!.id,
        name: kit!.name,
        client: kit!.clientName,
        clientSlug: kit!.clientSlug,
        version: detail.version.version,
        latestVersion: kit!.latestVersion,
      },
      tokens,
      css: kitToCss(tokens),
      cssUrl: `/api/kits/${kit!.id}/css?version=${detail.version.version}`,
    },
  }
}

export async function searchAssetsTool(
  ctx: ToolContext,
  input: { query?: string; client?: string; kind?: AssetMediaKind; tag?: string; limit?: number },
): Promise<ToolOutcome> {
  let clientId: string | undefined
  if (input.client) {
    const found = await resolveClient(input.client)
    if ('ok' in found) return found
    clientId = found.client.id
  }
  const limit = input.limit ?? 12
  const { assets, nextOffset } = await searchAssets({
    q: input.query,
    client: clientId,
    kind: input.kind,
    tag: input.tag,
    limit,
    offset: 0,
  })
  return {
    ok: true,
    payload: {
      summary: `${assets.length}${nextOffset !== null ? '+' : ''} asset${assets.length === 1 ? '' : 's'}${input.query ? ` for “${input.query}”` : ''}`,
      hasMore: nextOffset !== null,
      assets: assets.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        url: a.url,
        thumbnailUrl: a.thumbnailUrl,
        caption: a.caption,
        tags: a.tags,
        colors: a.colors,
        width: a.width,
        height: a.height,
        client: a.clientName,
      })),
    },
  }
}

export async function getLinearIssueTool(
  ctx: ToolContext,
  input: { issue: string },
): Promise<ToolOutcome> {
  try {
    const issue = await getIssueDetail(ctx.userId, input.issue)
    if (!issue) return fail(`No Linear issue matches “${input.issue}”.`)
    const clientName = await clientNameFor(issue.clientId)
    return {
      ok: true,
      payload: {
        summary: `${issue.identifier} · ${issue.title}`,
        issue,
        client: issue.clientId ? { id: issue.clientId, name: clientName } : null,
        text: formatLinearIssue(issue, clientName),
      },
    }
  } catch (e) {
    if (e instanceof LinearUnavailableError) return fail(e.message)
    if (e instanceof LinearApiError) return fail(`Linear request failed: ${e.message}`)
    throw e
  }
}

// Lays a library asset out on this board as the canvas object it would have
// been had it been uploaded here (image, PDF or font specimen).
export async function addAssetToBoardTool(
  ctx: ToolContext,
  input: { asset: string; x?: number; y?: number },
): Promise<ToolOutcome> {
  const ref = input.asset.trim()
  let id = ref
  const file = /^\/api\/files\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)$/.exec(ref)?.[1]
  if (file) {
    const [row] = await db
      .select({ id: schema.asset.id })
      .from(schema.asset)
      .where(eq(schema.asset.filename, file))
      .limit(1)
    if (!row) return fail(`No library asset has the url ${ref}.`)
    id = row.id
  }
  const asset = await getLibraryAsset(id)
  if (!asset) return fail(`No library asset “${ref}” — use an id or url from search_assets.`)
  const at = input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : undefined
  const result = await addAssetToBoard(asset.id, ctx.boardId, ctx.userId, at)
  if (!result.ok) return fail(result.error)
  return {
    ok: true,
    payload: {
      summary: `Added ${asset.name} to the board`,
      objectIds: [result.added.object.id],
      asset: { id: asset.id, name: asset.name, kind: asset.kind, url: asset.url },
    },
    effects: { objects: [result.added] },
  }
}
