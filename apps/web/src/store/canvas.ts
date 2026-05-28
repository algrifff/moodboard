import type { CanvasObject } from '@moodboard/shared'
import { create } from 'zustand'

type TransformPatch = { scale?: number; offset?: { x: number; y: number } }

export type CanvasSnapshot = {
  objects: CanvasObject[]
  scale: number
  offset: { x: number; y: number }
}

// Undo/redo: only the `objects` array is undoable. Pan / zoom are
// view state and shouldn't consume history slots.
type HistoryFrame = CanvasObject[]
const HISTORY_LIMIT = 50

type CanvasState = {
  objects: CanvasObject[]
  scale: number
  offset: { x: number; y: number }
  viewportSize: { width: number; height: number }
  selectedIds: string[]

  past: HistoryFrame[]
  future: HistoryFrame[]

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

  // Call right before a mutation that should be undoable. Snapshots the
  // current `objects` into history and clears the redo stack. Coalescing
  // continuous actions (drag, typing) is the caller's job — see usage sites.
  commitBeforeAction: () => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean

  hydrate: (snapshot: Partial<CanvasSnapshot>) => void
  reset: () => void
}

const INITIAL: CanvasSnapshot = {
  objects: [],
  scale: 1,
  offset: { x: 0, y: 0 },
}

export const useCanvasStore = create<CanvasState>()((set, get) => ({
  objects: INITIAL.objects,
  scale: INITIAL.scale,
  offset: INITIAL.offset,
  viewportSize: { width: 0, height: 0 },
  selectedIds: [],
  past: [],
  future: [],

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

  commitBeforeAction: () =>
    set((s) => {
      const nextPast = [...s.past, s.objects]
      // Drop oldest frames when we cross the bound.
      if (nextPast.length > HISTORY_LIMIT) nextPast.splice(0, nextPast.length - HISTORY_LIMIT)
      return { past: nextPast, future: [] }
    }),
  undo: () =>
    set((s) => {
      if (s.past.length === 0) return {}
      const previous = s.past[s.past.length - 1]!
      return {
        objects: previous,
        past: s.past.slice(0, -1),
        future: [...s.future, s.objects],
        // Selection may reference deleted objects after restoring an older
        // state; safest to clear it.
        selectedIds: [],
      }
    }),
  redo: () =>
    set((s) => {
      if (s.future.length === 0) return {}
      const next = s.future[s.future.length - 1]!
      return {
        objects: next,
        past: [...s.past, s.objects],
        future: s.future.slice(0, -1),
        selectedIds: [],
      }
    }),
  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  hydrate: (snapshot) =>
    set(() => ({
      objects: snapshot.objects ?? INITIAL.objects,
      scale: snapshot.scale ?? INITIAL.scale,
      offset: snapshot.offset ?? INITIAL.offset,
      selectedIds: [],
      past: [],
      future: [],
    })),
  reset: () =>
    set(() => ({
      ...INITIAL,
      selectedIds: [],
      past: [],
      future: [],
    })),
}))

export function snapshotFromStore(state: CanvasState): CanvasSnapshot {
  return {
    objects: state.objects,
    scale: state.scale,
    offset: state.offset,
  }
}
