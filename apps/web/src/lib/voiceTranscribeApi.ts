// Client wrapper for POST /api/voice/transcribe.
//
// Returns the cleaned transcript or throws on any non-2xx. The HUD calls
// this in the background after spawning the voice-note card; the
// VoiceNoteNode itself uses it as the retry path when a previous
// transcription failed or was lost on reload.

export async function transcribeVoiceNote(filename: string): Promise<string> {
  const res = await fetch('/api/voice/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText)
    throw new Error(detail || `HTTP ${res.status}`)
  }
  const data = (await res.json()) as { transcript?: unknown }
  return typeof data.transcript === 'string' ? data.transcript : ''
}

// Strip leading "/api/files/" so the server endpoint, which expects the
// bare on-disk filename, gets what it expects regardless of how the
// caller stored the URL.
export function filenameFromUrl(url: string): string | null {
  const m = url.match(/^\/api\/files\/([^/]+)$/)
  return m?.[1] ?? null
}
