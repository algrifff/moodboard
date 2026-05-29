// Pure colour helpers — kept in a lib file so they're trivially unit
// testable and reusable across components.

const HEX_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Pick a readable foreground colour (dark or light) for a given background
 * hex using standard ITU-R BT.601 luma weighting. Threshold tuned so
 * mid-tones (yellow, light blue) get dark text and saturated darks get
 * light text. Returns the dark fallback for malformed input.
 */
export function readableOn(hex: string): string {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) return '#0f172a'
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  return lum > 0.55 ? '#0f172a' : '#f8fafc'
}
