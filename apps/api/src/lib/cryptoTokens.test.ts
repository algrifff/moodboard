import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptWith, encryptWith } from './cryptoTokens'

const fixedKey = Buffer.from(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'hex',
)
const otherKey = Buffer.from(
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
  'hex',
)

describe('cryptoTokens', () => {
  it('round-trips a plaintext token unchanged', () => {
    const plain = 'secret_oauth_access_token_xyz'
    const blob = encryptWith(fixedKey, plain)
    expect(decryptWith(fixedKey, blob)).toBe(plain)
  })

  it('round-trips multibyte characters', () => {
    const plain = 'naïve 🔐 tëst — €$£'
    expect(decryptWith(fixedKey, encryptWith(fixedKey, plain))).toBe(plain)
  })

  it('produces a different ciphertext each time (random IV)', () => {
    const plain = 'same input'
    const a = encryptWith(fixedKey, plain)
    const b = encryptWith(fixedKey, plain)
    expect(a).not.toBe(b)
    // But both still decrypt to the same plaintext.
    expect(decryptWith(fixedKey, a)).toBe(plain)
    expect(decryptWith(fixedKey, b)).toBe(plain)
  })

  it('rejects decryption with the wrong key', () => {
    const blob = encryptWith(fixedKey, 'hello')
    expect(() => decryptWith(otherKey, blob)).toThrow()
  })

  it('rejects a tampered ciphertext', () => {
    const blob = encryptWith(fixedKey, 'hello world')
    // Flip a byte in the middle of the base64 blob.
    const buf = Buffer.from(blob, 'base64')
    const mid = Math.floor(buf.length / 2)
    buf[mid] = buf[mid]! ^ 0x01
    const tampered = buf.toString('base64')
    expect(() => decryptWith(fixedKey, tampered)).toThrow()
  })

  it('rejects a tampered auth tag', () => {
    const blob = encryptWith(fixedKey, 'hello world')
    const buf = Buffer.from(blob, 'base64')
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0x01
    expect(() => decryptWith(fixedKey, buf.toString('base64'))).toThrow()
  })

  it('rejects a too-short blob', () => {
    expect(() => decryptWith(fixedKey, Buffer.alloc(8).toString('base64'))).toThrow(/too short/)
  })

  it('rejects wrong-length keys', () => {
    const shortKey = randomBytes(16)
    expect(() => encryptWith(shortKey, 'x')).toThrow(/32 bytes/)
    expect(() => decryptWith(shortKey, 'x'.repeat(40))).toThrow(/32 bytes/)
  })
})
