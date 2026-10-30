import { agentIdSchema, groupId, proximityGroups, type AgentId } from '@moodboard/shared'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { desc } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db, schema } from '../db'
import { loadBoardObjects, loadObjectsByBoard } from './boardObjects'
import { boardUrl, CANVAS_TOOLS } from './canvasTools'
import { analysisNotConfigured, runSynthesisOnGroup } from './groupAnalysis'

// Each MCP request is one-shot; we build a fresh server with the
// authenticated user's id closed into every tool. The transport in
// routes/mcp.ts calls buildMcpServer(userId) on every POST. Canvas tools
// come from lib/canvasTools.ts (shared with the sidebar orchestrator); MCP
// adds the boardId argument since a client isn't bound to one board.

const boardIdSchema = z
  .string()
  .min(1)
  .describe('The board id returned by create_board / list_boards.')

const ANALYZE_AGENTS_DEFAULT: AgentId[] = ['art-director', 'copywriter']

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function error(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] }
}

export function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({ name: 'moodboard', version: '0.2.0' })

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
      const objectsByBoard = await loadObjectsByBoard(rows.map((r) => r.id))
      const boards = rows.map((r) => {
        const objects = objectsByBoard.get(r.id) ?? []
        const objectsByType: Record<string, number> = {}
        for (const o of objects) objectsByType[o.type] = (objectsByType[o.type] ?? 0) + 1
        return {
          id: r.id,
          name: r.name,
          objectCount: objects.length,
          objectsByType,
          url: boardUrl(r.id),
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        }
      })
      return json({ boards })
    },
  )

  server.registerTool(
    'create_board',
    {
      title: 'Create a board',
      description:
        'Create a new empty moodboard. Returns the boardId and a viewer URL the user can open in their browser. Subsequent tools take this boardId.',
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
      const [row] = await db
        .insert(schema.board)
        .values({ id: nanoid(), createdBy: userId, name: name ?? 'Untitled board' })
        .returning()
      if (!row) return error('Failed to create board.')
      return json({ boardId: row.id, name: row.name, url: boardUrl(row.id) })
    },
  )

  for (const tool of CANVAS_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: { boardId: boardIdSchema, ...tool.input },
      },
      async (args: Record<string, unknown>) => {
        const { boardId, ...input } = args as { boardId: string } & Record<string, unknown>
        const outcome = await tool.run({ boardId, userId }, input)
        if (!outcome.ok) return error(outcome.error)
        return json({ ...outcome.payload, boardUrl: boardUrl(boardId) })
      },
    )
  }

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
      const objects = (await loadBoardObjects(boardId)).map((v) => v.object)
      const byId = new Map(objects.map((o) => [o.id, o]))
      const groups = proximityGroups(objects)
      if (groups.length === 0) {
        return json({
          briefs: [],
          note: 'No groups on the board — drop two objects within 48px of each other to form one.',
        })
      }
      const agentIds = agents && agents.length >= 2 ? agents : ANALYZE_AGENTS_DEFAULT
      const briefs: { groupKey: string; objectIds: string[]; brief: unknown }[] = []
      for (const ids of groups) {
        const items = ids.flatMap((id) => byId.get(id) ?? [])
        try {
          const run = await runSynthesisOnGroup(boardId, items, agentIds)
          briefs.push({ groupKey: groupId(ids), objectIds: ids, brief: run.data })
        } catch (e) {
          const msg = analysisNotConfigured(e) ?? (e instanceof Error ? e.message : String(e))
          return error(`Synthesis failed for group ${groupId(ids)}: ${msg}`)
        }
      }
      return json({ briefs })
    },
  )

  return server
}
