// Notion REST API wrapper + blocks-to-markdown converter.
//
// We hit Notion directly via fetch — no SDK dep. The surface we need is
// narrow (search, fetch page metadata, walk a page's block tree, OAuth code
// exchange), the auth model is a static bearer token per request, and the
// JSON shapes are well-documented. Adding @notionhq/client just to call
// four endpoints would be a net loss.
//
// Endpoints used:
//   POST /v1/search                            — picker tile search
//   GET  /v1/pages/{id}                        — page metadata
//   GET  /v1/blocks/{id}/children?start_cursor — paginated block listing
//   POST /v1/oauth/token                       — OAuth code → access token
//
// The Notion-Version header is required on every call. 2022-06-28 is the
// long-standing stable version and Notion has been good about not breaking
// it; bump when we explicitly opt into newer block types.

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

// ---------------------------------------------------------------------------
// Notion block types we recognise. The full Notion schema is huge — this
// covers ~95% of what shows up in real brand-strategy / brief docs. Anything
// else falls through to an `<!-- unsupported: type -->` placeholder so the
// markdown still parses, the page still renders, and we don't silently lose
// content the user might be looking for.
// ---------------------------------------------------------------------------

export type NotionRichText = {
  type: string
  plain_text: string
  href: string | null
  annotations: {
    bold?: boolean
    italic?: boolean
    strikethrough?: boolean
    underline?: boolean
    code?: boolean
    color?: string
  }
}

export type NotionBlock = {
  id: string
  type: string
  has_children: boolean
  // Each block type stores its content under a key matching its type name.
  // We type-narrow with `as` at use sites rather than enumerating every
  // payload variant — the shape is wide and we only read a few fields.
  [k: string]: unknown
  // Populated post-hoc by getPageBlocks when has_children is true.
  children?: NotionBlock[]
}

export type NotionPageSummary = {
  id: string
  title: string
  iconEmoji?: string
  iconUrl?: string
  coverUrl?: string
  url: string
  lastEditedTime: string
}

export type NotionTokenResponse = {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  workspaceId: string
  workspaceName: string
  botId: string
  owner: { type: string; user?: { id: string; name?: string; person?: { email?: string } } }
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

class NotionApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'NotionApiError'
  }
}

