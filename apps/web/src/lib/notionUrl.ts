// Notion page URL recogniser. Public Notion URLs come in a few flavours:
//
//   https://www.notion.so/Page-Title-12345678abcdef1234567890abcdef12
//   https://www.notion.so/workspace/Page-Title-12345678abcdef1234567890abcdef12
//   https://notion.so/Page-12345678abcdef1234567890abcdef12
//   https://www.notion.site/...                       (public-published pages)
//   https://www.notion.so/Page-Title-12345678-abcd-1234-abcd-1234567890ab
//
// The trailing 32 hex chars (with or without dashes) is the page UUID. We
// normalise to the plain 32-char form — Notion's REST API accepts both,
// but a consistent shape makes downstream lookups cleaner.

const NOTION_HOST_RE = /(?:^|\.)notion\.(so|site)$/i

/**
 * Pull a Notion page id out of a URL string. Returns null if the URL
 * doesn't look like a Notion page link, or no 32-char id is present.
 */
export function extractNotionPageId(input: string): string | null {
  const url = parseUrl(input)
  if (!url) return null
  if (!NOTION_HOST_RE.test(url.hostname)) return null
  // Search the full path (and trailing fragment-less segment) for an id.
  const haystack = url.pathname + (url.search ? url.search : '')
  // Dashed UUID first — it's the canonical form Notion exposes via "Copy link".
  const dashed = haystack.match(
    /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})/i,
  )
  if (dashed) {
    return `${dashed[1]}${dashed[2]}${dashed[3]}${dashed[4]}${dashed[5]}`.toLowerCase()
  }
  const plain = haystack.match(/([0-9a-f]{32})/i)
  return plain?.[1]?.toLowerCase() ?? null
}

function parseUrl(s: string): URL | null {
  try {
    return new URL(s.trim())
  } catch {
    return null
  }
}
