import {
  agentIdSchema,
  assetMediaKindSchema,
  DESIGN_BRIEF_MAX,
  DESIGN_VARIANTS_MAX,
  outputFormatSchema,
  slotNameSchema,
  SLOT_TEXT_MAX,
  groupId,
  proximityGroups,
  type AgentToolPayload,
  type AIAnalysis,
  type CanvasObject,
  type GroupState,
  type SaveBoardObjectsRequest,
  type SectionedParagraphs,
  type StickyData,
  type SynthesisBrief,
  type TextData,
  type VideoEditorBreakdown,
} from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db, schema } from '../db'
import { getAgent, listAgents } from './agents'
import {
  insertBoardObject,
  loadBoardObjects,
  saveBoardObjects,
  type VersionedObject,
} from './boardObjects'
import { clusterLayout, nextSpot } from './canvasPlacement'
import { designOutputTool, pickDesignVariantTool, postLinearCommentTool } from './designAgentTools'
import {
  addAssetToBoardTool,
  getLinearIssueTool,
  getStyleKitTool,
  listClientsTool,
  listKitsTool,
  searchAssetsTool,
} from './designTools'
import { analysisNotConfigured, runAgentOnGroup, runSynthesisOnGroup } from './groupAnalysis'
import {
  createOutputTool,
  getOutputTool,
  listTemplatesTool,
  placeOutputTool,
  updateOutputHtmlTool,
  updateOutputSlotsTool,
} from './outputTools'
import { listGroupStates } from './groupState'
import { routeUrlToImporter, type DispatchOk } from './mcpUrlDispatch'
import type { ModelClient, ToolRunOptions } from './orchestrator'
import { saveImageFromUrl } from './saveImageFromUrl'

// Canvas tools, implemented once and exposed over two transports: the MCP
// server (lib/mcpTools.ts adds a boardId argument) and the sidebar
// orchestrator (lib/orchestrator.ts binds the board it was opened on).
// Each tool returns a payload for the model plus the rows it changed, so
// the orchestrator can push them to the open canvas.

export type ToolContext = {
  boardId: string
  userId: string
  // The model client for tools that run their own agent (design_output).
  // Undefined means "use the server's"; null means none is configured.
  model?: ModelClient | null
} & ToolRunOptions

export type ToolEffects = { objects: VersionedObject[]; groups: GroupState[] }

export type ToolOutcome =
  | { ok: true; payload: AgentToolPayload; effects?: Partial<ToolEffects> }
  | { ok: false; error: string }

export type CanvasTool = {
  name: string
  title: string
  description: string
  input: z.ZodRawShape
  run: (ctx: ToolContext, input: unknown) => Promise<ToolOutcome>
}

function defineTool<S extends z.ZodRawShape>(def: {
  name: string
  title: string
  description: string
  input: S
  run: (ctx: ToolContext, input: z.infer<z.ZodObject<S>>) => Promise<ToolOutcome>
}): CanvasTool {
  const schema = z.object(def.input)
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    input: def.input,
    run: async (ctx, raw) => {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (i) => `${i.path.join('.') || 'input'}: ${i.message}`,
        )
        return { ok: false, error: `Invalid input — ${issues.join('; ')}` }
      }
      return def.run(ctx, parsed.data)
    },
  }
}

// ---------------------------------------------------------------------------
// Board access
// ---------------------------------------------------------------------------

type BoardRow = typeof schema.board.$inferSelect
type LoadedBoard = { row: BoardRow; versioned: VersionedObject[]; objects: CanvasObject[] }

async function loadBoard(boardId: string): Promise<LoadedBoard | null> {
  const [row] = await db.select().from(schema.board).where(eq(schema.board.id, boardId)).limit(1)
  if (!row) return null
  const versioned = await loadBoardObjects(boardId)
  return { row, versioned, objects: versioned.map((v) => v.object) }
}

const BOARD_NOT_FOUND: ToolOutcome = { ok: false, error: 'Board not found.' }

export function boardUrl(boardId: string): string {
  const base = process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'
  return `${base.replace(/\/$/, '')}/board/${boardId}`
}

// `build` sees the current objects so it can pick a free spot. The insert
// is a single new row, so a teammate editing the board concurrently keeps
// their changes.
async function appendObject(
  ctx: ToolContext,
  build: (objects: CanvasObject[]) => CanvasObject,
): Promise<VersionedObject | null> {
  const board = await loadBoard(ctx.boardId)
  if (!board) return null
  const object = build(board.objects)
  await insertBoardObject(ctx.boardId, object, ctx.userId)
  return { object, version: 1 }
}

