import type { LookupAddress } from 'node:dns'
import { promises as dns } from 'node:dns'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_PDF_BYTES = 20 * 1024 * 1024
export const MAX_PDF_PAGES = 50
// Fonts are typically 30–200 KB (woff2) or 1–5 MB (full ttf/otf). Cap
// at 5 MB so a heavy-weight family doesn't push past.
export const MAX_FONT_BYTES = 5 * 1024 * 1024

export const PDF_MIME = 'application/pdf'

export const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
// Font MIME landscape is messy — browsers and OSes report several
// equivalents per format. Accept all the common ones; we re-validate by
// extension fallback when type is application/octet-stream.
export const ALLOWED_FONT_MIME = new Set([
  'font/ttf',
  'font/otf',
  'font/woff',
  'font/woff2',
  'application/font-woff',
  'application/font-woff2',
  'application/x-font-ttf',
  'application/x-font-otf',
])

const FONT_EXTS = new Set(['ttf', 'otf', 'woff', 'woff2'])

/** True when filename has a recognised font extension. Used as a fallback
 *  when the browser reports application/octet-stream for the upload. */
export function isFontFilename(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return FONT_EXTS.has(name.slice(dot + 1).toLowerCase())
}

export function extFromMime(mime: string): string | null {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'font/ttf':
    case 'application/x-font-ttf':
      return 'ttf'
    case 'font/otf':
    case 'application/x-font-otf':
      return 'otf'
    case 'font/woff':
    case 'application/font-woff':
      return 'woff'
    case 'font/woff2':
    case 'application/font-woff2':
      return 'woff2'
    default:
      return null
  }
}

export function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'ttf':
      return 'font/ttf'
    case 'otf':
      return 'font/otf'
    case 'woff':
      return 'font/woff'
    case 'woff2':
      return 'font/woff2'
    default:
      return 'application/octet-stream'
  }
}

// Reject hostnames that obviously resolve to ourselves before paying the DNS
// round-trip. The real check is below via DNS resolution.
const BLOCKED_LITERAL_HOSTS = new Set(['localhost', '0.0.0.0'])

function isPrivateIPv4(ip: string): boolean {
  if (/^10\./.test(ip)) return true
  if (/^192\.168\./.test(ip)) return true
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true
  if (/^169\.254\./.test(ip)) return true
  if (/^127\./.test(ip)) return true
  if (/^0\./.test(ip)) return true
  // metadata services
  if (ip === '169.254.169.254') return true
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1') return true
  if (lower === '::') return true
  if (lower.startsWith('fe80:')) return true // link-local
  if (lower.startsWith('fc')) return true // unique-local
  if (lower.startsWith('fd')) return true // unique-local
  // IPv4-mapped IPv6 (::ffff:127.0.0.1)
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length)
    if (/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(mapped)) {
      return isPrivateIPv4(mapped)
    }
  }
  return false
}

export function isPrivateIp(ip: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return isPrivateIPv4(ip)
  return isPrivateIPv6(ip)
}

export type SsrfCheckResult = { ok: true; addresses: string[] } | { ok: false; reason: string }

export async function resolveAndCheckHost(hostname: string): Promise<SsrfCheckResult> {
  const lower = hostname.toLowerCase()
  if (BLOCKED_LITERAL_HOSTS.has(lower)) {
    return { ok: false, reason: 'host not allowed' }
  }
  if (lower.endsWith('.local') || lower.endsWith('.internal')) {
    return { ok: false, reason: 'host not allowed' }
  }
  let addresses: LookupAddress[]
  try {
    addresses = await dns.lookup(hostname, { all: true })
  } catch {
    return { ok: false, reason: 'dns lookup failed' }
  }
  for (const a of addresses) {
    if (isPrivateIp(a.address)) {
      return { ok: false, reason: `resolves to private ip ${a.address}` }
    }
  }
  return { ok: true, addresses: addresses.map((a) => a.address) }
}
