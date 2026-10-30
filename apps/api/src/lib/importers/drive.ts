import type { DriveFileData, DriveFolderData, ImageData, PDFData } from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, schema } from '../../db'
import {
  extractFile as driveExtractFile,
  extractFolder as driveExtractFolder,
  getValidToken,
  MIME_FOLDER,
} from '../drive'
import { processPdf } from '../pdfProcessing'
import { savePdf, savePdfThumbnail, saveUpload } from '../storage'
import { recordAsset } from '../assetLibrary'
import { TokenDecryptError } from './errors'
import { upsertRecent } from './recents'

type DriveImportResult =
  | { kind: 'file'; data: DriveFileData }
  | { kind: 'folder'; data: DriveFolderData }
  | { kind: 'pdf'; data: PDFData }
  | { kind: 'image'; data: ImageData }

/**
 * Import a Drive file by id. Dispatches by mime — Google-native types and
 * arbitrary files come back as DriveFileData; folders as DriveFolderData;
 * PDFs are saved to PDF_DIR + processed for thumbnail/text and come back as
 * PDFData; images are saved to UPLOADS_DIR and come back as ImageData. The
 * client uses `kind` to decide which factory to call.
 */
export async function importDriveFile(args: {
  userId: string
  connectionRow: {
    id: string
    accessTokenEnc: string
    refreshTokenEnc: string | null
    expiresAt: Date | null
  }
  fileId: string
}): Promise<DriveImportResult> {
  let token: string
  try {
    token = await getValidToken(args.connectionRow)
  } catch {
    throw new TokenDecryptError()
  }

  // Probe mime once via the cheap lookup in extractFile / extractFolder. We
  // can't know it ahead of time without a getFile call, but extractFile
  // does that internally.
  // Folders need extractFolder rather than extractFile; we route by hitting
  // a metadata-only call first via extractFile (which dispatches to /export
  // for native types but for folders falls through to 'other' since folders
  // have no exportable content). To avoid the wasted attempt, we do a
  // dedicated getFile here.
  const { getFile: driveGetFile } = await import('../drive')
  const summary = await driveGetFile({ token, fileId: args.fileId })
  const fetchedAt = new Date().toISOString()

  await db
    .update(schema.connection)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.connection.id, args.connectionRow.id))

  if (summary.mimeType === MIME_FOLDER) {
    const folder = await driveExtractFolder({ token, folderId: args.fileId })
    const data: DriveFolderData = {
      connectionId: args.connectionRow.id,
      folderId: folder.summary.id,
      name: folder.summary.name,
      webViewLink: folder.summary.webViewLink,
      childCount: folder.childCount,
      childPreview: folder.childPreview,
      fetchedAt,
    }
    if (folder.summary.modifiedTime) data.modifiedTime = folder.summary.modifiedTime
    await upsertRecent({
      userId: args.userId,
      connectionId: args.connectionRow.id,
      externalId: folder.summary.id,
      kind: 'folder',
      title: folder.summary.name,
      iconUrl: folder.summary.iconUrl,
      mimeType: folder.summary.mimeType,
    })
    return { kind: 'folder', data }
  }

  const extracted = await driveExtractFile({ token, fileId: args.fileId })
  await upsertRecent({
    userId: args.userId,
    connectionId: args.connectionRow.id,
    externalId: extracted.summary.id,
    kind: 'file',
    title: extracted.summary.name,
    iconUrl: extracted.summary.iconUrl,
    mimeType: extracted.summary.mimeType,
  })

  if (extracted.kind === 'pdf') {
    const id = nanoid()
    const savedPdf = await savePdf(extracted.bytes, id)
    await recordAsset(args.userId, savedPdf.filename, 'application/pdf', savedPdf.size, 'pdf', {
      originalName: extracted.summary.name,
    })
    let pdfResult
    try {
      pdfResult = await processPdf(extracted.bytes)
    } catch {
      // PDF processing failed — surface the file anyway with no thumbnail
      // or extracted text. The user can still preview via PDFNode's lazy
      // pdfjs render.
      pdfResult = { text: '', thumbnailPng: null, pageCount: 0 }
    }
    let thumbnailUrl = ''
    if (pdfResult.thumbnailPng) {
      const savedThumb = await savePdfThumbnail(pdfResult.thumbnailPng, id)
      await recordAsset(
        args.userId,
        savedThumb.filename,
        'image/png',
        pdfResult.thumbnailPng.byteLength,
        'pdf-thumb',
      )
      thumbnailUrl = `/api/files/${savedThumb.filename}`
    }
    const data: PDFData = {
      url: `/api/files/${savedPdf.filename}`,
      thumbnailUrl,
      extractedText: pdfResult.text,
    }
    if (pdfResult.pageCount) data.pageCount = pdfResult.pageCount
    return { kind: 'pdf', data }
  }

  if (extracted.kind === 'image') {
    const id = nanoid()
    const saved = await saveUpload(extracted.bytes, id, extracted.ext, extracted.summary.mimeType)
    await recordAsset(args.userId, saved.filename, saved.mimeType, saved.size, 'upload', {
      originalName: extracted.summary.name,
    })
    const data: ImageData = { url: `/api/files/${saved.filename}` }
    return { kind: 'image', data }
  }

  // Doc / Sheet / Slides / other — package as DriveFileData.
  const data: DriveFileData = {
    connectionId: args.connectionRow.id,
    fileId: extracted.summary.id,
    mimeType: extracted.summary.mimeType,
    name: extracted.summary.name,
    webViewLink: extracted.summary.webViewLink,
    excerpt: extracted.excerpt,
    fetchedAt,
  }
  if (extracted.summary.iconUrl) data.iconUrl = extracted.summary.iconUrl
  if (extracted.summary.modifiedTime) data.modifiedTime = extracted.summary.modifiedTime
  return { kind: 'file', data }
}
