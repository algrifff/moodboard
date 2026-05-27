import type { CanvasObject, StickyData, TextData } from '@moodboard/shared'
import { nanoid } from 'nanoid'

const STICKY_DEFAULT_SIZE = { width: 200, height: 200 }
const STICKY_DEFAULT_COLOR = '#FEF3C7'
const TEXT_DEFAULT_FONT = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont'
const TEXT_DEFAULT_FONT_SIZE = 18

export function createSticky(
  worldCenter: { x: number; y: number },
  zIndex: number,
): CanvasObject {
  const data: StickyData = { text: '', color: STICKY_DEFAULT_COLOR }
  return {
    id: nanoid(),
    type: 'sticky',
    position: {
      x: worldCenter.x - STICKY_DEFAULT_SIZE.width / 2,
      y: worldCenter.y - STICKY_DEFAULT_SIZE.height / 2,
    },
    size: STICKY_DEFAULT_SIZE,
    rotation: 0,
    zIndex,
    data,
  }
}

export function createText(
  worldCenter: { x: number; y: number },
  zIndex: number,
): CanvasObject {
  const data: TextData = {
    text: '',
    font: TEXT_DEFAULT_FONT,
    fontSize: TEXT_DEFAULT_FONT_SIZE,
  }
  const size = { width: 240, height: 56 }
  return {
    id: nanoid(),
    type: 'text',
    position: { x: worldCenter.x - size.width / 2, y: worldCenter.y - size.height / 2 },
    size,
    rotation: 0,
    zIndex,
    data,
  }
}
