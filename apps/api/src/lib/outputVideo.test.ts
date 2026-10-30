import { parseVideoDoc, type RenderJob } from '@moodboard/shared'
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromiumAvailable } from './browser'

// Video outputs end to end against a real Postgres, Chromium and ffmpeg: the
// poster thumbnail, enqueue rules, the render-video job handler, and the
// download routes (range requests, share link). Skipped without a database
// or a browser.
const run = promisify(execFile)
const ready = Boolean(process.env.DATABASE_URL) && chromiumAvailable()

describe.skipIf(!ready)('video outputs', () => {
  let dbMod: typeof import('../db')
  let outputs: typeof import('./outputs')
  let videos: typeof import('./outputVideo')
  let jobs: typeof import('./jobs')
  let runner: typeof import('./jobRunner')
  let render: typeof import('./outputRender')
  let routes: typeof import('../routes/outputs')
  let jobRoutes: typeof import('../routes/renderJobs')

  const userId = `u-${nanoid()}`
  const clientId = `c-${nanoid()}`
  let videoId = ''
  let thumbId = ''
  let app: Hono<{ Variables: { user: unknown; session: unknown } }>

  beforeAll(async () => {
    dbMod = await import('../db')
    outputs = await import('./outputs')
    videos = await import('./outputVideo')
    jobs = await import('./jobs')
    runner = await import('./jobRunner')
    render = await import('./outputRender')
    routes = await import('../routes/outputs')
    jobRoutes = await import('../routes/renderJobs')
    const starters = await import('./starterTemplates')
    const templates = await import('./templates')
    const { db, schema } = dbMod
    await db.insert(schema.user).values({ id: userId, name: 'Vic', email: `${nanoid()}@team.com` })
    await db.insert(schema.client).values({ id: clientId, name: 'Video Co', slug: clientId })
    await starters.syncStarterTemplates()
    const all = await templates.listTemplates()
    const promo = all.find((t) => t.starter && t.name === 'Promo spot 16:9')!
    const thumb = all.find((t) => t.starter && t.format === 'thumbnail')!
    const made = await outputs.createOutput({
      templateId: promo.id,
      clientId,
      kitId: null,
      name: 'Spot',
      userId,
    })
    const plain = await outputs.createOutput({
      templateId: thumb.id,
      clientId,
      kitId: null,
      userId,
    })
    if (!made.ok || !plain.ok) throw new Error('setup failed')
    videoId = made.output.id
    thumbId = plain.output.id

    app = new Hono<{ Variables: { user: unknown; session: unknown } }>()
    app.use('*', async (c, next) => {
      c.set('user', c.req.header('x-test-anon') ? null : { id: userId })
      await next()
    })
    app.route('/outputs', routes.outputs)
    app.route('/output-shares', routes.outputShares)
    app.route('/render-jobs', jobRoutes.renderJobs)
  })

  afterAll(async () => {
    const { eq } = await import('drizzle-orm')
    const { db, schema } = dbMod
    await render.removeOutputFrames(videoId)
    await db.delete(schema.output).where(eq(schema.output.clientId, clientId))
    await db.delete(schema.client).where(eq(schema.client.id, clientId))
    await db.delete(schema.user).where(eq(schema.user.id, userId))
    await dbMod.pgClient.end()
  })

  it('knows a version is a video, with its duration and poster moment', async () => {
    const detail = (await outputs.getOutputDetail(videoId))!
    expect(detail.version.video).toEqual({ durationMs: 15000, posterMs: 4800 })
    expect(detail.output).toMatchObject({
      format: 'video',
      viewport: { width: 1920, height: 1080 },
    })
    expect((await outputs.getOutputDetail(thumbId))!.version.video).toBeNull()
  })

  it('thumbnails a video at its poster moment, not at t=0 or the end card', async () => {
    const poster = await render.renderOutputFrame(videoId)
    const first = await render.renderOutputFrame(videoId, { time: 0 })
    const end = await render.renderOutputFrame(videoId, { time: 'end' })
    const at = await render.renderOutputFrame(videoId, { time: 4800 })
    expect(poster!.png.equals(at!.png)).toBe(true)
    expect(poster!.png.equals(first!.png)).toBe(false)
    expect(poster!.png.equals(end!.png)).toBe(false)
    // Only the default frame is cached as the thumbnail.
    const cached = await render.outputThumbnail(videoId, 1)
    expect(cached!.png.equals(poster!.png)).toBe(true)
  }, 60_000)

  it('refuses to queue what isn’t a renderable video', async () => {
    expect(await videos.enqueueVideoRender({ outputId: 'nope', fps: 30, userId })).toMatchObject({
      ok: false,
      status: 404,
    })
    expect(await videos.enqueueVideoRender({ outputId: thumbId, fps: 30, userId })).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining('isn’t a video'),
    })
    expect(
      await videos.enqueueVideoRender({ outputId: videoId, version: 9, fps: 30, userId }),
    ).toMatchObject({ ok: false, status: 404 })
    // 30 s at 60 fps is over the 1800-frame cap once the spot is retimed.
    const doc = (await outputs.getOutputDetail(videoId))!
    const long = await outputs.addOutputVersion({
      outputId: videoId,
      userId,
      patch: {
        baseVersion: doc.output.latestVersion,
        html: doc.version.html.replace('data-duration="15000"', 'data-duration="40000"'),
      },
    })
    expect(long.ok).toBe(true)
    if (!long.ok) return
    expect(
      await videos.enqueueVideoRender({
        outputId: videoId,
        version: long.version,
        fps: 60,
        userId,
      }),
    ).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('frame') })
  })

  let shortVersion = 0

  it('queues once, returns the same job for an identical request, and cancels', async () => {
    const doc = (await outputs.getOutputDetail(videoId))!
    const short = await outputs.addOutputVersion({
      outputId: videoId,
      userId,
      patch: {
        baseVersion: doc.output.latestVersion,
        html: (await outputs.getOutputDetail(videoId, 1))!.version.html.replace(
          'data-duration="15000"',
          'data-duration="1000"',
        ),
      },
    })
    if (!short.ok) throw new Error('retime failed')
    shortVersion = short.version
    expect(
      parseVideoDoc((await outputs.getOutputDetail(videoId, shortVersion))!.version.html),
    ).toMatchObject({
      durationMs: 1000,
    })

    const body = JSON.stringify({ version: shortVersion, fps: 30 })
    const first = await app.request(`/outputs/${videoId}/render-video`, { method: 'POST', body })
    expect(first.status).toBe(200)
    const { job, render: existing } = (await first.json()) as { job: RenderJob; render: unknown }
    expect(existing).toBeNull()
    expect(job).toMatchObject({
      kind: 'render-video',
      status: expect.stringMatching(/queued|running/),
      outputId: videoId,
      payload: { outputId: videoId, version: shortVersion, fps: 30 },
    })
    const again = (await (
      await app.request(`/outputs/${videoId}/render-video`, { method: 'POST', body })
    ).json()) as { job: RenderJob }
    expect(again.job.id).toBe(job.id)

    const status = (await (await app.request(`/render-jobs/${job.id}`)).json()) as {
      job: RenderJob
    }
    expect(status.job.id).toBe(job.id)
    const listed = (await (
      await app.request(`/outputs/${videoId}/renders?version=${shortVersion}`)
    ).json()) as { jobs: RenderJob[]; renders: unknown[] }
    expect(listed.jobs.map((j) => j.id)).toContain(job.id)
    expect(listed.renders).toEqual([])

    const cancelled = (await (
      await app.request(`/render-jobs/${job.id}/cancel`, { method: 'POST' })
    ).json()) as { job: RenderJob }
    expect(cancelled.job.status).toBe('cancelled')
    expect((await app.request('/render-jobs/missing')).status).toBe(404)
    expect(
      (await app.request(`/render-jobs/${job.id}`, { headers: { 'x-test-anon': '1' } })).status,
    ).toBe(401)
  })

  it('renders through the job handler: MP4 on the volume, a sidecar, a result', async () => {
    const payload = { outputId: videoId, version: shortVersion, fps: 30 }
    const { job } = await jobs.enqueueJob({
      kind: 'render-video',
      payload: { ...payload, maxEdge: 320, clipMs: 500 },
      outputId: videoId,
      userId,
    })
    // Run the handler as the worker would, without racing other workers.
    const progress: number[] = []
    const result = await videos.renderVideoHandler(job, {
      signal: new AbortController().signal,
      progress: (p) => progress.push(p),
    })
    await jobs.cancelJob(job.id)
    expect(result).toMatchObject({ fps: 30, width: 320, height: 180, frames: 15, draft: true })
    expect(progress.at(-1)).toBe(1)
    // Drafts are never offered as the version's video.
    expect(await videos.listVideoRenders(videoId, shortVersion)).toEqual([])

    const full = await videos.renderVideoHandler(
      { ...job, payload },
      { signal: new AbortController().signal, progress: () => undefined },
    )
    expect(full).toMatchObject({
      fps: 30,
      width: 1920,
      height: 1080,
      frames: 30,
      durationMs: 1000,
      draft: false,
    })
    const file = videos.videoFilePath(videoId, shortVersion, 30)!
    expect((await stat(file)).size).toBe(full.bytes)
    const probe = JSON.parse(
      (await run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', file]))
        .stdout,
    ) as { streams: Record<string, unknown>[] }
    expect(probe.streams[0]).toMatchObject({
      codec_name: 'h264',
      pix_fmt: 'yuv420p',
      width: 1920,
      height: 1080,
      nb_read_frames: '30',
    })
    expect(await videos.listVideoRenders(videoId, shortVersion)).toEqual([
      expect.objectContaining({ fps: 30, width: 1920, frames: 30 }),
    ])
    // Rendering again isn't queued without force.
    const rendered = await videos.enqueueVideoRender({
      outputId: videoId,
      version: shortVersion,
      fps: 30,
      userId,
    })
    expect(rendered).toMatchObject({ ok: true, job: null, render: { fps: 30 } })
  }, 120_000)

  it('fails a job on a deleted output permanently', async () => {
    const gone = { id: 'x', payload: { outputId: 'does-not-exist', version: 1, fps: 30 } }
    await expect(
      videos.renderVideoHandler(gone as never, {
        signal: new AbortController().signal,
        progress: () => undefined,
      }),
    ).rejects.toBeInstanceOf(runner.PermanentJobError)
  })

  it('serves the MP4 to a signed-in user with range support, and through the share link', async () => {
    const res = await app.request(`/outputs/${videoId}/video?version=${shortVersion}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-disposition')).toContain('inline')
    const total = Number(res.headers.get('content-length'))
    expect(total).toBeGreaterThan(1000)
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp')

    const part = await app.request(`/outputs/${videoId}/video?version=${shortVersion}&fps=30`, {
      headers: { range: 'bytes=0-99' },
    })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 0-99/${total}`)
    expect((await part.arrayBuffer()).byteLength).toBe(100)

    const dl = await app.request(`/outputs/${videoId}/video?version=${shortVersion}&download=1`)
    expect(dl.headers.get('content-disposition')).toMatch(
      /^attachment; filename="Spot v\d+ 30fps\.mp4"$/,
    )
    expect(
      (await app.request(`/outputs/${videoId}/video?version=${shortVersion}&fps=45`)).status,
    ).toBe(400)
    expect((await app.request(`/outputs/${videoId}/video?version=1`)).status).toBe(404)
    expect(
      (await app.request(`/outputs/${videoId}/video`, { headers: { 'x-test-anon': '1' } })).status,
    ).toBe(401)

    // Share link: pinned to the version, public, with the video in its view.
    const share = (await outputs.shareOutput(videoId, userId))!
    expect(share.version).toBe(shortVersion)
    const view = (await (
      await app.request(`/output-shares/${share.token}`, { headers: { 'x-test-anon': '1' } })
    ).json()) as {
      share: { video: { durationMs: number; renders: { fps: number }[] } | null }
    }
    expect(view.share.video).toMatchObject({ durationMs: 1000, renders: [{ fps: 30 }] })
    const shared = await app.request(`/output-shares/${share.token}/video`, {
      headers: { 'x-test-anon': '1', range: 'bytes=0-7' },
    })
    expect(shared.status).toBe(206)
    expect(
      (await app.request('/output-shares/bogus/video', { headers: { 'x-test-anon': '1' } })).status,
    ).toBe(404)
  })

  it('composes the timeline runtime into video documents only, under the document CSP', async () => {
    const video = await outputs.composeDoc((await outputs.outputRenderDoc(videoId))!)
    expect(video.html).toContain('__moodboardTimeline')
    expect(video.csp).toContain("'sha256-")
    const plain = await outputs.composeDoc((await outputs.outputRenderDoc(thumbId))!)
    expect(plain.html).not.toContain('__moodboardTimeline')
    expect(plain.csp).toContain("script-src 'none'")
  })
})