// ---------------------------------------------------------------------------
// Object factories (server-side mirrors of apps/web/src/lib/objectFactory.ts)
// ---------------------------------------------------------------------------

const STICKY_SIZE = { width: 200, height: 200 }
const STICKY_DEFAULT_COLOR = '#FEF3C7'
const TEXT_DEFAULT_FONT = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont'
const IMAGE_DEFAULT_SIZE = { width: 400, height: 300 }
const WEB_DEFAULT_SIZE = { width: 320, height: 240 }
const VIDEO_DEFAULT_SIZE = { width: 320, height: 290 }
const SPOTIFY_PLAYLIST_SIZE = { width: 320, height: 150 }
const SPOTIFY_TRACK_SIZE = { width: 320, height: 248 }
const DRIVE_DEFAULT_SIZE = { width: 280, height: 140 }
const PDF_DEFAULT_SIZE = { width: 180, height: 240 }

function sizeForText(text: string): { width: number; height: number } {
  if (!text) return { width: 240, height: 56 }
  const explicitLines = text.split('\n').length
  const longestLine = text.split('\n').reduce((max, line) => Math.max(max, line.length), 0)
  const softWrappedLines = Math.max(explicitLines, Math.ceil(text.length / 50))
  const width = Math.max(240, Math.min(480, longestLine * 9 + 40))
  const height = Math.max(56, Math.min(420, softWrappedLines * 26 + 24))
  return { width, height }
}

function placed(
  objects: CanvasObject[],
  type: CanvasObject['type'],
  size: { width: number; height: number },
  data: CanvasObject['data'],
): CanvasObject {
  return {
    id: nanoid(),
    type,
    position: nextSpot(objects, size),
    size,
    rotation: 0,
    zIndex: objects.length,
    data,
  }
}

function objectFromImport(result: DispatchOk, objects: CanvasObject[]): CanvasObject {
  switch (result.kind) {
    case 'web':
      return placed(objects, 'web-page', WEB_DEFAULT_SIZE, result.page)
    case 'video':
      return placed(objects, 'video-clip', VIDEO_DEFAULT_SIZE, result.data)
    case 'image':
    case 'drive-image':
      return placed(objects, 'image', IMAGE_DEFAULT_SIZE, result.data)
    case 'drive-file':
      return placed(objects, 'drive-file', DRIVE_DEFAULT_SIZE, result.data)
    case 'drive-folder':
      return placed(objects, 'drive-folder', DRIVE_DEFAULT_SIZE, result.data)
    case 'drive-pdf':
      return placed(objects, 'pdf', PDF_DEFAULT_SIZE, result.data)
    case 'spotify-playlist':
      return placed(objects, 'spotify-playlist', SPOTIFY_PLAYLIST_SIZE, result.data)
    case 'spotify-track':
      return placed(objects, 'spotify-track', SPOTIFY_TRACK_SIZE, result.data)
    case 'spotify-album':
      return placed(objects, 'spotify-album', SPOTIFY_PLAYLIST_SIZE, result.data)
  }
}

// ---------------------------------------------------------------------------
// Read projections
// ---------------------------------------------------------------------------

// A one-line handle for each object so the model can tell items apart
// without the full payload.
export function objectLabel(o: CanvasObject): string {
  const d = o.data as Record<string, unknown>
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '')
  const clip = (s: string) => (s.length > 90 ? `${s.slice(0, 87)}…` : s)
  switch (o.type) {
    case 'sticky':
    case 'text':
      return clip(str('text').replace(/\s+/g, ' ').trim())
    case 'web-page':
      return clip(str('title') || str('url'))
    case 'video-clip':
      return clip(str('title') || str('url'))
    case 'spotify-playlist':
    case 'spotify-track':
    case 'spotify-album':
    case 'drive-file':
    case 'drive-folder':
      return clip(str('name') || str('title'))
    case 'font':
      return clip(str('family'))
    case 'voice-note':
      return clip(str('transcript'))
    case 'pdf':
      return clip(str('name') || str('filename') || 'PDF')
    case 'image':
      return str('url')
    case 'output':
      return clip(str('name'))
  }
}

