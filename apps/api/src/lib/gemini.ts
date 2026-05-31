// Gemini video-analysis client — powers the Senior Video Editor agent.
//
// Gemini understands video natively (frames + audio + speech together), so it
// produces a far richer craft breakdown than a transcript would. Two input
// paths:
//   - YouTube: pass the URL straight to Gemini as a fileData part (no download).
//   - Everything else: yt-dlp downloads a compact mp4 → Gemini Files API
//     upload → poll until ACTIVE → analyse → delete the temp file + upload.
//
// Output is forced to JSON (responseMimeType) and validated with the shared
// videoEditorBreakdownSchema. Permanent "can't do this" states (no key) throw
// so the route surfaces them and they're never cached; the no-clip case is
// handled by the caller. Transient failures throw too (502, retryable).

import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createPartFromUri, createUserContent, GoogleGenAI, MediaResolution } from '@google/genai'
import type { VideoClipBreakdown, VideoClipData } from '@moodboard/shared'
import { geminiVideoCraftSchema } from '@moodboard/shared'

const execFileAsync = promisify(execFile)

export const GEMINI_VIDEO_MODEL = 'gemini-2.5-flash'
export const GEMINI_VOICE_MODEL = 'gemini-2.5-flash'
const DOWNLOAD_TIMEOUT_MS = 180_000
const FILE_ACTIVE_TIMEOUT_MS = 150_000
const POLL_INTERVAL_MS = 2500
// Voice notes are short and ours; tighter ceilings + a shorter poll.
const VOICE_ACTIVE_TIMEOUT_MS = 60_000
const VOICE_POLL_INTERVAL_MS = 1000

// Thrown when the key is missing — the route maps the message to a 503 and it
// is never cached (so adding the key later just works).
export class GeminiKeyMissingError extends Error {
  constructor() {
    super('GEMINI_API_KEY not set')
    this.name = 'GeminiKeyMissingError'
  }
}

const PROMPT = `You are a world-class senior short-form video editor and creative director. You are studying this video to teach another editor exactly how it was made and how to replicate what makes it effective.

Watch the FRAMES and listen to the AUDIO together. Be concrete, specific, and granular — cite exact moments. Timestamps are "M:SS" into the clip.

Return ONLY a JSON object (no prose, no markdown) with EXACTLY this shape:
{
  "summary": "one tight paragraph: the overall edit style and why it works",
  "hooks": [ { "timestamp": "0:00", "what": "what the hook is (visual/verbal/pattern-interrupt)", "whyItWorks": "the psychology — why it holds attention", "howToReplicate": "concrete steps to recreate this hook on a new video" } ],
  "transitions": [ { "timestamp": "0:04", "type": "e.g. whip pan / match cut / J-cut / hard cut / zoom punch", "description": "what happens and the effect it creates" } ],
  "soundDesign": [ { "timestamp": "0:02", "element": "SFX / music drop / riser / silence / VO", "effect": "what it does for pacing or emphasis" } ],
  "spokenBeats": [ { "timestamp": "0:01", "quote": "what is said, verbatim if possible", "delivery": "cadence / emphasis / timing — how and when they say it" } ],
  "pacing": "one paragraph on cut cadence, rhythm, and the energy curve across the clip",
  "replicationPlaybook": [ "step 1 …", "step 2 …", "ordered, actionable steps to recreate this clip's style" ]
}

Aim for 2–5 entries in each array where the video supports it. If a dimension genuinely isn't present (e.g. no spoken word), return an empty array for it. Do not invent moments that aren't there.`

