import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// AES-256-GCM token encryption for OAuth credentials at rest. Each
// connection row stores an opaque base64 blob; the server decrypts on every
// API call. The frontend never sees plaintext tokens.
//
// Blob layout (concatenated bytes, then base64-encoded):
//   [ iv (12) | ciphertext (N) | authTag (16) ]
//
// Why GCM: authenticated encryption — tampering anywhere in the blob makes
// .final() throw, so we get integrity for free. The 12-byte IV is the
// NIST-recommended default for GCM and is randomly generated per call —
// reusing an IV with the same key would catastrophically break GCM.
//
// Why a module-level cached key: loadKey() validates format once at first
// use and throws hard if the env var is missing or malformed. We never want
// to encrypt with a wrong-length or stub key.

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32
const TAG_BYTES = 16

let cachedKey: Buffer | null = null

function loadKey(): Buffer {
  const hex = process.env.CONNECTION_TOKEN_KEY
  if (!hex) {
    throw new Error(
      'CONNECTION_TOKEN_KEY is required for OAuth token encryption (64 hex chars / 32 bytes)',
    )
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('CONNECTION_TOKEN_KEY must be exactly 64 hex characters (32 bytes)')
  }
  return Buffer.from(hex, 'hex')
}

function getKey(): Buffer {
  if (!cachedKey) cachedKey = loadKey()
  return cachedKey
}

/** Encrypt an OAuth token (access or refresh) for at-rest storage. */
export function encryptToken(plain: string): string {
  return encryptWith(getKey(), plain)
}

/** Decrypt a previously-stored OAuth token blob. Throws on tamper / wrong key. */
export function decryptToken(blob: string): string {
  return decryptWith(getKey(), blob)
}

// ---------------------------------------------------------------------------
// Primitives that take an explicit key — used by tests with a fixed key so
// they don't depend on CONNECTION_TOKEN_KEY being set in the test env. Not
// part of the production surface; callers in real code should use the
// env-keyed wrappers above.
// ---------------------------------------------------------------------------

export function encryptWith(key: Buffer, plain: string): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`encryption key must be ${KEY_BYTES} bytes (got ${key.length})`)
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, ciphertext, tag]).toString('base64')
}

export function decryptWith(key: Buffer, blob: string): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`encryption key must be ${KEY_BYTES} bytes (got ${key.length})`)
  }
  const buf = Buffer.from(blob, 'base64')
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error('ciphertext blob too short')
  }
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(buf.length - TAG_BYTES)
  const ciphertext = buf.subarray(IV_BYTES, buf.length - TAG_BYTES)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