function projectDisplay(display: NonNullable<GroupState['display']>): Record<string, unknown> {
  switch (display.kind) {
    case 'brief': {
      const brief = display.data as SynthesisBrief
      return {
        kind: 'brief',
        throughline: brief.throughline,
        summary: brief.bodyCopy || '',
        palette: brief.palette.map((p) => p.hex),
        references: brief.references,
        hooks: brief.hooks,
        statements: brief.statements,
        fonts: brief.fonts.map((f) => f.name || f.category),
        audiences: brief.audiences.map((a) => a.label),
        channels: brief.channels.map((c) => c.name),
        video: brief.video,
      }
    }
    case 'ad': {
      const ad = display.data as AIAnalysis
      return {
        kind: 'art-director',
        headline: ad.headline,
        summary: ad.summary,
        mood: ad.mood,
        tone: ad.tone,
        palette: ad.palette,
        adjectives: ad.adjectives,
        themes: ad.themes,
        references: ad.references,
        tensions: ad.tensions,
        hooks: ad.hooks,
        statements: ad.statements,
      }
    }
    case 'video':
      return { kind: 'video-editor', data: display.data as VideoEditorBreakdown }
    case 'sectioned':
      return { kind: 'sectioned', sections: (display.data as SectionedParagraphs).sections }
  }
}

// ---------------------------------------------------------------------------
// Shared input fragments
// ---------------------------------------------------------------------------

const objectIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(50)
  .describe('Object ids from get_board.')

const agentsDescription = listAgents()
  .map((a) => `- ${a.id} (${a.label}): ${a.blurb}`)
  .join('\n')

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const getBoard = defineTool({
  name: 'get_board',
  title: 'Read the board',
  description:
    "Read the board: every object (id, type, position, size, a short label), the current groups (objects within 48px of each other auto-group) with their member ids, and each group's panel state — the analysis it currently shows (brief/art-director/sectioned/video) and which agents produced it. Call this before moving or analysing anything so you work from real ids. Pass verbose:true for the full object payloads (large).",
  input: {
    verbose: z
      .boolean()
      .optional()
      .describe('When true, includes the full objects array. Defaults to false.'),
  },
  run: async (ctx, { verbose }) => {
    const board = await loadBoard(ctx.boardId)
    if (!board) return BOARD_NOT_FOUND
    const { row, objects } = board
    const objectsByType: Record<string, number> = {}
    for (const o of objects) objectsByType[o.type] = (objectsByType[o.type] ?? 0) + 1

    const states = new Map((await listGroupStates(ctx.boardId)).map((s) => [s.groupKey, s]))
    const groups = proximityGroups(objects).map((ids) => {
      const key = groupId(ids)
      const state = states.get(key)
      return {
        groupKey: key,
        objectIds: ids,
        analysis: state?.display ? projectDisplay(state.display) : null,
        analysedBy: state?.agentIds ?? [],
        selectedAgents: state?.selectedAgentIds ?? [],
      }
    })
    const payload: AgentToolPayload = {
      summary: `Read the board — ${objects.length} item${objects.length === 1 ? '' : 's'}, ${groups.length} group${groups.length === 1 ? '' : 's'}`,
      id: row.id,
      name: row.name,
      url: boardUrl(row.id),
      objectCount: objects.length,
      objectsByType,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      items: objects.map((o) => ({
        id: o.id,
        type: o.type,
        x: Math.round(o.position.x),
        y: Math.round(o.position.y),
        width: Math.round(o.size.width),
        height: Math.round(o.size.height),
        label: objectLabel(o),
      })),
      groupCount: groups.length,
      groups,
    }
    if (verbose) payload.objects = objects
    return { ok: true, payload }
  },
})

const addNote = defineTool({
  name: 'add_note',
  title: 'Add a sticky note',
  description:
    'Drop a sticky note on the board. Use this for short verbatim copy, tags, vibe descriptors, or anything textual you want the AI synthesis to read as a directive (not as long-form copy — use add_text for that). New items land in free space; use group_objects to pull them next to others.',
  input: {
    text: z.string().min(1).max(2000),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional()
      .describe('Hex like #FEF3C7. Defaults to pale yellow.'),
  },
  run: async (ctx, { text, color }) => {
    const data: StickyData = { text, color: color ?? STICKY_DEFAULT_COLOR }
    const added = await appendObject(ctx, (objects) => placed(objects, 'sticky', STICKY_SIZE, data))
    if (!added) return BOARD_NOT_FOUND
    return {
      ok: true,
      payload: { summary: 'Added a note', objectIds: [added.object.id] },
      effects: { objects: [added] },
    }
  },
})

