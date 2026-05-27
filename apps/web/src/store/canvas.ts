import type { CanvasObject } from '@moodboard/shared'
import { create } from 'zustand'

type TransformPatch = { scale?: number; offset?: { x: number; y: number } }

export type CanvasSnapshot = {
  objects: CanvasObject[]
  scale: number
  offset: { x: number; y: number }
}

type CanvasState = {
  objects: CanvasObject[]
  scale: number
  offset: { x: number; y: number }
  viewportSize: { width: number; height: number }
  selectedIds: string[]

  addObject: (object: CanvasObject) => void
  updateObject: (id: string, patch: Partial<CanvasObject>) => void
  removeObject: (id: string) => void
  setTransform: (patch: TransformPatch) => void
  setViewportSize: (size: { width: number; height: number }) => void
  clearBoard: () => void

  setSelection: (ids: string[]) => void
  toggleSelection: (id: string) => void
  addToSelection: (ids: string[]) => void
  clearSelection: () => void
  deleteSelection: () => void

  hydrate: (snapshot: Partial<CanvasSnapshot>) => void
  reset: () => void
}

const INITIAL: CanvasSnapshot = {
  objects: [],
  scale: 1,
  offset: { x: 0, y: 0 },
}

export const useCanvasStore = create<CanvasState>()((set) => ({
  objects: INITIAL.objects,
  scale: INITIAL.scale,
  offset: INITIAL.offset,
  viewportSize: { width: 0, height: 0 },
  selectedIds: [],

  addObject: (object) => set((s) => ({ objects: [...s.objects, object] })),
  updateObject: (id, patch) =>
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    })),
  removeObject: (id) =>
    set((s) => ({
      objects: s.objects.filter((o) => o.id !== id),
      selectedIds: s.selectedIds.filter((sid) => sid !== id),
    })),
  setTransform: (patch) =>
    set((s) => ({
      scale: patch.scale ?? s.scale,
      offset: patch.offset ?? s.offset,
    })),
  setViewportSize: (size) => set({ viewportSize: size }),
  clearBoard: () => set({ objects: [], selectedIds: [] }),

  setSelection: (ids) => set({ selectedIds: ids }),
  toggleSelection: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((sid) => sid !== id)
        : [...s.selectedIds, id],
    })),
  addToSelection: (ids) =>
    set((s) => ({
      selectedIds: Array.from(new Set([...s.selectedIds, ...ids])),
    })),
  clearSelection: () => set({ selectedIds: [] }),
  deleteSelection: () =>
    set((s) => ({
      objects: s.objects.filter((o) => !s.selectedIds.includes(o.id)),
      selectedIds: [],
    })),

  hydrate: (snapshot) =>
    set(() => ({
      objects: snapshot.objects ?? INITIAL.objects,
      scale: snapshot.scale ?? INITIAL.scale,
      offset: snapshot.offset ?? INITIAL.offset,
      selectedIds: [],
    })),
  reset: () =>
    set(() => ({
      ...INITIAL,
      selectedIds: [],
    })),
}))

export function snapshotFromStore(state: CanvasState): CanvasSnapshot {
  return {
    objects: state.objects,
    scale: state.scale,
    offset: state.offset,
  }
}
