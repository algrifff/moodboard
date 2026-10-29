import type { DriveFileData, DriveFolderData, ImageData, PDFData } from '@moodboard/shared'
import { nanoid } from 'nanoid'
import type { SpotifyImportResult } from '@/lib/connectionsApi'
import {
  createDriveFile,
  createDriveFolder,
  createSpotifyAlbum,
  createSpotifyPlaylist,
  createSpotifyTrack,
} from '@/lib/objectFactory'
import { screenToWorld } from '@moodboard/shared'
import { useCanvasStore } from '@/store/canvas'

// ---------------------------------------------------------------------------
// Spawn helpers — same as before, kept here so the picker drawer is the only
// surface that talks to the canvas store directly from a tile import.
// ---------------------------------------------------------------------------

export function spawnDriveAtViewportCenter(
  result:
    | { kind: 'file'; data: DriveFileData }
    | { kind: 'folder'; data: DriveFolderData }
    | { kind: 'pdf'; data: PDFData }
    | { kind: 'image'; data: ImageData },
) {
  const { scale, offset, viewportSize, objects, addObject, commitBeforeAction } =
    useCanvasStore.getState()
  const center = screenToWorld(
    { x: viewportSize.width / 2, y: viewportSize.height / 2 },
    { scale, x: offset.x, y: offset.y },
  )
  commitBeforeAction()
  if (result.kind === 'file') {
    addObject(createDriveFile(center, objects.length, result.data))
  } else if (result.kind === 'folder') {
    addObject(createDriveFolder(center, objects.length, result.data))
  } else if (result.kind === 'pdf') {
    addObject({
      id: nanoid(),
      type: 'pdf',
      position: { x: center.x - 90, y: center.y - 120 },
      size: { width: 180, height: 240 },
      rotation: 0,
      zIndex: objects.length,
      data: result.data,
    })
  } else {
    addObject({
      id: nanoid(),
      type: 'image',
      position: { x: center.x - 200, y: center.y - 150 },
      size: { width: 400, height: 300 },
      rotation: 0,
      zIndex: objects.length,
      data: result.data,
    })
  }
}

export function spawnSpotifyAtViewportCenter(result: SpotifyImportResult) {
  const { scale, offset, viewportSize, objects, addObject, commitBeforeAction } =
    useCanvasStore.getState()
  const center = screenToWorld(
    { x: viewportSize.width / 2, y: viewportSize.height / 2 },
    { scale, x: offset.x, y: offset.y },
  )
  commitBeforeAction()
  if (result.kind === 'playlist') {
    addObject(createSpotifyPlaylist(center, objects.length, result.data))
  } else if (result.kind === 'track') {
    addObject(createSpotifyTrack(center, objects.length, result.data))
  } else {
    addObject(createSpotifyAlbum(center, objects.length, result.data))
  }
}
