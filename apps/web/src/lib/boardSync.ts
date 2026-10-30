import type {
  CanvasObject,
  SaveBoardObjectsRequest,
  SaveBoardObjectsResponse,
} from '@moodboard/shared'

// What the client believes the server holds: the last object it saved or
// loaded for each id, plus that object's server version.
export type SyncedState = {
  saved: Map<string, CanvasObject>
  versions: Map<string, number>
}

export function syncedStateFrom(
  objects: CanvasObject[],
  versions: Record<string, number>,
): SyncedState {
  return {
    saved: new Map(objects.map((o) => [o.id, o])),
    versions: new Map(Object.entries(versions)),
  }
}

// Store updates replace only the objects that changed, so a reference check
// skips untouched objects; the JSON check catches no-op rewrites (e.g. undo
// back to an identical frame).
function changed(a: CanvasObject, b: CanvasObject): boolean {
  return a !== b && JSON.stringify(a) !== JSON.stringify(b)
}

export function diffObjects(state: SyncedState, current: CanvasObject[]): SaveBoardObjectsRequest {
  const upserts: SaveBoardObjectsRequest['upserts'] = []
  const deletes: SaveBoardObjectsRequest['deletes'] = []
  const currentIds = new Set<string>()
  for (const o of current) {
    currentIds.add(o.id)
    const prev = state.saved.get(o.id)
    if (prev && !changed(prev, o)) continue
    upserts.push({
      object: o as SaveBoardObjectsRequest['upserts'][number]['object'],
      baseVersion: state.versions.get(o.id) ?? null,
    })
  }
  for (const id of state.saved.keys()) {
    if (currentIds.has(id)) continue
    const baseVersion = state.versions.get(id)
    if (baseVersion !== undefined) deletes.push({ id, baseVersion })
  }
  return { upserts, deletes }
}

export function isEmptyDiff(diff: SaveBoardObjectsRequest): boolean {
  return diff.upserts.length === 0 && diff.deletes.length === 0
}

// Folds a save response into the synced state. Returns the server copies
// the canvas must adopt (conflicts) so the caller can patch the store.
export function applySaveResult(
  state: SyncedState,
  sent: SaveBoardObjectsRequest,
  result: SaveBoardObjectsResponse,
): { adopt: CanvasObject[]; remove: string[] } {
  const conflicted = new Set(result.conflicts.map((c) => c.id))
  for (const { object } of sent.upserts) {
    const version = result.versions[object.id]
    if (version === undefined) continue
    state.saved.set(object.id, object as unknown as CanvasObject)
    state.versions.set(object.id, version)
  }
  for (const { id } of sent.deletes) {
    if (conflicted.has(id)) continue
    state.saved.delete(id)
    state.versions.delete(id)
  }
  const adopt: CanvasObject[] = []
  const remove: string[] = []
  for (const c of result.conflicts) {
    if (c.object && c.version !== null) {
      state.saved.set(c.id, c.object)
      state.versions.set(c.id, c.version)
      adopt.push(c.object)
    } else {
      state.saved.delete(c.id)
      state.versions.delete(c.id)
      remove.push(c.id)
    }
  }
  return { adopt, remove }
}
