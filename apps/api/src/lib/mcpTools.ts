import {
  agentIdSchema,
  groupId,
  proximityGroups,
  type AgentId,
  type AIAnalysis,
  type CanvasObject,
  type SectionedParagraphs,
  type StickyData,
  type SynthesisBrief,
  type TextData,
  type VideoEditorBreakdown,
} from '@moodboard/shared'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { desc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db, schema } from '../db'
import { getAgent } from './agents'
import { DEFAULT_DEPTH, modelTag, synthesisModelTag, synthesizeGroup } from './analyze'
import { analysisHash } from './analysisHash'
import { nextSpot } from './canvasPlacement'
import { routeUrlToImporter } from './mcpUrlDispatch'
import { listGroupDisplays } from './recordGroupDisplay'
import { saveImageFromUrl } from './saveImageFromUrl'
import { getAgentResult } from '../routes/analyze'

// Each MCP request is one-shot; we build a fresh server with the
// authenticated user's id closed into every tool. The transport in
// routes/mcp.ts calls buildMcpServer(userId) on every POST.

// ---------------------------------------------------------------------------
// Helpers — board state mutation
// ---------------------------------------------------------------------------

type BoardData = { objects?: CanvasObject[]; scale?: number; offset?: { x: number; y: number } }

async function loadBoard(boardId: string) {
  const [row] = await db.select().from(schema.board).where(eq(schema.board.id, boardId)).limit(1)
  return row ?? null
}

async function appendObject(
  boardId: string,
  build: (objects: CanvasObject[]) => CanvasObject,
): Promise<{ object: CanvasObject; boardName: string } | null> {
  const row = await loadBoard(boardId)
  if (!row) return null
  const data = (row.data ?? {}) as BoardData
  const objects: CanvasObject[] = Array.isArray(data.objects) ? data.objects : []
  const newObject = build(objects)
  const nextData: BoardData = {
    objects: [...objects, newObject],
    scale: data.scale,
    offset: data.offset,
  }
  await db
    .update(schema.board)
    .set({ data: nextData, updatedAt: new Date() })
    .where(eq(schema.board.id, boardId))
  return { object: newObject, boardName: row.name }
}

