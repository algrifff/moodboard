// Sign-up gate for the internal team. ALLOWED_EMAIL_DOMAINS is a
// comma-separated list (e.g. "acme.com,acme.studio"); unset or empty
// allows any domain so local dev works without config.
export function parseAllowedDomains(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
}

export function isEmailAllowed(email: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true
  const at = email.lastIndexOf('@')
  if (at < 0) return false
  const domain = email.slice(at + 1).toLowerCase()
  return allowedDomains.includes(domain)
}
