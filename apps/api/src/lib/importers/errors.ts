// Thrown when a connection's stored token can't be decrypted (key rotated,
// row corrupted). The handler turns this into a 503 so the client can show
// a "connection no longer available" message rather than a 500.
export class TokenDecryptError extends Error {
  constructor() {
    super('TokenDecryptError')
    this.name = 'TokenDecryptError'
  }
}
