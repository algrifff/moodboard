import type { FigmaStatus } from '@moodboard/shared'
import { create } from 'zustand'
import { deleteConnection } from '@/lib/connectionsApi'
import { getFigmaStatus } from '@/lib/figmaApi'
import { openConnectionPopup } from '@/lib/oauthPopup'
import { useSourcePickerStore } from '@/store/sourcePicker'

// Whether Figma is set up on the server and connected for this person.
// Shared by the sources drawer, paste handling and Settings.

type FigmaState = {
  status: FigmaStatus | null
  statusError: string | null
  connecting: boolean
  connectError: string | null
  load: (force?: boolean) => Promise<void>
  connect: () => Promise<boolean>
  disconnect: () => Promise<void>
}

export const useFigmaStore = create<FigmaState>()((set, get) => ({
  status: null,
  statusError: null,
  connecting: false,
  connectError: null,

  load: async (force = false) => {
    if (get().status && !force) return
    try {
      set({ status: await getFigmaStatus(), statusError: null })
    } catch (e) {
      set({ statusError: e instanceof Error ? e.message : String(e) })
    }
  },

  connect: async () => {
    set({ connecting: true, connectError: null })
    try {
      await openConnectionPopup('figma')
      await get().load(true)
      await useSourcePickerStore.getState().refreshConnections()
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Closing the popup is a choice, not a failure.
      set({ connectError: message === 'Cancelled' ? null : message })
      return false
    } finally {
      set({ connecting: false })
    }
  },

  disconnect: async () => {
    const id = get().status?.connection?.id
    if (!id) return
    await deleteConnection(id)
    await get().load(true)
    await useSourcePickerStore.getState().refreshConnections()
  },
}))
