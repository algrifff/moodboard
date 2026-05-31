// Tiny pub/sub for "this voice note is currently being transcribed."
//
// The HUD calls markTranscribing(id) right after it spawns the canvas
// object, then markDone(id) once Gemini returns (success or failure).
// The card uses useTranscribing(id) to show a "Transcribing…" label
// during the in-flight call.
//
// This state lives client-side only — page reload wipes it. If the user
// reloads mid-transcribe the card lands with empty transcript and no
// transcribing flag, and we surface a "No transcript" hint with a retry
// path. That's an explicit trade against the alternative of persisting
// a `transcribing` flag on the canvas object (which would risk leaving
// a card stuck on "Transcribing…" forever if a tab is closed).

import { useSyncExternalStore } from 'react'

const inflight = new Set<string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const cb of listeners) cb()
}

export function markTranscribing(objectId: string): void {
  if (inflight.has(objectId)) return
  inflight.add(objectId)
  notify()
}

export function markDone(objectId: string): void {
  if (!inflight.has(objectId)) return
  inflight.delete(objectId)
  notify()
}

export function isTranscribing(objectId: string): boolean {
  return inflight.has(objectId)
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useTranscribing(objectId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => inflight.has(objectId),
    () => false,
  )
}
