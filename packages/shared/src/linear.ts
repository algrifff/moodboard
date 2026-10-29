import { z } from 'zod'
import type { AgentTextBlock } from './agent'

// Phase 22 — Linear as the brief source. Issues are read through Linear's
// GraphQL API (apps/api/src/lib/linear.ts maps raw responses to these
// shapes). Picking an issue is the only trigger; nothing is written back to
// Linear until Phase 24.

export const linearIssueSummarySchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  stateName: z.string(),
  priorityLabel: z.string(),
  assigneeName: z.string().nullable(),
  teamId: z.string(),
  teamKey: z.string(),
  teamName: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  updatedAt: z.string(),
  // The client the team/project mapping resolves this issue to, if any.
  clientId: z.string().nullable(),
})
export type LinearIssueSummary = z.infer<typeof linearIssueSummarySchema>

export const linearCommentSchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
})

export const linearAttachmentSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  url: z.string(),
  sourceType: z.string().nullable(),
})

export const linearIssueDetailSchema = linearIssueSummarySchema.extend({
  description: z.string(),
  labels: z.array(z.string()),
  comments: z.array(linearCommentSchema),
  attachments: z.array(linearAttachmentSchema),
})
export type LinearIssueDetail = z.infer<typeof linearIssueDetailSchema>

export const linearIssuesResponseSchema = z.object({ issues: z.array(linearIssueSummarySchema) })
export const linearIssueResponseSchema = z.object({ issue: linearIssueDetailSchema })

export const linearViewSchema = z.enum(['assigned', 'recent'])
export type LinearView = z.infer<typeof linearViewSchema>

export const linearStatusSchema = z.object({
  // False when the server has no LINEAR_CLIENT_ID/SECRET/REDIRECT_URI.
  configured: z.boolean(),
  connection: z
    .object({
      id: z.string(),
      accountEmail: z.string(),
      workspaceName: z.string().nullable(),
    })
    .nullable(),
})
export type LinearStatus = z.infer<typeof linearStatusSchema>

// ---------------------------------------------------------------------------
// Team/project ↔ client mapping
// ---------------------------------------------------------------------------

export const linearMappingKindSchema = z.enum(['team', 'project'])
export type LinearMappingKind = z.infer<typeof linearMappingKindSchema>

export const linearMappingSchema = z.object({
  kind: linearMappingKindSchema,
  linearId: z.string(),
  linearName: z.string(),
  clientId: z.string(),
})
export type LinearMapping = z.infer<typeof linearMappingSchema>

export const linearTeamSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type LinearTeam = z.infer<typeof linearTeamSchema>

export const linearMappingsResponseSchema = z.object({
  mappings: z.array(linearMappingSchema),
  // Null when the viewer has no Linear connection (or Linear is down), so the
  // settings UI can still show — and clear — saved mappings.
  teams: z.array(linearTeamSchema).nullable(),
})

export const putLinearMappingRequestSchema = z.object({
  kind: linearMappingKindSchema,
  linearId: z.string().min(1),
  linearName: z.string().min(1).max(200),
  // Null clears the mapping.
  clientId: z.string().min(1).nullable(),
})
export type PutLinearMappingRequest = z.infer<typeof putLinearMappingRequestSchema>

// A project mapping is more specific than its team's, so it wins.
export function resolveIssueClientId(
  mappings: Pick<LinearMapping, 'kind' | 'linearId' | 'clientId'>[],
  issue: { teamId: string; projectId: string | null },
): string | null {
  const project = issue.projectId
    ? mappings.find((m) => m.kind === 'project' && m.linearId === issue.projectId)
    : undefined
  if (project) return project.clientId
  return mappings.find((m) => m.kind === 'team' && m.linearId === issue.teamId)?.clientId ?? null
}

// ---------------------------------------------------------------------------
// The issue as agent context
// ---------------------------------------------------------------------------

const ISSUE_PREFIX = '[Linear issue '
const MAX_BODY_CHARS = 6000
const MAX_COMMENT_CHARS = 1500

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s)

// Plain text the model reads: the brief, in the order a person would.
export function formatLinearIssue(issue: LinearIssueDetail, clientName?: string | null): string {
  const lines = [
    `${ISSUE_PREFIX}${issue.identifier}] ${issue.title}`,
    `URL: ${issue.url}`,
    `Status: ${issue.stateName} · Priority: ${issue.priorityLabel} · Assignee: ${issue.assigneeName ?? 'unassigned'}`,
    `Team: ${issue.teamName} (${issue.teamKey})${issue.projectName ? ` · Project: ${issue.projectName}` : ''}`,
  ]
  if (clientName) lines.push(`Client (from the Linear team/project mapping): ${clientName}`)
  if (issue.labels.length > 0) lines.push(`Labels: ${issue.labels.join(', ')}`)
  lines.push('', 'Description:', clip(issue.description.trim() || '(none)', MAX_BODY_CHARS))
  if (issue.attachments.length > 0) {
    lines.push('', 'Attachments:')
    for (const a of issue.attachments) {
      lines.push(`- ${a.title || a.url}${a.subtitle ? ` (${a.subtitle})` : ''}: ${a.url}`)
    }
  }
  if (issue.comments.length > 0) {
    lines.push('', 'Comments (oldest first):')
    for (const c of issue.comments) {
      lines.push(
        `- ${c.author}, ${c.createdAt.slice(0, 10)}: ${clip(c.body.trim(), MAX_COMMENT_CHARS)}`,
      )
    }
  }
  return lines.join('\n')
}

// Rides along on the user's message like the canvas selection, so the model
// reads it and a replayed thread keeps it. The sidebar shows a chip instead
// of the text.
export function linearIssueBlock(
  issue: LinearIssueDetail,
  clientName?: string | null,
): AgentTextBlock {
  return { type: 'text', text: formatLinearIssue(issue, clientName) }
}

export function parseLinearIssueBlock(block: {
  type: string
  text?: string
}): { identifier: string; title: string } | null {
  if (block.type !== 'text' || !block.text?.startsWith(ISSUE_PREFIX)) return null
  const first = block.text.split('\n', 1)[0]!
  const close = first.indexOf(']')
  if (close === -1) return null
  return {
    identifier: first.slice(ISSUE_PREFIX.length, close),
    title: first.slice(close + 1).trim(),
  }
}