export async function analyzeVideoForEditor(clip: VideoClipData): Promise<VideoClipBreakdown> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new GeminiKeyMissingError()
  const ai = new GoogleGenAI({ apiKey: key })

  let cleanup: (() => Promise<void>) | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let contents: any
    if (clip.platform === 'youtube' && clip.url) {
      contents = [{ fileData: { fileUri: clip.url } }, { text: PROMPT }]
    } else {
      const up = await downloadAndUpload(ai, clip.url)
      cleanup = up.cleanup
      contents = createUserContent([createPartFromUri(up.uri, up.mimeType), PROMPT])
    }

    const response = await ai.models.generateContent({
      model: GEMINI_VIDEO_MODEL,
      contents,
      // Low media resolution ~thirds the per-second video token cost — plenty
      // for short-form craft analysis, and the per-clip cache means we only
      // pay it once per video anyway.
      config: {
        responseMimeType: 'application/json',
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
      },
    })
    const text = response.text ?? ''
    const json = safeParseJson(text)
    if (!json) {
      return videoClipUnavailable(clip, 'Gemini returned an unreadable response — try re-running.')
    }
    const parsed = geminiVideoCraftSchema.safeParse(json)
    if (!parsed.success) {
      return videoClipUnavailable(
        clip,
        "Gemini's analysis didn't match the expected shape — try re-running.",
      )
    }
    // Identity comes from the clip object, never the model.
    return {
      videoId: clip.videoId,
      title: clip.title,
      platform: clip.platform,
      url: clip.url,
      ...parsed.data,
    }
  } catch (e) {
    // One bad clip shouldn't 502 the whole group — surface it as an unavailable
    // entry so the clips that worked still render. The missing-key case is
    // thrown above (before this try) so it still propagates → 503.
    console.warn('analyzeVideoForEditor failed', { videoId: clip.videoId, error: e })
    const m = e instanceof Error ? e.message : String(e)
    const reason = /too long|timeout/i.test(m)
      ? 'This clip took too long to process — try a shorter clip or re-run.'
      : /download|yt-dlp|unsupported|not available|could not/i.test(m)
        ? "Couldn't download this clip for analysis (the platform may block it)."
        : 'Couldn’t analyse this clip — try re-running.'
    return videoClipUnavailable(clip, reason)
  } finally {
    if (cleanup) await cleanup().catch(() => {})
  }
}

// Download a compact mp4 with yt-dlp, upload to the Gemini Files API, and wait
// for it to finish processing. Returns the file ref + a cleanup that removes
// both the temp file and the uploaded Gemini file.
async function downloadAndUpload(
  ai: GoogleGenAI,
  url: string,
): Promise<{ uri: string; mimeType: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mb-gem-'))
  const rmDir = () => rm(dir, { recursive: true, force: true })
  let uploadedName: string | null = null
  const deleteUpload = async () => {
    if (uploadedName) await ai.files.delete({ name: uploadedName }).catch(() => {})
  }
  try {
    await execFileAsync(
      'yt-dlp',
      [
        '-f',
        'best[height<=480][ext=mp4]/best[height<=480]/best',
        '--merge-output-format',
        'mp4',
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        '-o',
        path.join(dir, 'v.%(ext)s'),
        url,
      ],
      { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    )
    const file = (await readdir(dir)).find((f) => /\.(mp4|mkv|webm|mov)$/i.test(f))
    if (!file) throw new Error('Could not download the video for analysis')
    const mimeType = mimeForExt(file)

    let uploaded = await ai.files.upload({
      file: path.join(dir, file),
      config: { mimeType },
    })
    uploadedName = uploaded.name ?? null

    const deadline = Date.now() + FILE_ACTIVE_TIMEOUT_MS
    while (String(uploaded.state) === 'PROCESSING') {
      if (Date.now() > deadline) throw new Error('Gemini took too long to process the video')
      await sleep(POLL_INTERVAL_MS)
      if (!uploaded.name) break
      uploaded = await ai.files.get({ name: uploaded.name })
    }
    if (String(uploaded.state) !== 'ACTIVE' || !uploaded.uri) {
      throw new Error(`Gemini could not process the video (${String(uploaded.state)})`)
    }

    const uri = uploaded.uri
    const resolvedMime = uploaded.mimeType ?? mimeType
    return {
      uri,
      mimeType: resolvedMime,
      cleanup: async () => {
        await rmDir().catch(() => {})
        await deleteUpload()
      },
    }
  } catch (e) {
    await rmDir().catch(() => {})
    await deleteUpload()
    throw e
  }
}

// A per-clip breakdown carrying only the clip's identity + a human-readable
// reason it couldn't be analysed. Not cached by the caller (so re-running
// retries the clip).
export function videoClipUnavailable(clip: VideoClipData, reason: string): VideoClipBreakdown {
  return {
    videoId: clip.videoId,
    title: clip.title,
    platform: clip.platform,
    url: clip.url,
    summary: '',
    hooks: [],
    transitions: [],
    soundDesign: [],
    spokenBeats: [],
    pacing: '',
    replicationPlaybook: [],
    unavailableReason: reason,
  }
}

function safeParseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    // Gemini occasionally wraps JSON in a ```json fence despite the mime-type
    // request — strip a fence and retry once.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1])
      } catch {
        return null
      }
    }
    return null
  }
}