const addText = defineTool({
  name: 'add_text',
  title: 'Add a text node',
  description:
    'Drop a typography-styled text node on the board. Use this for headlines, body paragraphs, tagline candidates, or anything longer / more compositional than a sticky.',
  input: {
    text: z.string().min(1).max(4000),
    fontSize: z.number().min(12).max(72).optional().describe('Pixel font size. Defaults to 18.'),
  },
  run: async (ctx, { text, fontSize }) => {
    const data: TextData = { text, font: TEXT_DEFAULT_FONT, fontSize: fontSize ?? 18 }
    const added = await appendObject(ctx, (objects) =>
      placed(objects, 'text', sizeForText(text), data),
    )
    if (!added) return BOARD_NOT_FOUND
    return {
      ok: true,
      payload: { summary: 'Added text', objectIds: [added.object.id] },
      effects: { objects: [added] },
    }
  },
})

const addUrl = defineTool({
  name: 'add_url',
  title: 'Add a URL to the board',
  description:
    'Smart importer. Detects whether the URL is a Spotify track/album/playlist, a Google Drive file, a video (YouTube/TikTok/Instagram/X/Vimeo), a direct image, or a generic web page, and drops the appropriate card on the board. Spotify/Drive require the user to have connected those providers first; the tool returns a clear instruction when missing.',
  input: {
    url: z
      .string()
      .describe('Any URL — public web pages, video links, image links, Spotify URIs, etc.'),
  },
  run: async (ctx, { url }) => {
    const dispatch = await routeUrlToImporter(url, ctx.userId)
    if (!dispatch.ok) return { ok: false, error: dispatch.error.message }
    const added = await appendObject(ctx, (objects) => objectFromImport(dispatch.result, objects))
    if (!added) return BOARD_NOT_FOUND
    return {
      ok: true,
      payload: {
        summary: `Added ${added.object.type.replace(/-/g, ' ')}`,
        objectIds: [added.object.id],
        type: added.object.type,
        label: objectLabel(added.object),
      },
      effects: { objects: [added] },
    }
  },
})

const addImage = defineTool({
  name: 'add_image',
  title: 'Add an image from a URL',
  description:
    'Download an image from a public URL and drop it on the board. The image is saved server-side so the canvas can render it even if the source goes away. Use this when you have a direct image URL — for a web page that contains images, use add_url instead (it captures the page + logos in one shot).',
  input: { url: z.string().url() },
  run: async (ctx, { url }) => {
    try {
      const data = await saveImageFromUrl(url, ctx.userId)
      const added = await appendObject(ctx, (objects) =>
        placed(objects, 'image', IMAGE_DEFAULT_SIZE, data),
      )
      if (!added) return BOARD_NOT_FOUND
      return {
        ok: true,
        payload: { summary: 'Added an image', objectIds: [added.object.id], imageUrl: data.url },
        effects: { objects: [added] },
      }
    } catch (e) {
      return { ok: false, error: `Image import failed: ${e instanceof Error ? e.message : e}` }
    }
  },
})

// Versioned write: each move carries the version just read, so a teammate's
// concurrent edit wins and is reported instead of being overwritten.
async function writePositions(
  ctx: ToolContext,
  board: LoadedBoard,
  positions: Map<string, { x: number; y: number }>,
): Promise<{ written: VersionedObject[]; conflicts: string[] }> {
  const byId = new Map(board.versioned.map((v) => [v.object.id, v]))
  const upserts: SaveBoardObjectsRequest['upserts'] = []
  const next = new Map<string, CanvasObject>()
  for (const [id, position] of positions) {
    const current = byId.get(id)
    if (!current) continue
    const object = { ...current.object, position }
    next.set(id, object)
    upserts.push({
      object: object as SaveBoardObjectsRequest['upserts'][number]['object'],
      baseVersion: current.version,
    })
  }
  const result = await saveBoardObjects(ctx.boardId, { upserts, deletes: [] }, ctx.userId)
  const written: VersionedObject[] = []
  for (const [id, version] of Object.entries(result.versions)) {
    const object = next.get(id)
    if (object) written.push({ object, version })
  }
  return { written, conflicts: result.conflicts.map((c) => c.id) }
}

