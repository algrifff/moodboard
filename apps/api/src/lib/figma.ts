import { z } from 'zod'

// Figma over its REST API with plain fetch (no SDK), read-only. Nothing here
// touches the database, so the OAuth requests, the responses we read and the
// error mapping are tested against fixture responses with a fake fetch
// (figma.test.ts). The stored connection and token refresh live in
// figmaConnection.ts; importing frames and styles in figmaImport.ts.
//
// Endpoints (https://www.figma.com/developers/api):
//   GET  /v1/me                         current_user:read
//   GET  /v1/files/:key                 file_content:read (+ file_metadata:read)
//   GET  /v1/files/:key/nodes?ids=      file_content:read
//   GET  /v1/images/:key?ids=           file_content:read
//   GET  /v1/files/:key/styles          library_content:read (published styles)
//   GET  /v1/files/:key/variables/local file_variables:read (Enterprise plans)

export const FIGMA_AUTHORIZE_URL = 'https://www.figma.com/oauth'
const DEFAULT_API_BASE = 'https://api.figma.com'

// Read-only scopes. Variables need `file_variables:read`, which only
// Enterprise plans can grant — add it to FIGMA_SCOPES there; without it the
// kit import simply skips variables.
export const FIGMA_DEFAULT_SCOPES =
  'current_user:read,file_content:read,file_metadata:read,library_content:read'

export type FetchLike = typeof fetch

export class FigmaApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterSec: number | null = null,
  ) {
    super(message)
    this.name = 'FigmaApiError'
  }
}

export function figmaEnv(): {
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes: string
} | null {
  const clientId = process.env.FIGMA_CLIENT_ID
  const clientSecret = process.env.FIGMA_CLIENT_SECRET
  const redirectUri = process.env.FIGMA_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) return null
  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes: process.env.FIGMA_SCOPES?.trim() || FIGMA_DEFAULT_SCOPES,
  }
}

// Overridable so the whole flow can run against a stand-in Figma in tests;
// unset, it is api.figma.com.
export function figmaApiBase(): string {
  return (process.env.FIGMA_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// The shapes we read. Node trees are large and loosely typed on Figma's side,
// so only the envelopes are validated; the tree is read defensively.
// ---------------------------------------------------------------------------

export type FigmaPaint = {
  type?: string
  visible?: boolean
  opacity?: number
  color?: { r: number; g: number; b: number; a?: number }
}

export type FigmaNode = {
  id: string
  name?: string
  type?: string
  visible?: boolean
  children?: FigmaNode[]
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null
  fills?: FigmaPaint[]
  strokes?: FigmaPaint[]
  effects?: { type?: string; visible?: boolean }[]
  styles?: Record<string, string>
  layoutMode?: string
  layoutWrap?: string
  itemSpacing?: number
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  primaryAxisAlignItems?: string
  counterAxisAlignItems?: string
  cornerRadius?: number
  opacity?: number
  characters?: string
  style?: {
    fontFamily?: string
    fontWeight?: number
    fontSize?: number
    lineHeightPx?: number
    textAlignHorizontal?: string
  }
}

export type FigmaStyleMeta = { key?: string; name: string; styleType: string; description?: string }

const nodeSchema = z.custom<FigmaNode>(
  (v) => typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string',
)

const styleMapSchema = z
  .record(
    z.object({
      key: z.string().optional(),
      name: z.string(),
      styleType: z.string(),
      description: z.string().optional(),
    }),
  )
  .optional()

const fileSchema = z.object({
  name: z.string(),
  lastModified: z.string(),
  version: z.string().optional(),
  document: nodeSchema,
  styles: styleMapSchema,
})
export type FigmaFile = z.infer<typeof fileSchema>

const nodesSchema = z.object({
  name: z.string(),
  lastModified: z.string(),
  version: z.string().optional(),
  nodes: z.record(z.object({ document: nodeSchema, styles: styleMapSchema }).nullable()),
})
export type FigmaNodes = z.infer<typeof nodesSchema>

const imagesSchema = z.object({
  err: z.string().nullish(),
  images: z.record(z.string().nullable()),
})

const meSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  handle: z.string().optional(),
})
export type FigmaMe = z.infer<typeof meSchema>