function mimeForExt(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'webm':
      return 'video/webm'
    case 'mkv':
      return 'video/x-matroska'
    case 'mov':
      return 'video/quicktime'
    default:
      return 'video/mp4'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Voice-note transcription
// ---------------------------------------------------------------------------

const VOICE_PROMPT = `You are transcribing a short personal voice memo recorded by the user as a thought / note to themselves on a moodboard.

Goals, in order:
1. Capture what the speaker meant — their idea, their voice, their vocabulary.
2. Clean up the delivery so it reads cleanly: drop filler words ("um", "uh", "like" used as a filler, "you know"), drop obvious false starts and repeated words, fix run-ons into sentences.
3. Preserve specifics — names, numbers, brand references, references to things on the canvas (logos, fonts, colours, designers) — exactly.
4. Do NOT paraphrase or summarise. The output should be what the speaker would have said if they were speaking cleanly. Same content, same structure of thought, same length-ish.
5. If the recording is silent or unintelligible, return an empty string.

Return ONLY the cleaned transcript as plain text. No quotes, no preface, no commentary, no metadata. Just the words.`

export type VoiceTranscriptionResult = {
  transcript: string
}

/**
 * Transcribe a recorded voice note by streaming it to Gemini's Files API and
 * asking the model for a cleaned-up transcript. The audio is a small (<50 MB)
 * file already on our volume, so there's no download step — we just upload to
 * Gemini, wait for ACTIVE, prompt, and delete.
 */
export async function transcribeVoiceNote(args: {
  filePath: string
  mimeType: string
}): Promise<VoiceTranscriptionResult> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new GeminiKeyMissingError()
  const ai = new GoogleGenAI({ apiKey: key })

  let uploadedName: string | null = null
  try {
    let uploaded = await ai.files.upload({
      file: args.filePath,
      config: { mimeType: args.mimeType },
    })
    uploadedName = uploaded.name ?? null

    const deadline = Date.now() + VOICE_ACTIVE_TIMEOUT_MS
    while (String(uploaded.state) === 'PROCESSING') {
      if (Date.now() > deadline) {
        throw new Error('Gemini took too long to process the voice note')
      }
      await sleep(VOICE_POLL_INTERVAL_MS)
      if (!uploaded.name) break
      uploaded = await ai.files.get({ name: uploaded.name })
    }
    if (String(uploaded.state) !== 'ACTIVE' || !uploaded.uri) {
      throw new Error(`Gemini could not process the voice note (${String(uploaded.state)})`)
    }
    const resolvedMime = uploaded.mimeType ?? args.mimeType
    const contents = createUserContent([
      createPartFromUri(uploaded.uri, resolvedMime),
      VOICE_PROMPT,
    ])

    const response = await ai.models.generateContent({
      model: GEMINI_VOICE_MODEL,
      contents,
      // Plain text out — easier to validate than a JSON wrapper for a
      // single-string return.
      config: {
        responseMimeType: 'text/plain',
      },
    })
    const raw = (response.text ?? '').trim()
    return { transcript: stripFences(raw) }
  } finally {
    if (uploadedName) {
      await ai.files.delete({ name: uploadedName }).catch(() => undefined)
    }
  }
}

// Gemini occasionally returns fenced text despite a plain-text mime request.
// Strip a leading/trailing fence so the card doesn't render ```text\n…\n```.
function stripFences(s: string): string {
  const m = s.match(/^```(?:[a-z]+)?\s*([\s\S]*?)\s*```$/i)
  return m?.[1]?.trim() ?? s
}
