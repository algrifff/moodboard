import type {
  CanvasObject,
  DriveFileData,
  DriveFolderData,
  FontData,
  NotionPageData,
  StickyData,
  TextData,
  WebPageData,
} from '@moodboard/shared'
import { nanoid } from 'nanoid'

const STICKY_DEFAULT_SIZE = { width: 200, height: 200 }
const STICKY_DEFAULT_COLOR = '#FEF3C7'
const TEXT_DEFAULT_FONT = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont'
const TEXT_DEFAULT_FONT_SIZE = 18
const FONT_DEFAULT_SIZE = { width: 320, height: 200 }

export function createSticky(worldCenter: { x: number; y: number }, zIndex: number): CanvasObject {
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
  initialText = '',
): CanvasObject {
  const data: TextData = {
    text: initialText,
    font: TEXT_DEFAULT_FONT,
    fontSize: TEXT_DEFAULT_FONT_SIZE,
  }
  const size = sizeForText(initialText)
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

// Pick a sensible default tile size for pasted text. The fit-text hook
// shrinks the font to fit, but we still want the box itself to feel
// proportionate to the content — a one-line snippet shouldn't land in a
// paragraph-sized box.
function sizeForText(text: string): { width: number; height: number } {
  if (!text) return { width: 240, height: 56 }
  const explicitLines = text.split('\n').length
  const longestLine = text.split('\n').reduce((max, line) => Math.max(max, line.length), 0)
  // Approximate visual lines after soft-wrap at ~50 chars per line.
  const softWrappedLines = Math.max(explicitLines, Math.ceil(text.length / 50))
  const width = Math.max(240, Math.min(480, longestLine * 9 + 40))
  const height = Math.max(56, Math.min(420, softWrappedLines * 26 + 24))
  return { width, height }
}

export function createFont(
  worldCenter: { x: number; y: number },
  zIndex: number,
  url: string,
  family: string,
): CanvasObject {
  const data: FontData = { url, family }
  return {
    id: nanoid(),
    type: 'font',
    position: {
      x: worldCenter.x - FONT_DEFAULT_SIZE.width / 2,
      y: worldCenter.y - FONT_DEFAULT_SIZE.height / 2,
    },
    size: FONT_DEFAULT_SIZE,
    rotation: 0,
    zIndex,
    data,
  }
}

// Compact card — title + provider line + Open pill is roughly 100px of
// content; 140 gives a little breathing room without an empty void below
// the pill. User can resize from any edge for a chunkier card.
const NOTION_DEFAULT_SIZE = { width: 280, height: 140 }
const DRIVE_DEFAULT_SIZE = { width: 280, height: 140 }

// External-source factory. The full data snapshot comes from the import
// endpoint and is stored verbatim on the canvas object — the board owns
// the markdown, so future renders / AI runs don't need to refetch from
// Notion until the user explicitly refreshes.
export function createNotionPage(
  worldCenter: { x: number; y: number },
  zIndex: number,
  data: NotionPageData,
): CanvasObject {
  return {
    id: nanoid(),
    type: 'notion-page',
    position: {
      x: worldCenter.x - NOTION_DEFAULT_SIZE.width / 2,
      y: worldCenter.y - NOTION_DEFAULT_SIZE.height / 2,
    },
    size: NOTION_DEFAULT_SIZE,
    rotation: 0,
    zIndex,
    data,
  }
}

export function createDriveFile(
  worldCenter: { x: number; y: number },
  zIndex: number,
  data: DriveFileData,
): CanvasObject {
  return {
    id: nanoid(),
    type: 'drive-file',
    position: {
      x: worldCenter.x - DRIVE_DEFAULT_SIZE.width / 2,
      y: worldCenter.y - DRIVE_DEFAULT_SIZE.height / 2,
    },
    size: DRIVE_DEFAULT_SIZE,
    rotation: 0,
    zIndex,
    data,
  }
}

export function createDriveFolder(
  worldCenter: { x: number; y: number },
  zIndex: number,
  data: DriveFolderData,
): CanvasObject {
  return {
    id: nanoid(),
    type: 'drive-folder',
    position: {
      x: worldCenter.x - DRIVE_DEFAULT_SIZE.width / 2,
      y: worldCenter.y - DRIVE_DEFAULT_SIZE.height / 2,
    },
    size: DRIVE_DEFAULT_SIZE,
    rotation: 0,
    zIndex,
    data,
  }
}

// Taller than Notion/Drive so the description paragraph + swatch row each
// get their own band without crowding the favicon + title above.
const WEB_DEFAULT_SIZE = { width: 320, height: 240 }

export function createWebPage(
  worldCenter: { x: number; y: number },
  zIndex: number,
  data: WebPageData,
): CanvasObject {
  return {
    id: nanoid(),
    type: 'web-page',
    position: {
      x: worldCenter.x - WEB_DEFAULT_SIZE.width / 2,
      y: worldCenter.y - WEB_DEFAULT_SIZE.height / 2,
    },
    size: WEB_DEFAULT_SIZE,
    rotation: 0,
    zIndex,
    data,
  }
}
