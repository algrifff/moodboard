import {
  figmaCardSize,
  figmaFrameDataSchema,
  type CanvasObject,
  type FigmaFrameData,
} from '@moodboard/shared'
import { nanoid } from 'nanoid'
import {
  insertBoardObject,
  loadBoardObjects,
  saveBoardObjects,
  type VersionedObject,
} from './boardObjects'
import { nextSpot } from './canvasPlacement'

// Figma cards on a board, from the server side (tools and the MCP).

export type BoardFigmaFrame = { object: CanvasObject; version: number; data: FigmaFrameData }

export async function boardFigmaFrames(boardId: string): Promise<BoardFigmaFrame[]> {
  const frames: BoardFigmaFrame[] = []
  for (const v of await loadBoardObjects(boardId)) {
    if (v.object.type !== 'figma-frame') continue
    const data = figmaFrameDataSchema.safeParse(v.object.data)
    // A card written by a newer build shouldn't take the lookup down.
    if (data.success) frames.push({ object: v.object, version: v.version, data: data.data })
  }
  return frames
}

export async function placeFigmaFrame(args: {
  boardId: string
  userId: string
  data: FigmaFrameData
  at?: { x: number; y: number }
}): Promise<VersionedObject> {
  const size = figmaCardSize(args.data.width, args.data.height)
  const existing = (await loadBoardObjects(args.boardId)).map((v) => v.object)
  const object: CanvasObject = {
    id: nanoid(),
    type: 'figma-frame',
    position: args.at
      ? { x: args.at.x - size.width / 2, y: args.at.y - size.height / 2 }
      : nextSpot(existing, size),
    size,
    rotation: 0,
    zIndex: existing.length,
    data: args.data,
  }
  await insertBoardObject(args.boardId, object, args.userId)
  return { object, version: 1 }
}

// A versioned write: a teammate's concurrent edit wins and is reported.
export async function updateFigmaFrameOnBoard(args: {
  boardId: string
  userId: string
  frame: BoardFigmaFrame
  data: FigmaFrameData
}): Promise<VersionedObject | null> {
  const object: CanvasObject = { ...args.frame.object, data: args.data }
  const result = await saveBoardObjects(
    args.boardId,
    {
      upserts: [
        {
          object: object as unknown as Parameters<
            typeof saveBoardObjects
          >[1]['upserts'][number]['object'],
          baseVersion: args.frame.version,
        },
      ],
      deletes: [],
    },
    args.userId,
  )
  const version = result.versions[object.id]
  return version === undefined ? null : { object, version }
}
