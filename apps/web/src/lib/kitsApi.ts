import {
  kitDetailSchema,
  kitResponseSchema,
  kitsResponseSchema,
  type CreateKitRequest,
  type CreateKitVersionRequest,
  type KitDetail,
  type KitSummary,
  type UpdateKitRequest,
} from '@moodboard/shared'
import { jsonBody, requestJson } from './http'

export async function listKits(clientId?: string): Promise<KitSummary[]> {
  const query = clientId ? `?client=${encodeURIComponent(clientId)}` : ''
  return kitsResponseSchema.parse(await requestJson(`/api/kits${query}`)).kits
}

export async function getKit(id: string, version?: number): Promise<KitDetail> {
  const query = version ? `?version=${version}` : ''
  return kitDetailSchema.parse(await requestJson(`/api/kits/${id}${query}`))
}

export async function createKit(request: CreateKitRequest): Promise<KitSummary> {
  const body = await requestJson('/api/kits', { method: 'POST', body: jsonBody(request) })
  return kitResponseSchema.parse(body).kit
}

export async function updateKit(id: string, patch: UpdateKitRequest): Promise<KitSummary> {
  const body = await requestJson(`/api/kits/${id}`, { method: 'PATCH', body: jsonBody(patch) })
  return kitResponseSchema.parse(body).kit
}

export async function addKitVersion(
  id: string,
  request: CreateKitVersionRequest,
): Promise<KitDetail> {
  const body = await requestJson(`/api/kits/${id}/versions`, {
    method: 'POST',
    body: jsonBody(request),
  })
  return kitDetailSchema.parse(body)
}

export async function deleteKit(id: string): Promise<void> {
  await requestJson(`/api/kits/${id}`, { method: 'DELETE' })
}