// Pull the canonical viewer URL for a board. Used in tool outputs so
// the model can hand the user a clickable link.
function boardUrl(boardId: string): string {
  const base = process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'
  return `${base.replace(/\/$/, '')}/board/${boardId}`
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

// ---------------------------------------------------------------------------
// Read helpers — summary shape returned by list_boards / get_board
// ---------------------------------------------------------------------------

type BoardSummary = {
  id: string
  name: string
  objectCount: number
  objectsByType: Record<string, number>
  url: string
  createdAt: string
  updatedAt: string
}

function summariseBoardRow(row: typeof schema.board.$inferSelect): BoardSummary {
  const data = (row.data ?? {}) as BoardData
  const objects: CanvasObject[] = Array.isArray(data.objects) ? data.objects : []
  const byType: Record<string, number> = {}
  for (const o of objects) {
    byType[o.type] = (byType[o.type] ?? 0) + 1
  }
  return {
    id: row.id,
    name: row.name,
    objectCount: objects.length,
    objectsByType: byType,
    url: boardUrl(row.id),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Tool input schemas — kept simple so models pick correct args reliably.
// ---------------------------------------------------------------------------

const boardIdSchema = z
  .string()
  .min(1)
  .describe('The board id returned by create_board / list_boards.')

const ANALYZE_AGENTS_DEFAULT: AgentId[] = ['art-director', 'copywriter']

// ---------------------------------------------------------------------------
// Server builder — called per request by the transport
// ---------------------------------------------------------------------------

export function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({
    name: 'moodboard',
    version: '0.1.0',
  })

  // -------------------------------------------------------------------------
  // list_boards
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_boards',
    {
      title: 'List boards',
      description:
        "Return the team's most recent moodboards (up to 20). Each board has its id, name, object count, type breakdown, viewer URL, and timestamps. Use this to find an existing board to add to or to read.",
      inputSchema: {},
    },
    async () => {
      const rows = await db
        .select()
        .from(schema.board)
        .orderBy(desc(schema.board.updatedAt))
        .limit(20)
      const boards = rows.map(summariseBoardRow)
      return {
        content: [{ type: 'text', text: JSON.stringify({ boards }, null, 2) }],
      }
    },
  )

  // -------------------------------------------------------------------------
  // get_board
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_board',
    {
      title: 'Get board summary',
      description:
        'Return a concise summary of one board: name, object counts by type, group count, and any synthesised brief throughlines. Does NOT dump the full object list — pass verbose:true for that (large).',
      inputSchema: {
        boardId: boardIdSchema,
        verbose: z
          .boolean()
          .optional()
          .describe('When true, includes the full objects array. Defaults to false.'),
      },
    },
    async ({ boardId, verbose }) => {
      const row = await loadBoard(boardId)
      if (!row) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Board not found.' }],
        }
      }
      const summary = summariseBoardRow(row)
      const data = (row.data ?? {}) as BoardData
      const objects: CanvasObject[] = Array.isArray(data.objects) ? data.objects : []

      // Map current groups by their stable key so we can join against
      // the persisted display table.
      const idGroups = proximityGroups(objects)
      const groupKeyToIds = new Map<string, string[]>()
      for (const ids of idGroups) groupKeyToIds.set(groupId(ids), ids)

      const displays = await listGroupDisplays(boardId)
      // Filter to displays whose groupKey still corresponds to a live
      // group on the canvas. Orphans (membership changed → new key)
      // get hidden here; the table still keeps them for when a group
      // re-forms with the old composition.
      const analyses = displays
        .filter((d) => groupKeyToIds.has(d.groupKey))
        .map((d) => {
          const objectIds = groupKeyToIds.get(d.groupKey) ?? []
          const base = {
            groupKey: d.groupKey,
            objectIds,
            agentIds: d.agentIds,
            updatedAt: d.updatedAt.toISOString(),
          }
          switch (d.kind) {
            case 'brief': {
              const brief = d.data as SynthesisBrief
              return {
                ...base,
                kind: 'brief' as const,
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
              const ad = d.data as AIAnalysis
              return {
                ...base,
                kind: 'art-director' as const,
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
            case 'video': {
              return {
                ...base,
                kind: 'video-editor' as const,
                data: d.data as VideoEditorBreakdown,
              }
            }
            case 'sectioned':
            default: {
              return {
                ...base,
                kind: 'sectioned' as const,
                sections: (d.data as SectionedParagraphs).sections,
              }
            }
          }
        })

      const payload: Record<string, unknown> = {
        ...summary,
        groupCount: idGroups.length,
        analyses,
      }
      if (verbose) payload.objects = objects
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      }
    },
  )

  // -------------------------------------------------------------------------
  // create_board
  // -------------------------------------------------------------------------
  server.registerTool(
    'create_board',
    {
      title: 'Create a board',
      description:
        'Create a new empty moodboard. Returns the boardId and a viewer URL the user can open in their browser. Subsequent add_* tools take this boardId.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe("Display name. Defaults to 'Untitled board' if omitted."),
      },
    },
    async ({ name }) => {
      const id = nanoid()
      const [row] = await db
        .insert(schema.board)
        .values({
          id,
          createdBy: userId,
          name: name ?? 'Untitled board',
          data: {},
        })
        .returning()
      if (!row) {
        return { isError: true, content: [{ type: 'text', text: 'Failed to create board.' }] }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { boardId: row.id, name: row.name, url: boardUrl(row.id) },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // -------------------------------------------------------------------------
  // add_url — auto-dispatching importer
  // -------------------------------------------------------------------------
  server.registerTool(
    'add_url',
    {
      title: 'Add a URL to the board',
      description:
        'Smart importer. Detects whether the URL is a Spotify track/album/playlist, a Google Drive file, a video (YouTube/TikTok/Instagram/X/Vimeo), a direct image, or a generic web page, and drops the appropriate card on the board. Spotify/Drive require the user to have connected those providers in the dashboard first; the tool returns a clear instruction when missing.',
      inputSchema: {
        boardId: boardIdSchema,
        url: z
          .string()
          .describe('Any URL — public web pages, video links, image links, Spotify URIs, etc.'),
      },
    },
    async ({ boardId, url }) => {
      const board = await loadBoard(boardId)
      if (!board) {
        return { isError: true, content: [{ type: 'text', text: 'Board not found.' }] }
      }
      const dispatch = await routeUrlToImporter(url, userId)
      if (!dispatch.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: dispatch.error.message }],
        }
      }
      const result = dispatch.result

      const appended = await appendObject(boardId, (objects) => {
        const zIndex = objects.length
        switch (result.kind) {
          case 'web': {
            const spot = nextSpot(objects, WEB_DEFAULT_SIZE)
            return {
              id: nanoid(),
              type: 'web-page',
              position: spot,
              size: WEB_DEFAULT_SIZE,
              rotation: 0,
              zIndex,
              data: result.page,
            }
          }
          case 'video': {
            const spot = nextSpot(objects, VIDEO_DEFAULT_SIZE)
            return {
              id: nanoid(),
              type: 'video-clip',
              position: spot,
              size: VIDEO_DEFAULT_SIZE,
              rotation: 0,
              zIndex,
              data: result.data,
            }
          }
          case 'image':
          case 'drive-image': {
            const spot = nextSpot(objects, IMAGE_DEFAULT_SIZE)
            return {
              id: nanoid(),
              type: 'image',
              position: spot,
              size: IMAGE_DEFAULT_SIZE,
              rotation: 0,
              zIndex,
              data: result.data,
            }
          }
          case 'drive-file': {
            const spot = nextSpot(objects, DRIVE_DEFAULT_SIZE)
            return {
              id: nanoid(),
              type: 'drive-file',
              position: spot,
              size: DRIVE_DEFAULT_SIZE,
              rotation: 0,
              zIndex,
              data: result.data,
            }
          }
          case 'drive-folder': {
            const spot = nextSpot(objects, DRIVE_DEFAULT_SIZE)
            return {
              id: nanoid(),
              type: 'drive-folder',
              position: spot,
              size: DRIVE_DEFAULT_SIZE,
              rotation: 0,
              zIndex,
              data: result.data,
            }
          }
          case 'drive-pdf': {
            const spot = nextSpot(objects, PDF_DEFAULT_SIZE)
            return {
              id: nanoid(),
              type: 'pdf',
              position: spot,
              size: PDF_DEFAULT_SIZE,
              rotation: 0,
              zIndex,
              data: result.data,
            }
          }
          case 'spotify-playlist': {
            const spot = nextSpot(objects, SPOTIFY_PLAYLIST_SIZE)
            return {
              id: nanoid(),
              type: 'spotify-playlist',
              position: spot,
              size: SPOTIFY_PLAYLIST_SIZE,
              rotation: 0,
              zIndex,
              data: result.data,
            }
          }
          case 'spotify-track': {
            const spot = nextSpot(objects, SPOTIFY_TRACK_SIZE)
            return {
              id: nanoid(),
              type: 'spotify-track',
              position: spot,
              size: SPOTIFY_TRACK_SIZE,
              rotation: 0,
              zIndex,
              data: result.data,
            }
          }
          case 'spotify-album': {
            const spot = nextSpot(objects, SPOTIFY_PLAYLIST_SIZE)
            return {
              id: nanoid(),
              type: 'spotify-album',
              position: spot,
              size: SPOTIFY_PLAYLIST_SIZE,
              rotation: 0,
              zIndex,
              data: result.data,
            }
          }
        }
      })
      if (!appended) {
        return { isError: true, content: [{ type: 'text', text: 'Board disappeared mid-write.' }] }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                objectId: appended.object.id,
                type: appended.object.type,
                boardUrl: boardUrl(boardId),
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // -------------------------------------------------------------------------
  // add_note (sticky)
  // -------------------------------------------------------------------------
  server.registerTool(
    'add_note',
    {
      title: 'Add a sticky note',
      description:
        'Drop a sticky note on the board. Use this for short verbatim copy, tags, vibe descriptors, or anything textual you want the AI synthesis to read as a directive (not as long-form copy — use add_text for that).',
      inputSchema: {
        boardId: boardIdSchema,
        text: z.string().min(1).max(2000),
        color: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional()
          .describe('Hex like #FEF3C7. Defaults to pale yellow.'),
      },
    },
    async ({ boardId, text, color }) => {
      const appended = await appendObject(boardId, (objects) => {
        const spot = nextSpot(objects, STICKY_SIZE)
        const data: StickyData = { text, color: color ?? STICKY_DEFAULT_COLOR }
        return {
          id: nanoid(),
          type: 'sticky',
          position: spot,
          size: STICKY_SIZE,
          rotation: 0,
          zIndex: objects.length,
          data,
        }
      })
      if (!appended) return { isError: true, content: [{ type: 'text', text: 'Board not found.' }] }
      return {
        content: [
          { type: 'text', text: JSON.stringify({ objectId: appended.object.id }, null, 2) },
        ],
      }
    },
  )

  // -------------------------------------------------------------------------
  // add_text
  // -------------------------------------------------------------------------
  server.registerTool(
    'add_text',
    {
      title: 'Add a text node',
      description:
        'Drop a typography-styled text node on the board. Use this for headlines, body paragraphs, tagline candidates, or anything longer / more compositional than a sticky.',
      inputSchema: {
        boardId: boardIdSchema,
        text: z.string().min(1).max(4000),
        fontSize: z
          .number()
          .min(12)
          .max(72)
          .optional()
          .describe('Pixel font size. Defaults to 18.'),
      },
    },
    async ({ boardId, text, fontSize }) => {
      const appended = await appendObject(boardId, (objects) => {
        const size = sizeForText(text)
        const spot = nextSpot(objects, size)
        const data: TextData = {
          text,
          font: TEXT_DEFAULT_FONT,
          fontSize: fontSize ?? 18,
        }
        return {
          id: nanoid(),
          type: 'text',
          position: spot,
          size,
          rotation: 0,
          zIndex: objects.length,
          data,
        }
      })
      if (!appended) return { isError: true, content: [{ type: 'text', text: 'Board not found.' }] }
      return {
        content: [
          { type: 'text', text: JSON.stringify({ objectId: appended.object.id }, null, 2) },
        ],
      }
    },
  )

  // -------------------------------------------------------------------------
  // add_image
  // -------------------------------------------------------------------------
  server.registerTool(
    'add_image',
    {
      title: 'Add an image from a URL',
      description:
        'Download an image from a public URL and drop it on the board. The image is saved server-side so the canvas can render it even if the source goes away. Use this when you have a direct image URL — for a web page that contains images, use add_url instead (it captures the page + logos in one shot).',
      inputSchema: {
        boardId: boardIdSchema,
        url: z.string().url(),
      },
    },
    async ({ boardId, url }) => {
      const board = await loadBoard(boardId)
      if (!board) {
        return { isError: true, content: [{ type: 'text', text: 'Board not found.' }] }
      }
      try {
        const data = await saveImageFromUrl(url, userId)
        const appended = await appendObject(boardId, (objects) => {
          const spot = nextSpot(objects, IMAGE_DEFAULT_SIZE)
          return {
            id: nanoid(),
            type: 'image',
            position: spot,
            size: IMAGE_DEFAULT_SIZE,
            rotation: 0,
            zIndex: objects.length,
            data,
          }
        })
        if (!appended)
          return { isError: true, content: [{ type: 'text', text: 'Board not found.' }] }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ objectId: appended.object.id, imageUrl: data.url }, null, 2),
            },
          ],
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { isError: true, content: [{ type: 'text', text: `Image import failed: ${msg}` }] }
      }
    },
  )

  // -------------------------------------------------------------------------
  // analyze_board — run synthesis on every group, return briefs
  // -------------------------------------------------------------------------
  server.registerTool(
    'analyze_board',
    {
      title: 'Analyse the board',
      description:
        'Run synthesis on every group of objects on the board and return the resulting briefs (throughline, palette, references, audiences, channels, hooks, etc.). Groups are formed automatically by spatial proximity — drop related objects close together first. By default uses art-director + copywriter agents. Heavy operation; results are cached so re-runs on unchanged groups are free.',
      inputSchema: {
        boardId: boardIdSchema,
        agents: z
          .array(agentIdSchema)
          .min(2)
          .max(6)
          .optional()
          .describe('Agent ids to combine. Defaults to [art-director, copywriter].'),
      },
    },
    async ({ boardId, agents }) => {
      const row = await loadBoard(boardId)
      if (!row) return { isError: true, content: [{ type: 'text', text: 'Board not found.' }] }
      const data = (row.data ?? {}) as BoardData
      const objects = Array.isArray(data.objects) ? data.objects : []
      const idGroups = proximityGroups(objects)
      const byId = new Map(objects.map((o) => [o.id, o]))
      const groups = idGroups.map((ids) => ({
        key: groupId(ids),
        objectIds: ids,
        items: ids.map((id) => byId.get(id)).filter((o): o is CanvasObject => Boolean(o)),
      }))
      if (groups.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  briefs: [],
                  note: 'No groups on the board — drop two objects within 48px of each other to form one.',
                },
                null,
                2,
              ),
            },
          ],
        }
      }
      const agentIds = (agents && agents.length >= 2 ? agents : ANALYZE_AGENTS_DEFAULT)
        .slice()
        .sort()
      const depth = DEFAULT_DEPTH

      const briefs: { groupKey: string; objectIds: string[]; brief: SynthesisBrief }[] = []
      for (const g of groups) {
        const items = g.items
        if (items.length < 2) continue

        // Try the cache first.
        const synthTag = synthesisModelTag(agentIds, depth)
        const cacheKey = analysisHash(items, synthTag)
        const [hit] = await db
          .select()
          .from(schema.groupAnalysis)
          .where(eq(schema.groupAnalysis.cacheKey, cacheKey))
          .limit(1)
        if (hit) {
          briefs.push({
            groupKey: g.key,
            objectIds: g.objectIds,
            brief: hit.analysis as SynthesisBrief,
          })
          continue
        }

        // Cache miss — run each agent then synthesise.
        try {
          const agentResults: { id: AgentId; label: string; data: unknown }[] = []
          for (const id of agentIds) {
            const { data: agentData } = await getAgentResult(items, id, depth, false)
            agentResults.push({ id, label: getAgent(id).label, data: agentData })
          }
          const brief = (await synthesizeGroup(items, agentResults, depth)) as SynthesisBrief
          await db
            .insert(schema.groupAnalysis)
            .values({ cacheKey, model: synthTag, analysis: brief as object })
            .onConflictDoNothing()
          briefs.push({ groupKey: g.key, objectIds: g.objectIds, brief })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return {
            isError: true,
            content: [{ type: 'text', text: `Synthesis failed for group ${g.key}: ${msg}` }],
          }
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ briefs }, null, 2) }],
      }
    },
  )

  return server
}

// Avoid unused-import errors; modelTag is exported from analyze for
// completeness but the MCP path uses synthesisModelTag exclusively.
void modelTag
