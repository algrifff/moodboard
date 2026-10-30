import {
  renderJobResponseSchema,
  renderJobsResponseSchema,
  renderJobPath,
  renderJobSchema,
  renderVideoResponseSchema,
  renderJobStreamPath,
  isTerminalJobStatus,
  type RenderJob,
  type RenderVideoRequest,
} from '@moodboard/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsonBody, requestJson } from './http'

export async function renderVideo(outputId: string, request: Partial<RenderVideoRequest> = {}) {
  const body = await requestJson(`/api/outputs/${outputId}/render-video`, {
    method: 'POST',
    body: jsonBody(request),
  })
  return renderVideoResponseSchema.parse(body)
}

export async function listRenders(outputId: string, version?: number) {
  const query = version ? `?version=${version}` : ''
  return renderJobsResponseSchema.parse(
    await requestJson(`/api/outputs/${outputId}/renders${query}`),
  )
}

export async function getRenderJob(id: string): Promise<RenderJob> {
  return renderJobResponseSchema.parse(await requestJson(renderJobPath(id))).job
}

export async function cancelRenderJob(id: string): Promise<RenderJob> {
  const body = await requestJson(`${renderJobPath(id)}/cancel`, { method: 'POST' })
  return renderJobResponseSchema.parse(body).job
}

// A job as it changes: server-sent events, with polling when the stream
// can't be held (a proxy, a dropped connection). Stops at a terminal status.
export function useRenderJob(jobId: string | null, initial?: RenderJob | null) {
  const [job, setJob] = useState<RenderJob | null>(initial ?? null)
  const settled = useRef(false)

  useEffect(() => {
    settled.current = false
    if (!jobId) return
    let closed = false
    let poll: number | undefined
    let source: EventSource | null = null

    const apply = (next: RenderJob) => {
      if (closed) return
      setJob(next)
      if (isTerminalJobStatus(next.status)) {
        settled.current = true
        source?.close()
        window.clearInterval(poll)
      }
    }
    const startPolling = () => {
      if (poll !== undefined || settled.current) return
      poll = window.setInterval(() => {
        getRenderJob(jobId).then(apply, () => undefined)
      }, 1500)
    }

    if (initial && initial.id === jobId && isTerminalJobStatus(initial.status)) {
      settled.current = true
      return
    }
    if (typeof EventSource === 'undefined') {
      startPolling()
    } else {
      source = new EventSource(renderJobStreamPath(jobId), { withCredentials: true })
      source.addEventListener('job', (e) => {
        const parsed = renderJobSchema.safeParse(JSON.parse((e as MessageEvent<string>).data))
        if (parsed.success) apply(parsed.data)
      })
      source.onerror = () => {
        source?.close()
        startPolling()
      }
    }
    return () => {
      closed = true
      source?.close()
      window.clearInterval(poll)
    }
    // `initial` only seeds the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  const cancel = useCallback(async () => {
    if (jobId) setJob(await cancelRenderJob(jobId))
  }, [jobId])

  return { job, cancel }
}
