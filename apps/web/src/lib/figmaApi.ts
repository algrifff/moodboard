import {
  figmaFileResponseSchema,
  figmaImportResponseSchema,
  figmaKitResponseSchema,
  figmaRefreshResponseSchema,
  figmaStatusSchema,
  type FigmaFileTree,
  type FigmaFrameData,
  type FigmaKitRequest,
  type FigmaKitResponse,
  type FigmaRefreshResponse,
  type FigmaStatus,
} from '@moodboard/shared'
import { jsonBody, requestJson } from './http'

export async function getFigmaStatus(): Promise<FigmaStatus> {
  return figmaStatusSchema.parse(await requestJson('/api/figma/status'))
}

/** A file link's pages and frames, for the picker. */
export async function getFigmaFile(url: string): Promise<FigmaFileTree> {
  const body = await requestJson(`/api/figma/file?url=${encodeURIComponent(url)}`)
  return figmaFileResponseSchema.parse(body).file
}

export async function importFigmaFrames(request: {
  url: string
  nodeIds?: string[]
  boardId?: string
  clientId?: string
}): Promise<FigmaFrameData[]> {
  const body = await requestJson('/api/figma/import', {
    method: 'POST',
    body: jsonBody(request),
  })
  return figmaImportResponseSchema.parse(body).frames
}

export async function refreshFigmaFrame(
  boardId: string,
  objectId: string,
  force = false,
): Promise<FigmaRefreshResponse> {
  const body = await requestJson('/api/figma/refresh', {
    method: 'POST',
    body: jsonBody({ boardId, objectId, force }),
  })
  return figmaRefreshResponseSchema.parse(body)
}

export async function figmaKit(request: FigmaKitRequest): Promise<FigmaKitResponse> {
  const body = await requestJson('/api/figma/kit', { method: 'POST', body: jsonBody(request) })
  return figmaKitResponseSchema.parse(body)
}