const publishedStylesSchema = z.object({
  meta: z.object({
    styles: z.array(
      z.object({
        key: z.string(),
        node_id: z.string(),
        style_type: z.string(),
        name: z.string(),
        description: z.string().optional(),
      }),
    ),
  }),
})
export type FigmaPublishedStyle = z.infer<typeof publishedStylesSchema>['meta']['styles'][number]

const colourValueSchema = z.object({
  r: z.number(),
  g: z.number(),
  b: z.number(),
  a: z.number().optional(),
})
const variablesSchema = z.object({
  meta: z.object({
    variables: z.record(
      z.object({
        id: z.string(),
        name: z.string(),
        variableCollectionId: z.string(),
        resolvedType: z.string(),
        valuesByMode: z.record(z.unknown()),
        remote: z.boolean().optional(),
        hiddenFromPublishing: z.boolean().optional(),
      }),
    ),
    variableCollections: z.record(
      z.object({
        id: z.string(),
        name: z.string(),
        defaultModeId: z.string(),
        modes: z.array(z.object({ modeId: z.string(), name: z.string() })).optional(),
      }),
    ),
  }),
})
export type FigmaVariables = z.infer<typeof variablesSchema>['meta']

export function parseColourValue(
  v: unknown,
): { r: number; g: number; b: number; a: number } | null {
  const parsed = colourValueSchema.safeParse(v)
  return parsed.success ? { ...parsed.data, a: parsed.data.a ?? 1 } : null
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000
// A whole-file read for the kit import: big libraries are tens of MB.
const FILE_TIMEOUT_MS = 90_000
const MAX_JSON_BYTES = 80 * 1024 * 1024

async function errorFrom(res: Response): Promise<FigmaApiError> {
  const body = (await res.json().catch(() => null)) as { err?: unknown; message?: unknown } | null
  const detail =
    (typeof body?.err === 'string' && body.err) ||
    (typeof body?.message === 'string' && body.message) ||
    res.statusText ||
    'Figma request failed'
  const retry = Number(res.headers.get('retry-after'))
  const message =
    res.status === 404
      ? 'Figma couldn’t find that file or frame — check the link and that your account can open it.'
      : res.status === 403
        ? `Figma refused access (${detail}).`
        : res.status === 429
          ? 'Figma is rate limiting requests; try again shortly.'
          : `Figma: ${detail}`
  return new FigmaApiError(res.status, message, Number.isFinite(retry) && retry > 0 ? retry : null)
}

export function figmaApi(
  token: string,
  fetchImpl: FetchLike = fetch,
  base: string = figmaApiBase(),
) {
  const get = async (path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> => {
    const res = await fetchImpl(`${base}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw await errorFrom(res)
    const text = await res.text()
    if (text.length > MAX_JSON_BYTES) {
      throw new FigmaApiError(413, 'That Figma file is too large to read in one go.')
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new FigmaApiError(502, 'Figma sent something that isn’t JSON.')
    }
  }
  const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, what: string): T => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new FigmaApiError(502, `Unexpected ${what} response from Figma.`)
    return parsed.data
  }
  const ids = (list: string[]) => encodeURIComponent(list.join(','))

  return {
    async me(): Promise<FigmaMe> {
      return parse(meSchema, await get('/v1/me'), 'account')
    },
    // `depth` limits how far down the tree Figma answers; omit for all of it.
    async file(
      fileKey: string,
      opts: { depth?: number; whole?: boolean } = {},
    ): Promise<FigmaFile> {
      const query = opts.depth ? `?depth=${opts.depth}` : ''
      const raw = await get(
        `/v1/files/${encodeURIComponent(fileKey)}${query}`,
        opts.whole ? FILE_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
      )
      return parse(fileSchema, raw, 'file')
    },
    async nodes(
      fileKey: string,
      nodeIds: string[],
      opts: { depth?: number } = {},
    ): Promise<FigmaNodes> {
      const depth = opts.depth ? `&depth=${opts.depth}` : ''
      const raw = await get(
        `/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${ids(nodeIds)}${depth}`,
      )
      return parse(nodesSchema, raw, 'nodes')
    },
    // node id → temporary image URL (null when Figma couldn't render it).
    async images(
      fileKey: string,
      nodeIds: string[],
      opts: { scale: number; format?: 'png' | 'jpg' },
    ): Promise<Record<string, string | null>> {
      const raw = await get(
        `/v1/images/${encodeURIComponent(fileKey)}?ids=${ids(nodeIds)}&format=${opts.format ?? 'png'}&scale=${opts.scale}`,
      )
      const parsed = parse(imagesSchema, raw, 'images')
      if (parsed.err) throw new FigmaApiError(502, `Figma couldn’t render that: ${parsed.err}`)
      return parsed.images
    },
    async publishedStyles(fileKey: string): Promise<FigmaPublishedStyle[]> {
      const raw = await get(`/v1/files/${encodeURIComponent(fileKey)}/styles`)
      return parse(publishedStylesSchema, raw, 'styles').meta.styles
    },
    async localVariables(fileKey: string): Promise<FigmaVariables> {
      const raw = await get(`/v1/files/${encodeURIComponent(fileKey)}/variables/local`)
      return parse(variablesSchema, raw, 'variables').meta
    },
  }
}
export type FigmaApi = ReturnType<typeof figmaApi>

// ---------------------------------------------------------------------------
// Rendered images
// ---------------------------------------------------------------------------

export const FIGMA_MAX_RENDER_BYTES = 25 * 1024 * 1024

export class FigmaRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FigmaRenderError'
  }
}

// Figma's images API answers with a short-lived URL (an S3 object). Fetch it
// with a size cap, refusing anything that isn't https to a public host — the
// one exception is the configured API origin itself, which is only ever
// something other than api.figma.com in a test stand-in.
export async function downloadRender(
  url: string,
  deps: {
    fetchImpl?: FetchLike
    base?: string
    checkHost: (hostname: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  },
): Promise<Buffer> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = deps.base ?? figmaApiBase()
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw new FigmaRenderError('Figma returned an unusable image link.')
  }
  const trusted = target.origin === new URL(base).origin
  if (!trusted) {
    if (target.protocol !== 'https:')
      throw new FigmaRenderError('Figma returned a non-https image link.')
    const check = await deps.checkHost(target.hostname)
    if (!check.ok) throw new FigmaRenderError(`Image host not allowed: ${check.reason}`)
  }
  const res = await fetchImpl(target.toString(), {
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new FigmaRenderError(`Figma’s image download failed (${res.status}).`)
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'image/png' && type !== 'image/jpeg') {
    throw new FigmaRenderError(`Figma’s image was ${type || 'an unknown type'}, not a PNG.`)
  }
  const declared = Number(res.headers.get('content-length'))
  if (declared > FIGMA_MAX_RENDER_BYTES) throw new FigmaRenderError('That frame renders too large.')
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.byteLength > FIGMA_MAX_RENDER_BYTES)
    throw new FigmaRenderError('That frame renders too large.')
  return bytes
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export type FigmaTokenResponse = {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
})

// Figma authenticates the app with HTTP Basic (client id : secret) and takes
// the grant as a form body. `refresh` keeps the same refresh token.
async function tokenRequest(
  endpoint: 'token' | 'refresh',
  params: Record<string, string>,
  env: { clientId: string; clientSecret: string },
  fetchImpl: FetchLike,
  base: string,
): Promise<FigmaTokenResponse> {
  const basic = Buffer.from(`${env.clientId}:${env.clientSecret}`).toString('base64')
  const res = await fetchImpl(`${base}/v1/oauth/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText)
    throw new FigmaApiError(res.status, `Figma token request failed: ${detail.slice(0, 200)}`)
  }
  const parsed = tokenResponseSchema.safeParse(await res.json().catch(() => null))
  if (!parsed.success) throw new FigmaApiError(502, 'Unexpected token response from Figma.')
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresIn: parsed.data.expires_in,
  }
}

export function exchangeFigmaCode(
  args: { code: string; clientId: string; clientSecret: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
  base: string = figmaApiBase(),
): Promise<FigmaTokenResponse> {
  return tokenRequest(
    'token',
    { redirect_uri: args.redirectUri, code: args.code, grant_type: 'authorization_code' },
    args,
    fetchImpl,
    base,
  )
}

export function refreshFigmaToken(
  args: { refreshToken: string; clientId: string; clientSecret: string },
  fetchImpl: FetchLike = fetch,
  base: string = figmaApiBase(),
): Promise<FigmaTokenResponse> {
  return tokenRequest('refresh', { refresh_token: args.refreshToken }, args, fetchImpl, base)
}
