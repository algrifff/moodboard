/**
 * Derive a CSS font-family from an uploaded filename. Best-effort: strips
 * the path + extension, replaces dashes/underscores with spaces. We don't
 * try to parse the font binary for the canonical typeface name — that
 * would mean shipping fontkit or opentype.js as a runtime dep, and
 * filename-derived families work for the most common case where users
 * upload files named after the typeface.
 *
 * "AktivGrotesk-Bold.woff2"          → "AktivGrotesk Bold"
 * "/uploads/inter_variable.ttf"      → "inter variable"
 * "noname"                           → "noname"
 * ""                                 → "Custom Font"
 */
export function deriveFontFamily(filename: string): string {
  const lastSlash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'))
  const base = lastSlash >= 0 ? filename.slice(lastSlash + 1) : filename
  const dot = base.lastIndexOf('.')
  const stem = dot >= 0 ? base.slice(0, dot) : base
  return stem.replace(/[-_]+/g, ' ').trim() || 'Custom Font'
}
