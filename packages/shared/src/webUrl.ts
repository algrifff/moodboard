// Generic web URL recogniser — the LAST fallback in the paste dispatcher.
//
// Returns the URL itself when the string is a fetchable http(s) URL that
// isn't already claimed by a more specific provider. Provider-specific
// recognisers (Notion, Drive) run earlier in the dispatch chain and
// short-circuit before this; here we explicitly bail on those hosts so a
// paste that didn't extract a provider-side id (malformed URL, share link
// with no id) doesn't get downgraded into a generic web page when the user
// clearly meant the provider.

const PROVIDER_HOSTS = [
  /(?:^|\.)notion\.(so|site)$/i,
  /^docs\.google\.com$/i,
  /^drive\.google\.com$/i,
  // Phase 15 — Spotify recogniser will be added to its dispatch slot.
  // Bail here too so a malformed Spotify URL doesn't become a "web page".
  /(?:^|\.)open\.spotify\.com$/i,
  // Phase 16 — video hosts.
  /(?:^|\.)youtube\.com$/i,
  /^youtu\.be$/i,
  /(?:^|\.)tiktok\.com$/i,
  /(?:^|\.)instagram\.com$/i,
  /(?:^|\.)vimeo\.com$/i,
]

/**
 * Pull a fetchable web URL out of a paste. Returns null when the input
 * isn't a URL, when the scheme isn't http(s), or when the host belongs to
 * a more specific provider whose own recogniser should run.
 */
export function extractWebUrl(input: string): string | null {
  const url = parseUrl(input)
  if (!url) return null
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (PROVIDER_HOSTS.some((re) => re.test(url.hostname))) return null
  // Strip credentials before handing off to the import endpoint.
  url.username = ''
  url.password = ''
  return url.toString()
}

function parseUrl(s: string): URL | null {
  try {
    return new URL(s.trim())
  } catch {
    return null
  }
}
