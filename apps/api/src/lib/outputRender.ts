import { parseVideoDoc, viewportSize } from '@moodboard/shared'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { composeDoc, getOutputSummary, outputRenderDoc } from './outputs'
import { renderFrame, type Frame, type FrameTime } from './renderFrame'
import { OUTPUTS_DIR } from './storage'

// Output frames: the composed document (the same bytes the preview, share
// and download serve) through the frame renderer. A version is immutable —
// html, css, slot values and the pinned kit version — so its end-state
// frame is cached on the volume as the output's thumbnail.

// Long edge of a stored frame. Native for a 1280×720 thumbnail; a 16:9 deck
// comes out at 1280×720 too, which is also comfortably inside what a vision
// model reads without downscaling.
export const FRAME_MAX_EDGE = 1280

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

function thumbnailFile(outputId: string, version: number): string {
  return path.join(OUTPUTS_DIR, `${outputId}@v${version}.png`)
}

export type OutputFrame = Frame & {
  version: number
  missingAssets: string[]
  viewport: { width: number; height: number }
}

export async function renderOutputFrame(
  outputId: string,
  opts: { version?: number; section?: number; time?: FrameTime } = {},
): Promise<OutputFrame | null> {
  if (!SAFE_ID.test(outputId)) return null
  const summary = await getOutputSummary(outputId)
  if (!summary) return null
  const version = opts.version ?? summary.latestVersion
  const doc = await outputRenderDoc(outputId, version)
  if (!doc) return null
  const composed = await composeDoc(doc)
  const viewport = viewportSize(doc.viewport)
  // A video's still is its poster moment, not t=0 (blank) or the end card.
  const video = parseVideoDoc(doc.html)
  const defaultTime: FrameTime = video ? video.posterMs : 'end'
  const time = opts.time ?? defaultTime
  const frame = await renderFrame(composed.html, {
    viewport,
    section: opts.section,
    time,
    maxEdge: FRAME_MAX_EDGE,
  })
  // The default frame (end state, or a video's poster; first screen) is the
  // thumbnail.
  if (opts.section === undefined && time === defaultTime) {
    await mkdir(OUTPUTS_DIR, { recursive: true })
    await writeFile(thumbnailFile(outputId, version), frame.png)
  }
  return { ...frame, version, missingAssets: composed.missingAssets, viewport }
}

export async function outputThumbnail(
  outputId: string,
  version?: number,
): Promise<{ png: Buffer; version: number } | null> {
  if (!SAFE_ID.test(outputId)) return null
  let v = version
  if (v === undefined) {
    const summary = await getOutputSummary(outputId)
    if (!summary) return null
    v = summary.latestVersion
  }
  const cached = await readFile(thumbnailFile(outputId, v)).catch(() => null)
  if (cached) return { png: cached, version: v }
  const frame = await renderOutputFrame(outputId, { version: v })
  return frame ? { png: frame.png, version: v } : null
}

export async function removeOutputFrames(outputId: string): Promise<void> {
  if (!SAFE_ID.test(outputId)) return
  const names = await readdir(OUTPUTS_DIR).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((n) => n.startsWith(`${outputId}@v`))
      .map((n) => rm(path.join(OUTPUTS_DIR, n), { force: true })),
  )
}
