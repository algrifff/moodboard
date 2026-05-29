import { useEffect, useState } from 'react'

// User preference. `system` defers to the OS; `light` / `dark` override.
// Persisted under this localStorage key; the inline bootstrap in
// index.html reads the same key BEFORE the page paints to avoid FOUC.
export type ThemePref = 'system' | 'light' | 'dark'
// What's actually applied — `system` resolves to one of these.
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'moodboard:theme'

function readStoredPref(): ThemePref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // Storage disabled — fall through.
  }
  return 'system'
}

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function resolve(pref: ThemePref): ResolvedTheme {
  return pref === 'system' ? systemTheme() : pref
}

/** Apply a resolved theme to the document. */
function apply(theme: ResolvedTheme) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
}

/**
 * Set the user's theme preference. Persists, applies, and notifies any
 * subscribed `useTheme` hooks via the storage event surrogate.
 */
export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(STORAGE_KEY, pref)
  } catch {
    // Best-effort.
  }
  apply(resolve(pref))
  window.dispatchEvent(new CustomEvent('moodboard:theme-change'))
}

/**
 * React hook returning the current preference + resolved theme, and a
 * setter. Subscribes to system-preference changes so `pref === 'system'`
 * tracks the OS live, and to in-app updates so a toggle elsewhere on the
 * page propagates.
 */
export function useTheme(): {
  pref: ThemePref
  resolved: ResolvedTheme
  setPref: (p: ThemePref) => void
} {
  const [pref, setPref] = useState<ThemePref>(() => readStoredPref())
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readStoredPref()))

  useEffect(() => {
    const sync = () => {
      const next = readStoredPref()
      setPref(next)
      setResolved(resolve(next))
    }
    // External change (storage event fires across tabs; custom event for
    // same-tab updates that don't trigger 'storage').
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) sync()
    }
    const onCustom = () => sync()
    // OS preference change — only affects us when pref === 'system'.
    const mql = window.matchMedia('(prefers-color-scheme: light)')
    const onMql = () => sync()
    window.addEventListener('storage', onStorage)
    window.addEventListener('moodboard:theme-change', onCustom)
    mql.addEventListener('change', onMql)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('moodboard:theme-change', onCustom)
      mql.removeEventListener('change', onMql)
    }
  }, [])

  return { pref, resolved, setPref: setThemePref }
}
