import { describe, expect, it } from 'vitest'
import {
  formatLinearIssue,
  linearIssueBlock,
  parseLinearIssueBlock,
  resolveIssueClientId,
  type LinearIssueDetail,
} from './linear'

const issue: LinearIssueDetail = {
  id: 'uuid-1',
  identifier: 'LIN-123',
  title: 'Thumbnail for the launch video',
  url: 'https://linear.app/acme/issue/LIN-123',
  stateName: 'In Progress',
  priorityLabel: 'High',
  assigneeName: 'Ada',
  teamId: 't1',
  teamKey: 'LIN',
  teamName: 'Linear Team',
  projectId: 'p1',
  projectName: 'Launch',
  updatedAt: '2026-10-01T10:00:00.000Z',
  clientId: null,
  description: 'Punchy, dark. 16:9.',
  labels: ['design', 'video'],
  comments: [
    { id: 'c1', author: 'Bo', body: 'Use the yellow.', createdAt: '2026-10-02T09:00:00.000Z' },
  ],
  attachments: [
    {
      id: 'a1',
      title: 'Figma',
      subtitle: 'frame',
      url: 'https://figma.com/x',
      sourceType: 'figma',
    },
  ],
}

describe('resolveIssueClientId', () => {
  const mappings = [
    { kind: 'team' as const, linearId: 't1', clientId: 'acme' },
    { kind: 'project' as const, linearId: 'p1', clientId: 'globex' },
  ]

  it('prefers the project mapping over the team mapping', () => {
    expect(resolveIssueClientId(mappings, { teamId: 't1', projectId: 'p1' })).toBe('globex')
  })

  it('falls back to the team mapping', () => {
    expect(resolveIssueClientId(mappings, { teamId: 't1', projectId: 'p9' })).toBe('acme')
    expect(resolveIssueClientId(mappings, { teamId: 't1', projectId: null })).toBe('acme')
  })

  it('returns null when nothing maps', () => {
    expect(resolveIssueClientId(mappings, { teamId: 't2', projectId: null })).toBeNull()
    expect(resolveIssueClientId([], { teamId: 't1', projectId: 'p1' })).toBeNull()
  })
})

describe('issue context block', () => {
  it('formats identifier, description, attachments and comments for the model', () => {
    const text = formatLinearIssue(issue, 'Acme')
    expect(text.split('\n')[0]).toBe('[Linear issue LIN-123] Thumbnail for the launch video')
    expect(text).toContain('Client (from the Linear team/project mapping): Acme')
    expect(text).toContain('Punchy, dark. 16:9.')
    expect(text).toContain('- Figma (frame): https://figma.com/x')
    expect(text).toContain('- Bo, 2026-10-02: Use the yellow.')
  })

  it('round-trips through parseLinearIssueBlock', () => {
    expect(parseLinearIssueBlock(linearIssueBlock(issue))).toEqual({
      identifier: 'LIN-123',
      title: 'Thumbnail for the launch video',
    })
  })

  it('ignores ordinary text blocks', () => {
    expect(parseLinearIssueBlock({ type: 'text', text: 'hello' })).toBeNull()
    expect(parseLinearIssueBlock({ type: 'tool_use' })).toBeNull()
  })

  it('truncates a very long description', () => {
    const long = formatLinearIssue({ ...issue, description: 'x'.repeat(20_000) })
    expect(long.length).toBeLessThan(9000)
  })
})
