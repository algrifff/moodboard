import type { LinearStatus } from '@moodboard/shared'
import { create } from 'zustand'
import { deleteConnection } from '@/lib/connectionsApi'
import { getLinearStatus } from '@/lib/linearApi'
import { openConnectionPopup } from '@/lib/oauthPopup'
import { useSourcePickerStore } from '@/store/sourcePicker'

// Whether Linear is set up on the server and connected for this person.
// Shared by the issue picker, the sources drawer and Settings.

type LinearState = {
  status: LinearStatus | null
  statusError: string | null
  connecting: boolean
  connectError: string | null
  load: (force?: boolean) => Promise<void>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
}

export const useLinearStore = create<LinearState>()((set, get) => ({
  status: null,
  statusError: null,
  connecting: false,
  connectError: null,

  load: async (force = false) => {
    if (get().status && !force) return
    try {
      set({ status: await getLinearStatus(), statusError: null })
    } catch (e) {
      set({ statusError: e instanceof Error ? e.message : String(e) })
    }
  },

  connect: async () => {
    set({ connecting: true, connectError: null })
    try {
      await openConnectionPopup('linear')
      await get().load(true)
      await useSourcePickerStore.getState().refreshConnections()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Closing the popup is a choice, not a failure.
      set({ connectError: message === 'Cancelled' ? null : message })
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
