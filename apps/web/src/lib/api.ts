import { uploadResponseSchema, type UploadResponse } from '@moodboard/shared'

export async function uploadFile(blob: Blob, filename = 'paste'): Promise<UploadResponse> {
  const fd = new FormData()
  fd.append('file', blob, filename)
  const res = await fetch('/api/upload', { method: 'POST', body: fd })
  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText)
    throw new Error(`Upload failed: ${message}`)
  }
  return uploadResponseSchema.parse(await res.json())
}

export async function proxyUrl(url: string): Promise<UploadResponse> {
  const res = await fetch(`/api/proxy?url=${encodeURIComponent(url)}`)
  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText)
    throw new Error(`Proxy failed: ${message}`)
  }
  return uploadResponseSchema.parse(await res.json())
}
