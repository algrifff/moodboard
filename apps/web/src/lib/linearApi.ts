import {
  linearIssueResponseSchema,
  linearIssuesResponseSchema,
  linearMappingsOnlyResponseSchema,
  linearMappingsResponseSchema,
  linearStatusSchema,
  type LinearIssueDetail,
  type LinearIssueSummary,
  type LinearStatus,
  type LinearView,
  type PutLinearMappingRequest,
} from '@moodboard/shared'
import { jsonBody, requestJson } from './http'

export async function getLinearStatus(): Promise<LinearStatus> {
  return linearStatusSchema.parse(await requestJson('/api/linear/status'))
}

export async function listLinearIssues(opts: {
  q?: string
  view?: LinearView
}): Promise<LinearIssueSummary[]> {
  const params = new URLSearchParams()
  if (opts.q) params.set('q', opts.q)
  if (opts.view) params.set('view', opts.view)
  return linearIssuesResponseSchema.parse(await requestJson(`/api/linear/issues?${params}`)).issues
}

export async function getLinearIssue(ref: string): Promise<LinearIssueDetail> {
  return linearIssueResponseSchema.parse(
    await requestJson(`/api/linear/issues/${encodeURIComponent(ref)}`),
  ).issue
}

export async function getLinearMappings() {
  return linearMappingsResponseSchema.parse(await requestJson('/api/linear/mappings'))
}

export async function putLinearMapping(request: PutLinearMappingRequest) {
  const body = await requestJson('/api/linear/mappings', {
    method: 'PUT',
    body: jsonBody(request),
  })
  return linearMappingsOnlyResponseSchema.parse(body).mappings
}
