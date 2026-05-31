import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AuthUser } from '../auth'
import { mcpAuth } from '../lib/mcpAuth'
import { buildMcpServer } from '../lib/mcpTools'
import { rateLimit } from '../lib/rateLimit'

type Variables = { user: AuthUser | null }
type McpCtx = Context<{ Variables: Variables }>

// MCP route — Streamable HTTP transport from @modelcontextprotocol/sdk
// in stateless mode. Each request spins up a fresh server with the
// authenticated user's id closed into every tool handler, hands the
// raw Fetch Request to the SDK's web-standard transport (so we don't
// have to bridge to Node streams), then closes both.
//
// JSON-mode response (no SSE upgrade) is enabled because every tool
// in this server returns synchronously; we don't push server-initiated
// events.

export const mcp = new Hono<{ Variables: Variables }>()

// 60/min/IP — generous for normal tool use (a typical Claude turn
// fires 1-5 calls) without letting a hostile client flood the
// Anthropic budget via analyze_board spam.
const mcpRateLimit = rateLimit({ scope: 'mcp', limit: 60, windowMs: 60_000 })

async function handle(c: McpCtx): Promise<Response> {
  const user = c.get('user')!
  const server = buildMcpServer(user.id)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(c.req.raw)
  } finally {
    void transport.close()
    void server.close()
  }
}

// Two entry points, same handler:
// - /api/mcp                 → expects Authorization: Bearer mb_…
// - /api/mcp/<plaintext>     → token in path; clients (Claude Code,
//                              Claude.ai's connector UI, Cursor) can
//                              paste the all-in-one URL with no extra
//                              header config.
mcp.all('/', mcpRateLimit, mcpAuth, handle)
mcp.all('/:token', mcpRateLimit, mcpAuth, handle)