function missingIds(board: LoadedBoard, ids: string[]): string[] {
  const present = new Set(board.objects.map((o) => o.id))
  return ids.filter((id) => !present.has(id))
}

const moveObjects = defineTool({
  name: 'move_objects',
  title: 'Move objects',
  description:
    'Move objects to explicit world positions (top-left corner, px). Items whose boxes end up within 48px of each other auto-group; keep unrelated items more than 48px apart. To pull items into a group, prefer group_objects — it does the layout for you.',
  input: {
    moves: z
      .array(z.object({ id: z.string().min(1), x: z.number(), y: z.number() }))
      .min(1)
      .max(50),
  },
  run: async (ctx, { moves }) => {
    const board = await loadBoard(ctx.boardId)
    if (!board) return BOARD_NOT_FOUND
    const missing = missingIds(
      board,
      moves.map((m) => m.id),
    )
    if (missing.length > 0)
      return { ok: false, error: `No objects with ids: ${missing.join(', ')}` }
    const positions = new Map(moves.map((m) => [m.id, { x: m.x, y: m.y }]))
    const { written, conflicts } = await writePositions(ctx, board, positions)
    return {
      ok: true,
      payload: {
        summary: `Moved ${written.length} item${written.length === 1 ? '' : 's'}`,
        objectIds: written.map((w) => w.object.id),
        ...(conflicts.length > 0 ? { conflicts, note: conflictNote } : {}),
      },
      effects: { objects: written },
    }
  },
})

const conflictNote =
  'Someone edited these items while you were moving them; their version was kept. Re-read the board before retrying.'

const groupObjects = defineTool({
  name: 'group_objects',
  title: 'Pull objects into a group',
  description:
    'Gather the given objects into one tidy cluster so they form a single group (the canvas groups items within 48px of each other). The cluster is placed where none of the other items are close enough to join it. Returns the group key and member ids — pass the same ids to analyze_group.',
  input: {
    objectIds: objectIdsSchema.refine((ids) => ids.length >= 2, {
      message: 'A group needs at least 2 objects',
    }),
  },
  run: async (ctx, { objectIds }) => {
    const board = await loadBoard(ctx.boardId)
    if (!board) return BOARD_NOT_FOUND
    const ids = [...new Set(objectIds)]
    const missing = missingIds(board, ids)
    if (missing.length > 0)
      return { ok: false, error: `No objects with ids: ${missing.join(', ')}` }
    const idSet = new Set(ids)
    const members = board.objects.filter((o) => idSet.has(o.id))
    const others = board.objects.filter((o) => !idSet.has(o.id))
    const { written, conflicts } = await writePositions(ctx, board, clusterLayout(members, others))
    const key = groupId(ids)
    return {
      ok: true,
      payload: {
        summary: `Moved ${ids.length} items into a group`,
        objectIds: ids,
        groupKey: key,
        ...(conflicts.length > 0 ? { conflicts, note: conflictNote } : {}),
      },
      effects: { objects: written },
    }
  },
})

