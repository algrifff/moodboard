import type { Client } from '@moodboard/shared'
import { useEffect } from 'react'
import { create } from 'zustand'
import * as api from '@/lib/clientsApi'

// The team's clients, shared by every page that filters or assigns by
// client. Loaded on first use; mutations update the cached list directly.

type ClientsState = {
  clients: Client[]
  loaded: boolean
  load: () => Promise<void>
  create: (name: string) => Promise<Client>
  rename: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

const byName = (a: Client, b: Client) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

export const useClientsStore = create<ClientsState>()((set, get) => ({
  clients: [],
  loaded: false,
  load: async () => {
    const clients = await api.listClients()
    set({ clients, loaded: true })
  },
  create: async (name) => {
    const client = await api.createClient(name)
    set({ clients: [...get().clients, client].sort(byName) })
    return client
  },
  rename: async (id, name) => {
    const client = await api.renameClient(id, name)
    set({
      clients: get()
        .clients.map((c) => (c.id === id ? client : c))
        .sort(byName),
    })
  },
  remove: async (id) => {
    await api.deleteClient(id)
    set({ clients: get().clients.filter((c) => c.id !== id) })
  },
}))

let inflight: Promise<void> | null = null

// Reads the cached list and makes sure it has been fetched once.
export function useClients(): { clients: Client[]; loaded: boolean } {
  const clients = useClientsStore((s) => s.clients)
  const loaded = useClientsStore((s) => s.loaded)
  useEffect(() => {
    if (useClientsStore.getState().loaded || inflight) return
    inflight = useClientsStore
      .getState()
      .load()
      .catch((e) => console.error('loading clients failed', e))
      .finally(() => {
        inflight = null
      })
  }, [])
  return { clients, loaded }
}
