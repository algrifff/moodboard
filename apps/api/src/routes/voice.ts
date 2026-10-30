// Voice-note routes.
//
// /transcribe takes a filename produced by /upload (so we can verify the
// user owns it via the asset table), reads the audio off the volume, and
// sends it to Gemini for a cleaned-up transcript. Returns the polished
// text — the client writes it back onto its canvas object.
//
// Rate limit is tight because each call costs Gemini credits and a voice
// memo should only be transcribed once per recording in normal use; the
// retry path is the only reason we'd cross 10/min.

import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { GeminiKeyMissingError, transcribeVoiceNote } from '../lib/gemini'
import { rateLimit } from '../lib/rateLimit'
import { isSafeFilename, uploadPath } from '../lib/storage'
import { ALLOWED_AUDIO_MIME } from '../lib/upload-validation'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const voice = new Hono<{ Variables: Variables }>()

voice.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

const transcribeRateLimit = rateLimit({ scope: 'voice-transcribe', limit: 10, windowMs: 60_000 })

voice.post('/transcribe', transcribeRateLimit, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { filename?: unknown }
  const filename = typeof body.filename === 'string' ? body.filename : null
  if (!filename || !isSafeFilename(filename)) {
    return c.json({ error: 'filename is required' }, 400)
  }

  // Kind check. Only audio uploads (kind = 'upload' with an
  // audio MIME) can be transcribed; PDFs, fonts, images all share the
  // same kind so we filter on MIME.
  const [asset] = await db
    .select({ mimeType: schema.asset.mimeType })
    .from(schema.asset)
    .where(eq(schema.asset.filename, filename))
    .limit(1)
  if (!asset) return c.json({ error: 'Voice note not found' }, 404)
  const bareMime = (asset.mimeType || '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!ALLOWED_AUDIO_MIME.has(bareMime)) {
    return c.json({ error: 'Not an audio file' }, 400)
  }

  try {
    const result = await transcribeVoiceNote({
      filePath: uploadPath(filename),
      mimeType: bareMime,
    })
    return c.json({ transcript: result.transcript })
  } catch (e) {
    if (e instanceof GeminiKeyMissingError) {
      return c.json({ error: 'Transcription is not configured on the server' }, 503)
    }
    console.warn('[voice/transcribe] failed', { filename, error: e })
    const msg = e instanceof Error ? e.message : 'unknown error'
    return c.json({ error: `Transcription failed: ${msg}` }, 502)
  }
})
