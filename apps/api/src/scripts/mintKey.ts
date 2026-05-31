// Dev-only one-shot — mints an API key for a known user id and prints
// the plaintext. Used during Phase 19 verification before the
// dashboard settings card landed.
//
// Usage: pnpm --filter @moodboard/api tsx --env-file=.env src/scripts/mintKey.ts <userId> <name>
import { mintApiKey } from '../lib/apiKey'

const [, , userId, ...nameParts] = process.argv
const name = nameParts.join(' ') || 'mcp-dev-key'
if (!userId) {
  console.error('Usage: tsx src/scripts/mintKey.ts <userId> [name]')
  process.exit(1)
}

const key = await mintApiKey({ userId, name })
console.log(JSON.stringify(key, null, 2))
process.exit(0)
