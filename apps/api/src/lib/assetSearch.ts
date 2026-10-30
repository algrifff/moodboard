// Pure helpers for the asset library (no database), so they can be unit
// tested without one.

// The last path segment of a URL, as a name a person would recognise.
export function nameFromUrl(url: URL | string): string | null {
  let pathname: string
  try {
    pathname = (typeof url === 'string' ? new URL(url) : url).pathname
  } catch {
    return null
  }
  const last = pathname.split('/').filter(Boolean).pop()
  if (!last) return null
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

const MAX_QUERY_TERMS = 8
const MAX_TERM_LENGTH = 40

// User text → a to_tsquery string: every word must match, and the last-typed
// ones match as prefixes ("brand log" finds "brand logo"). Only letters and
// digits survive, so nothing a user types can be tsquery syntax.
export function buildTsQuery(input: string): string | null {
  const terms = (input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((t) => t.slice(0, MAX_TERM_LENGTH))
    .slice(0, MAX_QUERY_TERMS)
  if (terms.length === 0) return null
  return terms.map((t) => `${t}:*`).join(' & ')
}

export function thumbnailFor(row: {
  filename: string
  kind: string
  mediaKind: string
}): string | null {
  if (row.mediaKind === 'image') return `/api/files/${row.filename}`
  // A PDF's first-page render is recorded alongside it under the same id.
  if (row.mediaKind === 'pdf') return `/api/files/${row.filename.replace(/\.pdf$/i, '.png')}`
  return null
}
