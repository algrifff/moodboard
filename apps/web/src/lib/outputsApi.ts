import {
  boardObjectChangeSchema,
  outputDetailSchema,
  outputResponseSchema,
  outputShareResponseSchema,
  outputShareViewResponseSchema,
  proposedSlotsResponseSchema,
  outputsResponseSchema,
  templateDetailSchema,
  templateResponseSchema,
  templatesResponseSchema,
  type CreateOutputRequest,
  type CreateOutputVersionRequest,
  type CreateTemplateFromOutputRequest,
  type OutputDetail,
  type OutputFormat,
  type OutputShare,
  type OutputShareView,
  type OutputSummary,
  type TemplateDetail,
  type ProposedSlot,
  type TemplateSummary,
  type UpdateOutputRequest,
} from '@moodboard/shared'
import { jsonBody, requestJson } from './http'

export async function listTemplates(filter: { client?: string; format?: OutputFormat } = {}) {
  const q = new URLSearchParams()
  if (filter.client) q.set('client', filter.client)
  if (filter.format) q.set('format', filter.format)
  return templatesResponseSchema.parse(await requestJson(`/api/templates?${q}`)).templates
}

export async function getTemplate(id: string, version?: number): Promise<TemplateDetail> {
  const query = version ? `?version=${version}` : ''
  return templateDetailSchema.parse(await requestJson(`/api/templates/${id}${query}`))
}

export function templateRenderUrl(id: string, kitId?: string | null): string {
  return `/api/templates/${id}/render${kitId ? `?kit=${encodeURIComponent(kitId)}` : ''}`
}

export async function saveAsTemplate(
  request: CreateTemplateFromOutputRequest,
): Promise<TemplateSummary> {
  const body = await requestJson('/api/templates', { method: 'POST', body: jsonBody(request) })
  return templateResponseSchema.parse(body).template
}

export async function deleteTemplate(id: string): Promise<void> {
  await requestJson(`/api/templates/${id}`, { method: 'DELETE' })
}

// `client: 'none'` lists outputs without a client.
export async function listOutputs(
  filter: { client?: string; board?: string } = {},
): Promise<OutputSummary[]> {
  const q = new URLSearchParams()
  if (filter.client) q.set('client', filter.client)
  if (filter.board) q.set('board', filter.board)
  return outputsResponseSchema.parse(await requestJson(`/api/outputs?${q}`)).outputs
}

export async function createOutput(request: CreateOutputRequest): Promise<OutputSummary> {
  const body = await requestJson('/api/outputs', { method: 'POST', body: jsonBody(request) })
  return outputResponseSchema.parse(body).output
}

export async function getOutput(id: string, version?: number): Promise<OutputDetail> {
  const query = version ? `?version=${version}` : ''
  return outputDetailSchema.parse(await requestJson(`/api/outputs/${id}${query}`))
}

export async function addOutputVersion(
  id: string,
  request: CreateOutputVersionRequest,
): Promise<OutputDetail> {
  const body = await requestJson(`/api/outputs/${id}/versions`, {
    method: 'POST',
    body: jsonBody(request),
  })
  return outputDetailSchema.parse(body)
}

export async function updateOutput(id: string, patch: UpdateOutputRequest): Promise<OutputSummary> {
  const body = await requestJson(`/api/outputs/${id}`, { method: 'PATCH', body: jsonBody(patch) })
  return outputResponseSchema.parse(body).output
}

export async function deleteOutput(id: string): Promise<void> {
  await requestJson(`/api/outputs/${id}`, { method: 'DELETE' })
}

export async function proposedSlots(id: string, version?: number): Promise<ProposedSlot[]> {
  const query = version ? `?version=${version}` : ''
  const body = await requestJson(`/api/outputs/${id}/proposed-slots${query}`)
  return proposedSlotsResponseSchema.parse(body).slots
}

export async function placeOutput(
  id: string,
  boardId: string,
  position?: { x: number; y: number },
) {
  const body = await requestJson(`/api/outputs/${id}/place`, {
    method: 'POST',
    body: jsonBody({ boardId, ...(position ? { position } : {}) }),
  })
  return boardObjectChangeSchema.parse(body)
}

export async function shareOutput(id: string): Promise<OutputShare> {
  const body = await requestJson(`/api/outputs/${id}/share`, { method: 'POST' })
  return outputShareResponseSchema.parse(body).share
}

export async function unshareOutput(id: string): Promise<void> {
  await requestJson(`/api/outputs/${id}/share`, { method: 'DELETE' })
}

export async function getSharedOutput(token: string): Promise<OutputShareView> {
  const body = await requestJson(`/api/output-shares/${encodeURIComponent(token)}`)
  return outputShareViewResponseSchema.parse(body).share
}

export const shareRenderUrl = (token: string, download = false) =>
  `/api/output-shares/${encodeURIComponent(token)}/render${download ? '?download=1' : ''}`

export const sharePageUrl = (token: string) => `${window.location.origin}/share/output/${token}`
