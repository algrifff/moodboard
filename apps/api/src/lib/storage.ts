import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), '../../data')
export const DATA_DIR = process.env.DATA_DIR ?? DEFAULT_DATA_DIR
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
export const PDF_DIR = path.join(DATA_DIR, 'pdfs')
export const PDF_THUMB_DIR = path.join(DATA_DIR, 'pdf-thumbs')

export async function ensureDataDirs(): Promise<void> {
  await mkdir(UPLOADS_DIR, { recursive: true })
  await mkdir(PDF_DIR, { recursive: true })
  await mkdir(PDF_THUMB_DIR, { recursive: true })
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
