import type { Client } from '@moodboard/shared'
import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

// Which client a list is filtered to. Lives in the URL (`?client=acme`,
// `?client=none`) so a filtered view can be linked; the last choice is
// remembered per viewer for when a page opens without one.

export type ClientFilter = { kind: 'all' } | { kind: 'none' } | { kind: 'client'; slug: string }

const STORAGE_KEY = 'moodboard:client-filter'

function remembered(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function remember(value: string | null): void {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage unavailable — the filter just resets next visit.
  }
}

export function parseClientFilter(value: string | null): ClientFilter {
  if (!value) return { kind: 'all' }
  if (value === 'none') return { kind: 'none' }
  return { kind: 'client', slug: value }
}

export function useClientFilter(options: { allowNone: boolean }) {
  const [params, setParams] = useSearchParams()
  const raw = params.has('client') ? params.get('client') : remembered()
  const parsed = parseClientFilter(raw)
  const filter = !options.allowNone && parsed.kind === 'none' ? ({ kind: 'all' } as const) : parsed

  const setFilter = useCallback(
    (next: ClientFilter) => {
      const value = next.kind === 'all' ? null : next.kind === 'none' ? 'none' : next.slug
      remember(value)
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev)
          if (value) copy.set('client', value)
          else copy.delete('client')
          return copy
        },
        { replace: true },
      )
    },
    [setParams],
  )
  return [filter, setFilter] as const
}

// The client a filter names, once the clients have loaded. A slug that
// matches nothing (deleted client) counts as no filter.
export function resolveClientFilter(filter: ClientFilter, clients: Client[]): Client | null {
  return filter.kind === 'client' ? (clients.find((c) => c.slug === filter.slug) ?? null) : null
}
