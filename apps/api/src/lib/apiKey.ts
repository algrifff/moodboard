import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, schema } from '../db'

// Plaintext keys are `mb_` + 32 base62 characters. The prefix is sized
// so a glance at the dashboard is enough to disambiguate keys without
// revealing more than necessary — `mb_AbCdEf…` lands at 9 visible
// characters when paired with the elided remainder.
const KEY_PREFIX = 'mb_'
const KEY_BODY_LENGTH = 32
const DISPLAY_PREFIX_LENGTH = 7 // includes the `mb_`

export type MintedKey = {
  id: string
  plaintext: string // shown ONCE; never stored
  prefix: string
  hashedKey: string
}

// nanoid's default alphabet is URL-safe and base62-equivalent.
function generatePlaintext(): string {
  return `${KEY_PREFIX}${nanoid(KEY_BODY_LENGTH)}`
}

export function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

export function displayPrefix(plaintext: string): string {
  return plaintext.slice(0, DISPLAY_PREFIX_LENGTH)
}

// Mint and persist a new key for a user. The caller (the /api/keys POST
// route) is responsible for returning the plaintext to the user — it
// must not be read from this module after this call.
export async function mintApiKey(args: { userId: string; name: string }): Promise<MintedKey> {
  const plaintext = generatePlaintext()
  const prefix = displayPrefix(plaintext)
  const hashedKey = hashKey(plaintext)
  const id = nanoid()
  await db.insert(schema.apiKey).values({
    id,
    userId: args.userId,
    name: args.name,
    prefix,
    hashedKey,
  })
  return { id, plaintext, prefix, hashedKey }
}

export type ResolvedKey = { userId: string; keyId: string }

// Look a plaintext key up by its hash. Returns null when there's no
// match or the format is wrong. Caller is expected to bump lastUsedAt
// after a successful resolve — separated to keep the read path pure
// and let the bump fire-and-forget (we don't want a slow update to
// block the MCP request).
export async function resolveApiKey(plaintext: string): Promise<ResolvedKey | null> {
  if (!plaintext.startsWith(KEY_PREFIX)) return null
  if (plaintext.length !== KEY_PREFIX.length + KEY_BODY_LENGTH) return null
  const hashedKey = hashKey(plaintext)
  const [row] = await db
    .select({ id: schema.apiKey.id, userId: schema.apiKey.userId })
    .from(schema.apiKey)
    .where(eq(schema.apiKey.hashedKey, hashedKey))
    .limit(1)
  if (!row) return null
  return { userId: row.userId, keyId: row.id }
}

// Fire-and-forget bump. Errors are swallowed because a failed write
// here shouldn't take down a valid MCP request.
export function bumpLastUsedAt(keyId: string): void {
  void db
    .update(schema.apiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKey.id, keyId))
    .catch((e: unknown) => {
      console.warn('apiKey: lastUsedAt bump failed', { keyId, error: e })
    })
}