const analyzeGroup = defineTool({
  name: 'analyze_group',
  title: 'Run specialists on a group',
  description: `Run specialist agents on one group and show the result on its canvas panel. One agent returns that specialist's read; two or more are synthesised into a one-page brief (throughline, palette, references, audiences, channels, hooks…). For "give me a brief", use at least art-director + copywriter, adding others that fit the request. Results are cached by content, so re-running an unchanged group is free; pass force:true only when the user explicitly asks to re-run.

Agents:
${agentsDescription}

Pass the ids of the group's members (any of them identifies the group; all must be in the same group). If the items aren't grouped yet, call group_objects first.`,
  input: {
    objectIds: objectIdsSchema,
    agents: z.array(agentIdSchema).min(1).max(6),
    force: z.boolean().optional(),
  },
  run: async (ctx, { objectIds, agents, force }) => {
    const board = await loadBoard(ctx.boardId)
    if (!board) return BOARD_NOT_FOUND
    const missing = missingIds(board, objectIds)
    if (missing.length > 0)
      return { ok: false, error: `No objects with ids: ${missing.join(', ')}` }
    const group = proximityGroups(board.objects).find((ids) => ids.includes(objectIds[0]!))
    if (!group) {
      return {
        ok: false,
        error: 'Those items are not in a group yet — call group_objects with them first.',
      }
    }
    const outside = objectIds.filter((id) => !group.includes(id))
    if (outside.length > 0) {
      return {
        ok: false,
        error: `Not all items are in the same group (${outside.join(', ')} sit elsewhere) — call group_objects first.`,
      }
    }
    const members = new Set(group)
    const items = board.objects.filter((o) => members.has(o.id))
    const agentIds = [...new Set(agents)]
    try {
      const run =
        agentIds.length === 1
          ? await runAgentOnGroup(ctx.boardId, items, agentIds[0]!, { force })
          : await runSynthesisOnGroup(ctx.boardId, items, agentIds, { force })
      const key = groupId(group)
      const state = (await listGroupStates(ctx.boardId)).filter((s) => s.groupKey === key)
      const label = run.kind === 'brief' ? 'Brief' : `${getAgent(agentIds[0]!).label} read`
      return {
        ok: true,
        payload: {
          summary: `${label} ready`,
          objectIds: group,
          groupKey: key,
          agents: run.agentIds,
          cached: run.cached,
          display: { kind: run.kind, data: run.data },
        },
        effects: { groups: state },
      }
    } catch (e) {
      const notConfigured = analysisNotConfigured(e)
      return {
        ok: false,
        error: notConfigured ?? `Analysis failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  },
})

// ---------------------------------------------------------------------------
// Clients, style kits, asset library, Linear (bodies in designTools.ts)
// ---------------------------------------------------------------------------

const listClients = defineTool({
  name: 'list_clients',
  title: 'List clients',
  description:
    'List the studio\'s clients (id, name, slug, how many boards and kits each has) and which client this board belongs to. Call this to resolve "for Acme" to a real client.',
  input: {},
  run: (ctx) => listClientsTool(ctx),
})

const listKits = defineTool({
  name: 'list_kits',
  title: 'List style kits',
  description:
    "List style kits — a client's brand tokens (palette, fonts, logos, voice) — with a palette and font preview. Optionally for one client (name or slug). Use get_style_kit to read one in full.",
  input: {
    client: z.string().min(1).optional().describe('Client name or slug, e.g. "Acme".'),
  },
  run: (ctx, input) => listKitsTool(ctx, input),
})

const getStyleKit = defineTool({
  name: 'get_style_kit',
  title: 'Read a style kit',
  description:
    'Read a client\'s style kit: its tokens (palette roles with usage, fonts, logos, voice do/don\'t, imagery rules, notes) and the compiled CSS — a :root block of --kit-* custom properties plus @font-face rules. Resolve "use the Acme kit" with client:"Acme" (a client with one kit needs nothing more; with several, also pass kit). With no arguments it reads the kit for this board\'s client. Defaults to the kit\'s latest version.',
  input: {
    client: z.string().min(1).optional().describe('Client name or slug.'),
    kit: z.string().min(1).optional().describe('Kit name or id.'),
    version: z.number().int().min(1).optional().describe('A specific version; default latest.'),
  },
  run: (ctx, input) => getStyleKitTool(ctx, input),
})

const searchAssets = defineTool({
  name: 'search_assets',
  title: 'Search the asset library',
  description:
    "Search the studio's asset library (every uploaded or imported image, PDF and font). Full-text over file name, AI caption and tags; each result carries its url, dimensions and dominant colours. Filter by client (name or slug), kind (image, pdf, font, audio) or tag. With no query it returns the newest assets.",
  input: {
    query: z.string().max(200).optional().describe('Words to look for, e.g. "hero photo warm".'),
    client: z.string().min(1).optional().describe('Client name or slug.'),
    kind: assetMediaKindSchema.optional(),
    tag: z.string().min(1).max(40).optional(),
    limit: z.number().int().min(1).max(30).optional().describe('Default 12.'),
  },
  run: (ctx, input) => searchAssetsTool(ctx, input),
})

const getLinearIssue = defineTool({
  name: 'get_linear_issue',
  title: 'Read a Linear issue',
  description:
    "Read a Linear issue as a brief: identifier, title, description, labels, comments, attachment links, and the client its team/project maps to. Pass an identifier like LIN-123, an issue URL or an id. Uses the signed-in user's own Linear connection. Read-only.",
  input: {
    issue: z.string().min(1).max(300).describe('Identifier (LIN-123), issue URL, or id.'),
  },
  run: (ctx, input) => getLinearIssueTool(ctx, input),
})

// ---------------------------------------------------------------------------
// Templates + outputs (bodies in outputTools.ts)
// ---------------------------------------------------------------------------

const outputQuery = z.string().min(1).max(200).describe('Output id (from create_output) or name.')
const slotValues = z
  .record(slotNameSchema, z.string().max(SLOT_TEXT_MAX))
  .describe(
    'Slot name → value. Text slots take plain text (escaped; newlines become line breaks — no HTML). Image slots take a library asset URL from search_assets, e.g. /api/files/abc.png.',
  )

const listTemplatesDef = defineTool({
  name: 'list_templates',
  title: 'List templates',
  description:
    "List design templates — self-contained HTML/CSS for a format (thumbnail 1280×720, social 1080×1080, 16:9 deck, responsive landing page, A4 one-pager, or the team's own) — with each one's slots (name, kind text|image, label). Templates are style-agnostic: a client's kit skins them. Optionally filter by format or client (a client also sees the general templates).",
  input: {
    format: outputFormatSchema.optional(),
    client: z.string().min(1).optional().describe('Client name or slug.'),
  },
  run: (ctx, input) => listTemplatesTool(ctx, input),
})

const createOutputDef = defineTool({
  name: 'create_output',
  title: 'Create an output',
  description:
    "Create a design output from a template for a client, skinned with one of the client's style kits, optionally filling slots. Defaults: client = this board's client; kit = the client's only kit (otherwise the neutral house style). Unfilled slots keep the template's default copy. Returns the output id, its URL and its slots. The output belongs to this board; use place_output_on_board to show it on the canvas.",
  input: {
    template: z.string().min(1).describe('Template name or id from list_templates.'),
    client: z.string().min(1).optional().describe('Client name or slug.'),
    kit: z.string().min(1).optional().describe("Kit name or id (one of the client's kits)."),
    name: z.string().min(1).max(120).optional().describe('Defaults to the template name.'),
    slots: slotValues.optional(),
  },
  run: (ctx, input) => createOutputTool(ctx, input),
})

const getOutputDef = defineTool({
  name: 'get_output',
  title: 'Read an output',
  description:
    "Read an output: its slots (label, kind, current value, template default), template and kit versions, recent versions, and a summary of the composed document (size, assets that couldn't be inlined). Pass includeSource:true for the HTML and CSS themselves. Defaults to the latest version.",
  input: {
    output: outputQuery,
    version: z.number().int().min(1).optional(),
    includeSource: z.boolean().optional(),
  },
  run: (ctx, input) => getOutputTool(ctx, input),
})

const updateOutputSlotsDef = defineTool({
  name: 'update_output_slots',
  title: 'Edit output slots',
  description:
    "Set slot values on an output, creating a new version (old versions are kept). Values merge into the current ones; null resets a slot to its template default. Pass baseVersion (from get_output) to be told instead of building on a teammate's newer save.",
  input: {
    output: outputQuery,
    slots: z.record(slotNameSchema, z.string().max(SLOT_TEXT_MAX).nullable()),
    baseVersion: z.number().int().min(1).optional(),
  },
  run: (ctx, input) => updateOutputSlotsTool(ctx, input),
})

const placeOutputDef = defineTool({
  name: 'place_output_on_board',
  title: 'Put an output on the board',
  description:
    'Drop an output onto this board as a live card that previews the latest version. Lands in free space unless x/y (world px, card centre) are given.',
  input: { output: outputQuery, x: z.number().optional(), y: z.number().optional() },
  run: (ctx, input) => placeOutputTool(ctx, input),
})

const textEdits = z
  .array(
    z.object({
      find: z.string().min(1).max(20_000).describe('Exact text currently in the document.'),
      replace: z.string().max(60_000),
      all: z.boolean().optional().describe('Replace every occurrence (default: must match once).'),
    }),
  )
  .max(20)

const updateOutputHtmlDef = defineTool({
  name: 'update_output_html',
  title: 'Edit output HTML/CSS',
  description:
    "Edit an output's HTML and/or CSS with exact find/replace edits, creating a new version. For structure the slots can't express: add, remove or reorder deck slides and page sections (copy a whole <section>…</section> to add one), change layout CSS, add a decorative element. Read the source first (get_output with includeSource:true); each find must match exactly once unless all:true, and edits apply in order. Keep data-slot markers on anything holding copy or imagery and change copy itself with update_output_slots. Body markup only — no <script>, <style>, <link> or event handlers, no external URLs (images are library /api/files/… urls); CSS reads only --kit-* variables and its own custom properties; motion only as CSS keyframes.",
  input: {
    output: outputQuery,
    html: textEdits.optional(),
    css: textEdits.optional(),
    baseVersion: z.number().int().min(1).optional(),
    note: z.string().max(200).optional().describe('What changed, for the version list.'),
  },
  run: (ctx, input) => updateOutputHtmlTool(ctx, input),
})

// ---------------------------------------------------------------------------
// Output agents (bodies in designAgentTools.ts)
// ---------------------------------------------------------------------------

const designOutputDef = defineTool({
  name: 'design_output',
  title: 'Design options',
  description: `Run the designer: it makes ${DESIGN_VARIANTS_MAX} distinct options (by default) of one design for a client — each built from a template in the client's kit with library imagery, rendered, critiqued visually and revised — and shows them to the user as cards with thumbnails to pick from. Takes a few minutes. Needs the client (default: this board's), the format and a brief with the core message; pass the kit when the client has several. The brief is everything the designer gets: message, audience, tone, must-include copy, things to avoid. Identical requests reuse earlier options; regenerate:true runs fresh ones (only when the user asks). Pass linearIssue (e.g. LIN-123) when the brief came from a Linear issue so the pick can be posted back.`,
  input: {
    format: outputFormatSchema,
    brief: z.string().min(1).max(DESIGN_BRIEF_MAX),
    client: z.string().min(1).optional().describe('Client name or slug.'),
    kit: z.string().min(1).optional().describe("Kit name or id (one of the client's kits)."),
    variants: z
      .number()
      .int()
      .min(1)
      .max(DESIGN_VARIANTS_MAX)
      .optional()
      .describe(`How many options, default ${DESIGN_VARIANTS_MAX}.`),
    regenerate: z.boolean().optional(),
    linearIssue: z.string().min(1).max(64).optional(),
  },
  run: (ctx, input) => designOutputTool(ctx, input),
})

const pickDesignVariantDef = defineTool({
  name: 'pick_design_variant',
  title: 'Pick a design option',
  description:
    "Mark one of design_output's options as the chosen one, when the user tells you which they want (they can also pick on the card). Only the picked option can be posted to Linear.",
  input: { output: outputQuery },
  run: (ctx, input) => pickDesignVariantTool(ctx, input),
})

const postLinearCommentDef = defineTool({
  name: 'post_linear_comment',
  title: 'Post to Linear',
  description:
    "Post an output to a Linear issue as a comment: its name, a share link (created if needed) and the rendered thumbnail. Only when the user asks. A design_output option must have been picked first and goes to its run's issue by default; any other output needs issue. Uses the signed-in user's Linear connection.",
  input: {
    output: outputQuery,
    issue: z.string().min(1).max(300).optional().describe('Identifier (LIN-123) or issue URL.'),
  },
  run: (ctx, input) => postLinearCommentTool(ctx, input),
})

const addAssetToBoardDef = defineTool({
  name: 'add_asset_to_board',
  title: 'Put a library asset on the board',
  description:
    'Place a library asset (image, PDF or font from search_assets) on this board, e.g. to lay out references. Lands in free space unless x/y (world px, centre) are given; use group_objects afterwards to pull references together.',
  input: {
    asset: z.string().min(1).max(300).describe('Asset id or /api/files/… url from search_assets.'),
    x: z.number().optional(),
    y: z.number().optional(),
  },
  run: (ctx, input) => addAssetToBoardTool(ctx, input),
})

export const CANVAS_TOOLS: CanvasTool[] = [
  getBoard,
  addNote,
  addText,
  addUrl,
  addImage,
  moveObjects,
  groupObjects,
  analyzeGroup,
  listClients,
  listKits,
  getStyleKit,
  searchAssets,
  addAssetToBoardDef,
  getLinearIssue,
  listTemplatesDef,
  createOutputDef,
  getOutputDef,
  updateOutputSlotsDef,
  updateOutputHtmlDef,
  placeOutputDef,
  designOutputDef,
  pickDesignVariantDef,
  postLinearCommentDef,
]
