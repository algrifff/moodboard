import type { CanvasObject, FontData, ImageData, PDFData } from '@moodboard/shared'
import { readFile } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { getAssetRow } from './assetLibrary'
import { insertBoardObject, loadBoardObjects, type VersionedObject } from './boardObjects'
import { nextSpot } from './canvasPlacement'
import { deriveFontFamily } from './fontFamily'
import { processPdf } from './pdfProcessing'
import { pdfPath } from './storage'

// Puts a library asset on a board as the canvas object it would have been
// had it been uploaded there directly.

const IMAGE_WIDTH = 400
const IMAGE_MAX_HEIGHT = 480
const PDF_SIZE = { width: 180, height: 240 }
const FONT_SIZE = { width: 320, height: 200 }

export type AddToBoardResult =
  | { ok: true; added: VersionedObject }
  | { ok: false; status: 404 | 415 | 500; error: string }

export async function addAssetToBoard(
  assetId: string,
  boardId: string,
  userId: string,
  at?: { x: number; y: number },
): Promise<AddToBoardResult> {
  const asset = await getAssetRow(assetId)
  if (!asset || asset.kind === 'pdf-thumb')
    return { ok: false, status: 404, error: 'Asset not found' }

  const url = `/api/files/${asset.filename}`
  let type: CanvasObject['type']
  let data: ImageData | PDFData | FontData
  let size: { width: number; height: number }

  if (asset.mediaKind === 'image') {
    type = 'image'
    data = { url }
    const ratio = asset.width && asset.height ? asset.height / asset.width : 0.75
    size = {
      width: IMAGE_WIDTH,
      height: Math.min(IMAGE_MAX_HEIGHT, Math.max(80, Math.round(IMAGE_WIDTH * ratio))),
    }
  } else if (asset.mediaKind === 'pdf') {
    type = 'pdf'
    size = PDF_SIZE
    let text = ''
    let pageCount: number | undefined
    try {
      const result = await processPdf(await readFile(pdfPath(asset.filename)))
      text = result.text
      pageCount = result.pageCount
    } catch (e) {
      console.warn(
        '[library] pdf re-read failed',
        asset.filename,
        e instanceof Error ? e.message : e,
      )
    }
    data = {
      url,
      thumbnailUrl: `/api/files/${asset.filename.replace(/\.pdf$/i, '.png')}`,
      extractedText: text,
      ...(pageCount ? { pageCount } : {}),
    }
  } else if (asset.mediaKind === 'font') {
    type = 'font'
    size = FONT_SIZE
    data = { url, family: deriveFontFamily(asset.originalName ?? asset.filename) }
  } else {
    return { ok: false, status: 415, error: `${asset.mediaKind} assets can't be placed on a board` }
  }

  const existing = (await loadBoardObjects(boardId)).map((v) => v.object)
  const object: CanvasObject = {
    id: nanoid(),
    type,
    position: at
      ? { x: at.x - size.width / 2, y: at.y - size.height / 2 }
      : nextSpot(existing, size),
    size,
    rotation: 0,
    zIndex: existing.length,
    data,
  } as CanvasObject
  await insertBoardObject(boardId, object, userId)
  return { ok: true, added: { object, version: 1 } }
}
