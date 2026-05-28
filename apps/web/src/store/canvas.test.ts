import type { CanvasObject } from '@moodboard/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { useCanvasStore } from './canvas'

function obj(id: string): CanvasObject {
  return {
    id,
    type: 'sticky',
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    rotation: 0,
    zIndex: 0,
    data: { text: id, color: '#fff' },
  }
}

describe('canvas store — history', () => {
  beforeEach(() => {
    useCanvasStore.getState().reset()
  })

  it('starts empty with no history', () => {
    const s = useCanvasStore.getState()
    expect(s.objects).toEqual([])
    expect(s.canUndo()).toBe(false)
    expect(s.canRedo()).toBe(false)
  })

  it('commit captures the pre-action state', () => {
    const { addObject, commitBeforeAction } = useCanvasStore.getState()
    addObject(obj('a'))
    commitBeforeAction()
    addObject(obj('b'))
    const s = useCanvasStore.getState()
    expect(s.objects.map((o) => o.id)).toEqual(['a', 'b'])
    expect(s.past).toHaveLength(1)
    expect(s.past[0]!.map((o) => o.id)).toEqual(['a'])
  })

  it('undo restores the previous state and pushes current to future', () => {
    const { addObject, commitBeforeAction, undo } = useCanvasStore.getState()
    addObject(obj('a'))
    commitBeforeAction()
    addObject(obj('b'))
    undo()
    const s = useCanvasStore.getState()
    expect(s.objects.map((o) => o.id)).toEqual(['a'])
    expect(s.canUndo()).toBe(false)
    expect(s.canRedo()).toBe(true)
  })

  it('redo restores the post-action state', () => {
    const { addObject, commitBeforeAction, undo, redo } = useCanvasStore.getState()
    addObject(obj('a'))
    commitBeforeAction()
    addObject(obj('b'))
    undo()
    redo()
    const s = useCanvasStore.getState()
    expect(s.objects.map((o) => o.id)).toEqual(['a', 'b'])
    expect(s.canRedo()).toBe(false)
  })

  it('committing after undo clears the redo stack', () => {
    const { addObject, commitBeforeAction, undo } = useCanvasStore.getState()
    addObject(obj('a'))
    commitBeforeAction()
    addObject(obj('b'))
    undo()
    expect(useCanvasStore.getState().canRedo()).toBe(true)
    commitBeforeAction()
    addObject(obj('c'))
    expect(useCanvasStore.getState().canRedo()).toBe(false)
    expect(useCanvasStore.getState().objects.map((o) => o.id)).toEqual(['a', 'c'])
  })

  it('caps the history stack', () => {
    const { addObject, commitBeforeAction } = useCanvasStore.getState()
    // Push 60 frames; cap is 50.
    for (let i = 0; i < 60; i++) {
      commitBeforeAction()
      addObject(obj(`o${i}`))
    }
    expect(useCanvasStore.getState().past.length).toBe(50)
  })

  it('undo with empty past is a no-op', () => {
    const { undo } = useCanvasStore.getState()
    undo()
    const s = useCanvasStore.getState()
    expect(s.objects).toEqual([])
    expect(s.canUndo()).toBe(false)
  })

  it('hydrate clears both stacks', () => {
    const { addObject, commitBeforeAction, hydrate } = useCanvasStore.getState()
    addObject(obj('a'))
    commitBeforeAction()
    addObject(obj('b'))
    hydrate({ objects: [obj('z')] })
    const s = useCanvasStore.getState()
    expect(s.objects.map((o) => o.id)).toEqual(['z'])
    expect(s.canUndo()).toBe(false)
    expect(s.canRedo()).toBe(false)
  })

  it('undo selection clear', () => {
    const { addObject, setSelection, commitBeforeAction, deleteSelection, undo } =
      useCanvasStore.getState()
    addObject(obj('a'))
    addObject(obj('b'))
    setSelection(['a'])
    commitBeforeAction()
    deleteSelection()
    expect(useCanvasStore.getState().objects.map((o) => o.id)).toEqual(['b'])
    undo()
    const s = useCanvasStore.getState()
    expect(s.objects.map((o) => o.id)).toEqual(['a', 'b'])
    // Selection should not survive an undo — restored objects may not match.
    expect(s.selectedIds).toEqual([])
  })
})
