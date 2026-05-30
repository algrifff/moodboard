import type { ConnectionSummary } from '@moodboard/shared'
import { create } from 'zustand'
import { listConnections } from '@/lib/connectionsApi'

// Source picker UI state — kept in a separate store from the canvas so the
// drawer can open/close without touching canvas reactivity. Connections are
// loaded once on first open (and after a successful connect) and cached
// here; the drawer reads from the cache rather than re-fetching on each
// open.

// When the user pastes a Notion URL on the canvas but has no Notion
// connection yet, we stash the page id here, open the picker drawer (which
// shows the connect CTA in its empty state), and after the OAuth handshake
// completes the Board page checks this and runs the import.
export type PendingPaste = { provider: 'notion'; pageId: string }

type SourcePickerState = {
  open: boolean
  connections: ConnectionSummary[]
  connectionsLoaded: boolean
  loadingConnections: boolean
  pendingPaste: PendingPaste | null

  openPicker: () => void
  closePicker: () => void
  togglePicker: () => void

  setPendingPaste: (pending: PendingPaste | null) => void

  refreshConnections: () => Promise<void>
}

export const useSourcePickerStore = create<SourcePickerState>()((set, get) => ({
  open: false,
  connections: [],
  connectionsLoaded: false,
  loadingConnections: false,
  pendingPaste: null,

  openPicker: () => {
    set({ open: true })
    // Fire-and-forget refresh on first open; subsequent opens reuse the
    // cached list. A successful connect calls refreshConnections() directly
    // so the new account appears without a manual reload.
    const { connectionsLoaded, loadingConnections } = get()
    if (!connectionsLoaded && !loadingConnections) {
      void get().refreshConnections()
    }
  },
  closePicker: () => set({ open: false }),
  togglePicker: () => {
    if (get().open) get().closePicker()
    else get().openPicker()
  },

  setPendingPaste: (pending) => set({ pendingPaste: pending }),

  refreshConnections: async () => {
    set({ loadingConnections: true })
    try {
      const connections = await listConnections()
      set({ connections, connectionsLoaded: true, loadingConnections: false })
    } catch {
      // Network blip — leave any previously-loaded connections in place so
      // the drawer doesn't suddenly look empty. The user can close + reopen
      // to retry.
      set({ loadingConnections: false })
    }
  },
}))
