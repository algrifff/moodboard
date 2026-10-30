import type Anthropic from '@anthropic-ai/sdk'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { z } from 'zod'
import { CANVAS_TOOLS, type ToolContext } from './canvasTools'
import type { OrchestratorTools } from './orchestrator'

// The canvas tools as Messages API tool definitions, bound to one board.
// Same zod shapes the MCP server registers, converted with the MCP SDK's
// converter so the two transports can't drift.

const definitions: Anthropic.Tool[] = CANVAS_TOOLS.map((tool) => {
  const { $schema: _ignored, ...schema } = toJsonSchemaCompat(z.object(tool.input)) as {
    $schema?: string
  } & Anthropic.Tool.InputSchema
  return { name: tool.name, description: tool.description, input_schema: schema }
})

export function boardToolset(ctx: ToolContext): OrchestratorTools {
  return {
    definitions,
    run: async (name, input, opts) => {
      const tool = CANVAS_TOOLS.find((t) => t.name === name)
      if (!tool) return { ok: false, error: `Unknown tool: ${name}` }
      return tool.run({ ...ctx, ...opts }, input)
    },
  }
}