async function notionFetch<T>(
  path: string,
  init: {
    method?: 'GET' | 'POST'
    token?: string
    basicAuth?: string
    body?: unknown
  },
): Promise<T> {
  const headers: Record<string, string> = {
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  if (init.basicAuth) headers.Authorization = `Basic ${init.basicAuth}`
  const res = await fetch(`${NOTION_API}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (!res.ok) {
    let code: string | undefined
    let message = res.statusText
    try {
      const errBody = (await res.json()) as { code?: string; message?: string }
      code = errBody.code
      if (errBody.message) message = errBody.message
    } catch {
      // Body wasn't JSON — keep the status text fallback.
    }
    throw new NotionApiError(res.status, code, message)
  }
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * Exchange an authorisation code for an access token. Notion's public
 * integration flow currently returns a non-expiring `access_token` and no
 * `refresh_token`; we still surface those fields so the storage layer can
 * carry them when (if) Notion adds expiry semantics.
 */
export async function exchangeCode(args: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
}): Promise<NotionTokenResponse> {
  const basicAuth = Buffer.from(`${args.clientId}:${args.clientSecret}`).toString('base64')
  type RawResponse = {
    access_token: string
    refresh_token?: string
    expires_in?: number
    workspace_id: string
    workspace_name: string
    bot_id: string
    owner?: NotionTokenResponse['owner']
  }
  const raw = await notionFetch<RawResponse>('/oauth/token', {
    method: 'POST',
    basicAuth,
    body: {
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.redirectUri,
    },
  })
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresIn: raw.expires_in,
    workspaceId: raw.workspace_id,
    workspaceName: raw.workspace_name,
    botId: raw.bot_id,
    owner: raw.owner ?? { type: 'unknown' },
  }
}

// ---------------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------------

/**
 * Search pages the integration has access to. Notion's search excludes
 * databases when we set `filter.value: 'page'`, which is what we want — we
 * surface pages only in the picker for now.
 */
export async function searchPages(args: {
  token: string
  query?: string
  startCursor?: string
  pageSize?: number
}): Promise<{ pages: NotionPageSummary[]; nextCursor?: string }> {
  type RawResult = {
    object: 'page'
    id: string
    url: string
    last_edited_time: string
    icon?: { type: 'emoji'; emoji: string } | { type: 'external'; external: { url: string } }
    cover?:
      | { type: 'external'; external: { url: string } }
      | { type: 'file'; file: { url: string } }
    properties: Record<string, unknown>
  }
  const raw = await notionFetch<{ results: RawResult[]; next_cursor: string | null }>('/search', {
    method: 'POST',
    token: args.token,
    body: {
      query: args.query ?? '',
      filter: { value: 'page', property: 'object' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: args.pageSize ?? 25,
      ...(args.startCursor ? { start_cursor: args.startCursor } : {}),
    },
  })
  const pages = raw.results.map((r) => projectPageSummary(r))
  return { pages, nextCursor: raw.next_cursor ?? undefined }
}

/** Fetch a single page's metadata. The block tree comes from getPageBlocks. */
export async function getPage(args: { token: string; pageId: string }): Promise<NotionPageSummary> {
  type RawPage = Parameters<typeof projectPageSummary>[0]
  const raw = await notionFetch<RawPage>(`/pages/${args.pageId}`, { token: args.token })
  return projectPageSummary(raw)
}

/**
 * List the sub-pages directly under a Notion page. Iterates the page's
 * blocks (paginated) and filters to `child_page` entries — each one's
 * `id` doubles as the sub-page's page id. We don't enrich with
 * icon/lastEdited per child (that'd require N extra requests); the
 * picker shows the title + a default page glyph until imported.
 */
export async function getChildPages(args: {
  token: string
  parentId: string
}): Promise<{ id: string; title: string }[]> {
  const all: { id: string; title: string }[] = []
  let cursor: string | undefined
  // Same hard cap as getPageBlocks — 10 paginated calls × 100 = 1000 blocks.
  // Sub-page lists this big are vanishingly rare.
  for (let i = 0; i < 10; i += 1) {
    type Resp = { results: NotionBlock[]; next_cursor: string | null; has_more: boolean }
    const url = `/blocks/${args.parentId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`
    const res = await notionFetch<Resp>(url, { token: args.token })
    for (const b of res.results) {
      if (b.type === 'child_page') {
        const title = ((b.child_page as { title?: string } | undefined)?.title ?? '').trim()
        all.push({ id: b.id, title: title || 'Untitled' })
      }
    }
    if (!res.has_more || !res.next_cursor) break
    cursor = res.next_cursor
  }
  return all
}

/**
 * Walk a page's block tree top-down. Recurses one level into `has_children`
 * blocks for toggles / columns / list-item children so the markdown
 * converter can indent nested content. We don't recurse below depth 2 —
 * deeper docs are rare for brand briefs and infinite recursion would
 * unbounded-blow up token use in the AD prompt.
 */
export async function getPageBlocks(args: {
  token: string
  pageId: string
  maxDepth?: number
}): Promise<NotionBlock[]> {
  return await loadChildrenRecursive(args.token, args.pageId, 0, args.maxDepth ?? 2)
}

async function loadChildrenRecursive(
  token: string,
  parentId: string,
  depth: number,
  maxDepth: number,
): Promise<NotionBlock[]> {
  if (depth > maxDepth) return []
  const all: NotionBlock[] = []
  let cursor: string | undefined
  // Notion paginates at 100 blocks per call; loop until exhausted.
  // Hard cap at 1000 blocks per page (10 paginated calls) — defensive
  // against runaway docs.
  for (let i = 0; i < 10; i += 1) {
    type Resp = { results: NotionBlock[]; next_cursor: string | null; has_more: boolean }
    const url = `/blocks/${parentId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`
    const res = await notionFetch<Resp>(url, { token })
    all.push(...res.results)
    if (!res.has_more || !res.next_cursor) break
    cursor = res.next_cursor
  }
  if (depth < maxDepth) {
    for (const b of all) {
      if (b.has_children) {
        b.children = await loadChildrenRecursive(token, b.id, depth + 1, maxDepth)
      }
    }
  }
  return all
}

// Extracts the human-meaningful bits of a Notion page object. Title lives in
// the `properties` map under whatever the title property is named — for
// real pages it's almost always "title"/"Name", but we scan for the first
// property of type 'title' to be safe across workspaces.
type RawPage = {
  id: string
  url: string
  last_edited_time: string
  icon?: { type: 'emoji'; emoji: string } | { type: 'external'; external: { url: string } }
  cover?: { type: 'external'; external: { url: string } } | { type: 'file'; file: { url: string } }
  properties: Record<string, unknown>
}
function projectPageSummary(raw: RawPage): NotionPageSummary {
  const title = extractTitle(raw.properties)
  const summary: NotionPageSummary = {
    id: raw.id,
    title: title || 'Untitled',
    url: raw.url,
    lastEditedTime: raw.last_edited_time,
  }
  if (raw.icon?.type === 'emoji') summary.iconEmoji = raw.icon.emoji
  if (raw.icon?.type === 'external') summary.iconUrl = raw.icon.external.url
  if (raw.cover?.type === 'external') summary.coverUrl = raw.cover.external.url
  else if (raw.cover?.type === 'file') summary.coverUrl = raw.cover.file.url
  return summary
}

function extractTitle(properties: Record<string, unknown>): string {
  for (const v of Object.values(properties)) {
    if (!v || typeof v !== 'object') continue
    const prop = v as { type?: string; title?: { plain_text?: string }[] }
    if (prop.type === 'title' && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text ?? '').join('')
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// blocks → markdown
// ---------------------------------------------------------------------------

/**
 * Convert a recursively-loaded block tree to markdown. The AD reads this
 * directly + the on-canvas reader renders it via the existing react-markdown
 * pipeline (`.note-markdown` styles in apps/web/src/index.css).
 *
 * Numbered lists: Notion gives us no index, so we count consecutive
 * numbered_list_item siblings and emit `1. … 2. …`. Bulleted lists use `- `.
 * Nested children indent two spaces per level — standard markdown.
 */
export function blocksToMarkdown(blocks: NotionBlock[], depth = 0): string {
  const out: string[] = []
  let numberedIndex = 0
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i]!
    if (b.type === 'numbered_list_item') {
      numberedIndex += 1
    } else {
      numberedIndex = 0
    }
    // Per-block try/catch so one malformed block can't halt the rest of
    // the page. A skipped block leaves an HTML-comment breadcrumb that
    // renders invisibly in markdown — the rest of the document still
    // makes it into the snapshot + the AD prompt.
    let rendered: string
    try {
      rendered = renderBlock(b, depth, numberedIndex)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      rendered = `<!-- notion block render error (${b.type}): ${msg.replace(/-->/g, '-- >')} -->`
    }
    if (rendered) out.push(rendered)
  }
  // Strip trailing whitespace only — `.trim()` would also kill the leading
  // indent of nested calls (e.g. blocksToMarkdown(children, depth+1) on a
  // single indented block).
  return out.join('\n\n').replace(/\s+$/, '')
}

function renderBlock(b: NotionBlock, depth: number, numberedIndex: number): string {
  const indent = '  '.repeat(depth)
  const payload = b[b.type] as Record<string, unknown> | undefined
  const richText = (payload?.rich_text ?? []) as NotionRichText[]

  switch (b.type) {
    case 'paragraph': {
      const text = renderRichText(richText)
      const withChildren = appendChildren(b, depth)
      return text ? `${indent}${text}${withChildren}` : withChildren.trim()
    }
    case 'heading_1':
      return `${indent}# ${renderRichText(richText)}`
    case 'heading_2':
      return `${indent}## ${renderRichText(richText)}`
    case 'heading_3':
      return `${indent}### ${renderRichText(richText)}`
    case 'bulleted_list_item': {
      const line = `${indent}- ${renderRichText(richText)}`
      return joinWithChildren(line, b, depth)
    }
    case 'numbered_list_item': {
      const line = `${indent}${numberedIndex}. ${renderRichText(richText)}`
      return joinWithChildren(line, b, depth)
    }
    case 'to_do': {
      const checked = (payload?.checked as boolean | undefined) ?? false
      const line = `${indent}- [${checked ? 'x' : ' '}] ${renderRichText(richText)}`
      return joinWithChildren(line, b, depth)
    }
    case 'toggle': {
      // Render the toggle summary as a paragraph + indented children — most
      // markdown renderers don't support <details>, and the AD reads
      // markdown not HTML.
      const summary = `${indent}${renderRichText(richText)}`
      return joinWithChildren(summary, b, depth)
    }
    case 'quote': {
      const line = `${indent}> ${renderRichText(richText)}`
      return joinWithChildren(line, b, depth)
    }
    case 'callout': {
      const icon = (payload?.icon as { type?: string; emoji?: string } | undefined)?.emoji ?? '💡'
      const line = `${indent}> ${icon} ${renderRichText(richText)}`
      return joinWithChildren(line, b, depth)
    }
    case 'code': {
      const lang = (payload?.language as string | undefined) ?? ''
      const body = (richText.map((r) => r.plain_text).join('') ?? '').trim()
      // Code blocks don't indent — they'd break the fence
      return `\`\`\`${lang}\n${body}\n\`\`\``
    }
    case 'divider':
      return `${indent}---`
    case 'image': {
      const file = payload as
        | {
            type?: string
            external?: { url: string }
            file?: { url: string }
            caption?: NotionRichText[]
          }
        | undefined
      const url = file?.external?.url ?? file?.file?.url ?? ''
      const alt = renderRichText((file?.caption ?? []) as NotionRichText[]) || 'image'
      return `${indent}![${alt}](${url})`
    }
    case 'bookmark':
    case 'link_preview': {
      const url = (payload?.url as string | undefined) ?? ''
      return `${indent}[${url}](${url})`
    }
    // ---------- Layout containers ----------------------------------------
    // Notion's column / column_list / synced_block / template blocks are
    // purely structural — they hold children but contribute no content of
    // their own. Render the children inline at the same depth so the
    // content survives without the layout artifact.
    case 'column_list':
    case 'column':
    case 'synced_block':
    case 'template':
    case 'breadcrumb': {
      if (!b.children || b.children.length === 0) return ''
      return blocksToMarkdown(b.children, depth)
    }
    // ---------- Child pages / cross-page links ---------------------------
    // child_page (a nested Notion page) — we can't inline the content
    // without recursing into another full page fetch, so surface it as an
    // inline-rendered breadcrumb. The AD still gets the title hint.
    case 'child_page': {
      const title = (payload?.title as string | undefined) ?? 'Untitled subpage'
      return `${indent}- 📄 ${title} (sub-page)`
    }
    case 'child_database': {
      const title = (payload?.title as string | undefined) ?? 'Untitled database'
      return `${indent}- 🗄 ${title} (database)`
    }
    case 'link_to_page': {
      const ref =
        (payload?.page_id as string | undefined) ??
        (payload?.database_id as string | undefined) ??
        ''
      return `${indent}- 🔗 (linked: ${ref})`
    }
    // ---------- Media — render as a link, no inline embedding ------------
    case 'video':
    case 'audio':
    case 'file':
    case 'pdf':
    case 'embed': {
      const media = payload as
        | { type?: string; external?: { url: string }; file?: { url: string }; url?: string }
        | undefined
      const url = media?.url ?? media?.external?.url ?? media?.file?.url ?? ''
      const label = b.type[0]!.toUpperCase() + b.type.slice(1)
      if (!url) return `${indent}<!-- ${label} (no url) -->`
      return `${indent}[${label}](${url})`
    }
    // ---------- Math --------------------------------------------------------
    case 'equation': {
      const expr = (payload?.expression as string | undefined) ?? ''
      return `${indent}\`${expr}\``
    }
    // ---------- Table — flatten the rows -----------------------------------
    // Notion serves `table_row` blocks as the table's children. The table
    // block itself has `has_column_header`/`has_row_header` metadata, which
    // we ignore here — a plain pipe table is enough for the AD to read.
    case 'table': {
      if (!b.children || b.children.length === 0) return ''
      const rows: string[][] = []
      for (const child of b.children) {
        if (child.type !== 'table_row') continue
        const cells = ((child.table_row as { cells?: NotionRichText[][] } | undefined)?.cells ??
          []) as NotionRichText[][]
        rows.push(cells.map((c) => renderRichText(c).replace(/\|/g, '\\|')))
      }
      if (rows.length === 0) return ''
      const widths = rows[0]!.map((_, col) =>
        Math.max(...rows.map((r) => (r[col] ?? '').length), 3),
      )
      const fmt = (r: string[]) =>
        `${indent}| ${r.map((c, i) => c.padEnd(widths[i] ?? 3)).join(' | ')} |`
      const lines = [fmt(rows[0]!)]
      lines.push(`${indent}| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`)
      for (let r = 1; r < rows.length; r += 1) lines.push(fmt(rows[r]!))
      return lines.join('\n')
    }
    case 'table_row':
      // Handled by the parent table case; emit nothing on its own.
      return ''
    default:
      // Anything we don't recognise — keep a breadcrumb so a reader can see
      // something was dropped, without polluting the AD prompt.
      return `${indent}<!-- unsupported notion block: ${b.type} -->`
  }
}

function joinWithChildren(line: string, b: NotionBlock, depth: number): string {
  if (!b.children || b.children.length === 0) return line
  const childMd = blocksToMarkdown(b.children, depth + 1)
  return `${line}\n${childMd}`
}

function appendChildren(b: NotionBlock, depth: number): string {
  if (!b.children || b.children.length === 0) return ''
  return `\n${blocksToMarkdown(b.children, depth + 1)}`
}

/**
 * Render Notion rich-text spans to markdown. Order of annotation wrapping
 * matters: code wraps innermost (otherwise *`x`* renders weirdly), then
 * bold/italic, then strikethrough, then link.
 */
export function renderRichText(spans: NotionRichText[]): string {
  return spans
    .map((s) => {
      let text = s.plain_text ?? ''
      if (!text) return ''
      const a = s.annotations ?? {}
      if (a.code) text = `\`${text}\``
      if (a.bold) text = `**${text}**`
      if (a.italic) text = `*${text}*`
      if (a.strikethrough) text = `~~${text}~~`
      if (s.href) text = `[${text}](${s.href})`
      return text
    })
    .join('')
}

export { NotionApiError }
