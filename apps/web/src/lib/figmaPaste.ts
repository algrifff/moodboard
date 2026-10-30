import {
  layoutFigmaRow,
  objectRect,
  parseFigmaUrl,
  screenToWorld,
  type FigmaFrameData,
} from '@moodboard/shared'
import { showToast } from '@/components/canvas/Toast'
import { focusObjects } from '@/lib/canvasCamera'
import { importFigmaFrames } from '@/lib/figmaApi'
import { ApiError } from '@/lib/http'
import { createFigmaFrame } from '@/lib/objectFactory'
import { useCanvasStore } from '@/store/canvas'
import { useFigmaStore } from '@/store/figma'
import { useSourcePickerStore } from '@/store/sourcePicker'

// Dropping a Figma link on the board: a frame link imports straight away, a
// file link opens the drawer's Figma section to pick frames from, and with no
// connection the link is stashed until Figma is connected.

type Point = { x: number; y: number }

function viewportCenter(): Point {
  const { scale, offset, viewportSize } = useCanvasStore.getState()
  return screenToWorld(
    { x: viewportSize.width / 2, y: viewportSize.height / 2 },
    { scale, x: offset.x, y: offset.y },
  )
}

export function placeFigmaFrames(frames: FigmaFrameData[], center: Point = viewportCenter()) {
  const state = useCanvasStore.getState()
  state.commitBeforeAction()
  const cards = frames.map((data, i) => createFigmaFrame(center, state.objects.length + i, data))
  const { positions, moved } = layoutFigmaRow(
    cards.map((c) => c.size),
    center,
    state.objects.map(objectRect),
  )
  cards.forEach((card, i) => {
    card.position = positions[i]!
    state.addObject(card)
  })
  if (moved) focusObjects(cards.map((c) => c.id))
}

export async function importFigmaToBoard(
  boardId: string,
  request: { url: string; nodeIds?: string[] },
  center?: Point,
) {
  const frames = await importFigmaFrames({ ...request, boardId })
  placeFigmaFrames(frames, center)
  showToast(
    frames.length === 1
      ? `Added “${frames[0]!.name}” from Figma`
      : `Added ${frames.length} frames from Figma`,
  )
  return frames
}

/** A link pasted on the canvas. */
export async function pasteFigmaUrl(boardId: string, url: string, center?: Point) {
  const ref = parseFigmaUrl(url)
  if (!ref) return
  if (ref.kind === 'make') {
    showToast('Figma Make files can’t be imported — paste a Design or FigJam link')
    return
  }
  const figma = useFigmaStore.getState()
  await figma.load()
  const status = useFigmaStore.getState().status
  const picker = useSourcePickerStore.getState()
  if (!status?.configured) {
    showToast('Figma isn’t set up on this server — see the README')
    return
  }
  if (!status.connection) {
    picker.setPendingPaste({ provider: 'figma', url })
    picker.openFigma(url)
    showToast('Connect Figma first to drop this link')
    return
  }
  if (!ref.nodeId) {
    picker.openFigma(url)
    return
  }
  showToast('Rendering the frame from Figma…')
  try {
    await importFigmaToBoard(boardId, { url }, center)
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'reconnect' || e.code === 'not-connected')) {
      picker.setPendingPaste({ provider: 'figma', url })
      picker.openFigma(url)
    }
    showToast(`Figma import failed: ${e instanceof Error ? e.message : 'unknown error'}`)
  }
}

/** Connect Figma from anywhere, then finish whatever link was waiting for it. */
export async function connectFigma(boardId: string | null) {
  const connected = await useFigmaStore.getState().connect()
  if (!connected) return
  const picker = useSourcePickerStore.getState()
  const pending = picker.pendingPaste
  if (pending?.provider !== 'figma') return
  picker.setPendingPaste(null)
  if (boardId) await pasteFigmaUrl(boardId, pending.url)
}
