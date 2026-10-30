import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canComment, linearApi, type FetchLike } from './linear'
import { designCommentBody, linearPostGate, postOutputComment } from './linearPost'

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/linear/${name}.json`, import.meta.url), 'utf8'))

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown }

// Answers like Linear: GraphQL by operation, plus the signed storage PUT.
function fakeLinear(opts: { uploadStatus?: number } = {}) {
  const calls: Call[] = []
  const impl = (async (url: string, init: RequestInit) => {
    const raw = init.body
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body,
    })
    const reply = (json: unknown, status = 200) =>
      new Response(JSON.stringify(json), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    if (url.startsWith('https://uploads.linear.app/')) {
      return new Response(null, { status: opts.uploadStatus ?? 200 })
    }
    const query = (body as { query: string }).query
    if (query.includes('IssueDetail')) return reply(fixture('issue'))
    if (query.includes('FileUpload')) {
      return reply({
        data: {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: 'https://uploads.linear.app/signed/abc',
              assetUrl: 'https://uploads.linear.app/asset/abc.png',
              headers: [{ key: 'x-goog-content-length-range', value: '1,10000000' }],
            },
          },
        },
      })
    }
    if (query.includes('CommentCreate')) {
      return reply({
        data: {
          commentCreate: {
            success: true,
            comment: { id: 'c1', url: 'https://linear.app/acme/issue/LIN-123#comment-c1' },
          },
        },
      })
    }
    return reply({ errors: [{ message: 'unexpected' }] }, 400)
  }) as unknown as FetchLike
  return { impl, calls }
}

const output = { id: 'out1', name: 'Liftoff', format: 'thumbnail' as const, clientName: 'Acme' }
const share = 'http://localhost:5173/share/output/tok123'

describe('linearPostGate', () => {
  const run = { chosenOutputId: null, linearIssue: 'LIN-123' }

  it('refuses a design-run variant until it is the picked one', () => {
    expect(linearPostGate(run, 'out1')).toEqual({
      ok: false,
      error: expect.stringMatching(/Nothing has been picked yet/),
    })
    expect(linearPostGate({ ...run, chosenOutputId: 'out2' }, 'out1')).toEqual({
      ok: false,
      error: expect.stringMatching(/wasn’t the one picked/),
    })
    expect(linearPostGate({ ...run, chosenOutputId: 'out1' }, 'out1')).toEqual({
      ok: true,
      issue: 'LIN-123',
    })
  })

  it('needs an issue: the run’s, or one the person named', () => {
    expect(linearPostGate(null, 'out1')).toMatchObject({ ok: false })
    expect(linearPostGate(null, 'out1', 'OPS-9')).toEqual({ ok: true, issue: 'OPS-9' })
    expect(linearPostGate({ chosenOutputId: 'out1', linearIssue: null }, 'out1', 'LIN-7')).toEqual({
      ok: true,
      issue: 'LIN-7',
    })
  })
})

describe('postOutputComment', () => {
  it('looks the issue up, uploads the thumbnail, then comments with the image and share link', async () => {
    const { impl, calls } = fakeLinear()
    const result = await postOutputComment({
      api: linearApi('tok', impl),
      fetchImpl: impl,
      issueRef: 'LIN-123',
      output,
      shareUrl: share,
      thumbnail: Buffer.from('png-bytes'),
    })
    expect(result).toEqual({
      commentUrl: 'https://linear.app/acme/issue/LIN-123#comment-c1',
      issueIdentifier: 'LIN-123',
      imageAttached: true,
    })
    expect(
      calls.map((c) =>
        c.method === 'PUT'
          ? 'PUT'
          : (c.body as { query: string }).query.match(/(query|mutation) (\w+)/)![2],
      ),
    ).toEqual(['IssueDetail', 'FileUpload', 'PUT', 'CommentCreate'])
    const put = calls[2]!
    expect(put.url).toBe('https://uploads.linear.app/signed/abc')
    expect(put.headers).toMatchObject({
      'Content-Type': 'image/png',
      'x-goog-content-length-range': '1,10000000',
    })
    const comment = (calls[3]!.body as { variables: { input: { issueId: string; body: string } } })
      .variables.input
    expect(comment.issueId).toBe('7f1c5a3e-0b1d-4f6a-9e0a-1d2c3b4a5f60')
    expect(comment.body).toContain('**Liftoff** — Thumbnail for Acme')
    expect(comment.body).toContain(
      '![Thumbnail for Acme](https://uploads.linear.app/asset/abc.png)',
    )
    expect(comment.body).toContain(`[Open the design](${share})`)
  })

  it('still posts the link when the upload fails', async () => {
    const { impl, calls } = fakeLinear({ uploadStatus: 403 })
    const result = await postOutputComment({
      api: linearApi('tok', impl),
      fetchImpl: impl,
      issueRef: 'LIN-123',
      output,
      shareUrl: share,
      thumbnail: Buffer.from('png'),
    })
    expect(result.imageAttached).toBe(false)
    const body = (calls.at(-1)!.body as { variables: { input: { body: string } } }).variables.input
      .body
    expect(body).not.toContain('![')
    expect(body).toContain(share)
  })
})

describe('designCommentBody / canComment', () => {
  it('keeps a hostile name from breaking the markdown', () => {
    expect(
      designCommentBody({
        name: '**[x](http://evil)**',
        format: 'deck',
        clientName: null,
        shareUrl: share,
        imageUrl: null,
      }).split('\n')[0],
    ).toBe('**x(http://evil)** — Deck')
  })

  it('reads comment permission from stored scopes', () => {
    expect(canComment('read')).toBe(false)
    expect(canComment('read,comments:create')).toBe(true)
    expect(canComment('read write')).toBe(true)
  })
})
