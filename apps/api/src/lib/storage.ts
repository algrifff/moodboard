import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), '../../data')
export const DATA_DIR = process.env.DATA_DIR ?? DEFAULT_DATA_DIR
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
export const PDF_DIR = path.join(DATA_DIR, 'pdfs')
export const PDF_THUMB_DIR = path.join(DATA_DIR, 'pdf-thumbs')
// Phase 12+: proxied thumbnails / icons from external providers. Drive
// thumbnails are signed and expire ~hourly, so we have to serve through
// our own origin. Notion icons are stable public URLs and we render them
// inline on the client without proxying. The provider segment is part of
// the on-disk layout so phase 13 doesn't need to invent another constant.
export const EXTERNAL_DIR = path.join(DATA_DIR, 'external')
export const EXTERNAL_NOTION_DIR = path.join(EXTERNAL_DIR, 'notion')
export const EXTERNAL_DRIVE_DIR = path.join(EXTERNAL_DIR, 'drive')

export async function ensureDataDirs(): Promise<void> {
  await mkdir(UPLOADS_DIR, { recursive: true })
  await mkdir(PDF_DIR, { recursive: true })
  await mkdir(PDF_THUMB_DIR, { recursive: true })
  await mkdir(EXTERNAL_NOTION_DIR, { recursive: true })
  await mkdir(EXTERNAL_DRIVE_DIR, { recursive: true })
}

// Per-provider on-disk lookup for an external thumbnail/icon. Provider is
// constrained so a hostile filename + crafted provider string can't escape
// the EXTERNAL_DIR tree.
export function externalPath(provider: 'notion' | 'drive', filename: string): string {
  if (provider !== 'notion' && provider !== 'drive') {
    throw new Error(`Unknown external provider: ${provider}`)
  }
  return path.join(EXTERNAL_DIR, provider, filename)
}

export type SavedUpload = {
  id: string
  filename: string
  size: number
  mimeType: string
}

export async function saveUpload(
  buffer: Buffer,
  id: string,
  ext: string,
  mimeType: string,
): Promise<SavedUpload> {
  const filename = `${id}.${ext}`
  const fullPath = path.join(UPLOADS_DIR, filename)
  await writeFile(fullPath, buffer)
  const s = await stat(fullPath)
  return { id, filename, size: s.size, mimeType }
}

export function uploadPath(filename: string): string {
  return path.join(UPLOADS_DIR, filename)
}

export function pdfPath(filename: string): string {
  return path.join(PDF_DIR, filename)
}

export function pdfThumbPath(filename: string): string {
  return path.join(PDF_THUMB_DIR, filename)
}

export function isSafeFilename(name: string): boolean {
  return /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(name)
}

export async function savePdf(
  buffer: Buffer,
  id: string,
): Promise<{ id: string; filename: string; size: number }> {
  const { writeFile, stat } = await import('node:fs/promises')
  const filename = `${id}.pdf`
  const fullPath = pdfPath(filename)
  await writeFile(fullPath, buffer)
  const s = await stat(fullPath)
  return { id, filename, size: s.size }
}

export async function savePdfThumbnail(buffer: Buffer, id: string): Promise<{ filename: string }> {
  const { writeFile } = await import('node:fs/promises')
  const filename = `${id}.png`
  await writeFile(pdfThumbPath(filename), buffer)
  return { filename }
}
