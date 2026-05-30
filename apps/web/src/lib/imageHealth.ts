// Session-scoped negative cache for image URLs we've already failed to
// load. Shared between ImageNode (Konva render path) and palette.ts
// (Vibrant extraction path) so the *first* component to discover a dead
// URL prevents the *second* from re-issuing the same fetch — collapses
// what used to be 2+ console 404s per orphaned image down to one.
//
// "Dead" means the browser produced a network error or non-image
// response. We don't try to distinguish 404 from CORS from DNS; any
// failure shape means we can't render or palette-extract this URL, and
// we don't want to keep asking.
//
// Cache is module-scoped + intentionally never cleared. Page reload is
// the manual reset; if the file genuinely comes back online, the user
// either re-paste / re-import or refreshes. We don't try to be cleverer
// than that.

const dead = new Set<string>()

export function markImageDead(url: string): void {
  dead.add(url)
}

export function isImageDead(url: string): boolean {
  return dead.has(url)
}
