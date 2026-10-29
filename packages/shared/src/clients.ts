import { z } from 'zod'

// Phase 22 — clients. A client is the container a board, style kit or asset
// belongs to; "for this client" resolves here. Team-visible like everything
// else — `createdBy` is attribution only.

export const clientSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  boardCount: z.number().int(),
  kitCount: z.number().int(),
  createdAt: z.string(),
})
export type Client = z.infer<typeof clientSchema>

export const clientsResponseSchema = z.object({ clients: z.array(clientSchema) })
export const clientResponseSchema = z.object({ client: clientSchema })

export const CLIENT_NAME_MAX = 80
export const clientNameSchema = z.string().trim().min(1).max(CLIENT_NAME_MAX)
export const createClientRequestSchema = z.object({ name: clientNameSchema })
export const updateClientRequestSchema = z.object({ name: clientNameSchema })
export type CreateClientRequest = z.infer<typeof createClientRequestSchema>

// Stable, URL- and prompt-friendly handle. Renaming a client keeps its slug
// so references to it ("the acme kit") don't break.
export function slugify(name: string, max = 40): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return slug || 'client'
}

// Picks one of a few named things (clients, kits) by what a person or the
// model typed: exact id, then slug or name (case-insensitive), then a unique
// prefix/substring. More than one plausible match is `ambiguous`, so the
// caller can ask instead of guess.
export type NameMatch<T> =
  | { kind: 'found'; item: T }
  | { kind: 'ambiguous'; candidates: T[] }
  | { kind: 'none' }

export function matchNamed<T extends { id: string; name: string; slug?: string }>(
  items: T[],
  query: string,
): NameMatch<T> {
  const q = query.trim().toLowerCase()
  if (!q) return { kind: 'none' }
  const byId = items.find((i) => i.id === query.trim())
  if (byId) return { kind: 'found', item: byId }
  const exact = items.filter((i) => i.slug === q || i.name.toLowerCase() === q)
  if (exact.length === 1) return { kind: 'found', item: exact[0]! }
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact }
  const qSlug = slugify(q)
  const loose = items.filter(
    (i) => i.name.toLowerCase().includes(q) || (i.slug !== undefined && i.slug.includes(qSlug)),
  )
  if (loose.length === 1) return { kind: 'found', item: loose[0]! }
  if (loose.length > 1) return { kind: 'ambiguous', candidates: loose }
  return { kind: 'none' }
}
