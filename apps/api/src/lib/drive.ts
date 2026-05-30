// Google Drive REST API wrapper + per-mime extraction.
//
// Same shape as apps/api/src/lib/notion.ts — no SDK, just fetch with the
// surface narrowed to what the picker + import flow actually needs:
//
//   GET  /drive/v3/files?q=...            — picker tile search
//   GET  /drive/v3/files/{id}             — file metadata
//   GET  /drive/v3/files?q='{id}' in parents — folder children
//   GET  /drive/v3/files/{id}/export      — Google-native export (Doc/Sheet/Slides)
//   GET  /drive/v3/files/{id}?alt=media   — binary download (PDF/image)
//   POST https://oauth2.googleapis.com/token — refresh token grant
//   POST https://oauth2.googleapis.com/token — auth code exchange
//
// Google access tokens expire ~1h and Drive requires a fresh one. The
// `getValidToken` helper checks expiresAt on the connection row, refreshes
// via the saved refresh token if stale, re-encrypts, and persists. Callers
// pass a Connection-like row in; we mutate-on-disk and return the live token.

import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { decryptToken, encryptToken } from './cryptoTokens'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'

// Google-native mime types — the ones that need /export instead of /alt=media.
export const MIME_DOC = 'application/vnd.google-apps.document'
export const MIME_SHEET = 'application/vnd.google-apps.spreadsheet'
export const MIME_SLIDES = 'application/vnd.google-apps.presentation'
export const MIME_FOLDER = 'application/vnd.google-apps.folder'
export const MIME_PDF = 'application/pdf'

// Excerpt caps — keep prompts bounded. Same magnitude as the Notion + PDF
// caps already in analyze.ts.
const EXCERPT_MAX = 4000

// Number of children fetched + previewed in folder data. The full live tree
// is walked on demand via the picker /children endpoint.
const FOLDER_PREVIEW_CAP = 30

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriveFileSummary = {
  id: string
  name: string
  mimeType: string
  iconUrl?: string
  webViewLink: string
  modifiedTime?: string
  parents?: string[]
}

export type DriveExtractedFile =
  | { kind: 'doc' | 'sheet' | 'slides' | 'other'; excerpt: string; summary: DriveFileSummary }
  | { kind: 'pdf'; bytes: Buffer; summary: DriveFileSummary }
  | { kind: 'image'; bytes: Buffer; ext: string; summary: DriveFileSummary }

export type GoogleTokenResponse = {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  scope?: string
  email?: string
}

class DriveApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'DriveApiError'
  }
}

export { DriveApiError }

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

async function driveFetch<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; token: string },
): Promise<T> {
  const res = await fetch(`${DRIVE_API}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${init.token}` },
  })
  if (!res.ok) {
    let message = res.statusText
    let code: string | undefined
    try {
      const errBody = (await res.json()) as {
        error?: { code?: number | string; message?: string; status?: string }
      }
      if (errBody.error?.message) message = errBody.error.message
      if (errBody.error?.status) code = errBody.error.status
    } catch {
      // Body wasn't JSON — keep statusText
    }
    throw new DriveApiError(res.status, code, message)
  }
  return (await res.json()) as T
}

async function driveFetchBytes(path: string, token: string): Promise<Buffer> {
  const res = await fetch(`${DRIVE_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new DriveApiError(res.status, undefined, res.statusText)
  }
  return Buffer.from(await res.arrayBuffer())
}

// Plain-text export from Drive's /export endpoint. Used for Docs/Sheets/Slides.
async function driveFetchExportText(
  fileId: string,
  mimeType: 'text/plain' | 'text/csv',
  token: string,
): Promise<string> {
  const url = `${DRIVE_API}/files/${fileId}/export?mimeType=${encodeURIComponent(mimeType)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    throw new DriveApiError(res.status, undefined, res.statusText)
  }
  return await res.text()
}

// ---------------------------------------------------------------------------
// OAuth — code exchange + refresh
// ---------------------------------------------------------------------------

/** Exchange an auth code for tokens. Sets up a fresh connection row. */
export async function exchangeCode(args: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
}): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  })
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new DriveApiError(res.status, undefined, `OAuth exchange failed: ${body}`)
  }
  const raw = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    id_token?: string
  }
  const email = raw.id_token ? extractEmailFromIdToken(raw.id_token) : undefined
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresIn: raw.expires_in,
    scope: raw.scope,
    email,
  }
}

/** Pull the email claim from a JWT id_token without verifying the signature.
 *  We trust the id_token because it came back over TLS from a known
 *  endpoint we authenticated to. No security decision rests on the value;
 *  it's only used to label the connection card. */
function extractEmailFromIdToken(jwt: string): string | undefined {
  const parts = jwt.split('.')
  const payloadB64 = parts[1]
  if (!payloadB64) return undefined
  try {
    const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4)
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    )
    const obj = JSON.parse(json) as { email?: string }
    return obj.email
  } catch {
    return undefined
  }
}

/**
 * Decrypt + (if stale) refresh the connection's access token. Updates the
 * connection row when a refresh happens so subsequent calls don't re-refresh.
 * Returns a token good for at least the next minute.
 */
export async function getValidToken(connectionRow: {
  id: string
  accessTokenEnc: string
  refreshTokenEnc: string | null
  expiresAt: Date | null
}): Promise<string> {
  const access = decryptToken(connectionRow.accessTokenEnc)
  const now = Date.now()
  const fudgeMs = 60_000 // refresh if expiring within a minute
  if (!connectionRow.expiresAt || connectionRow.expiresAt.getTime() - fudgeMs > now) {
    return access
  }
  if (!connectionRow.refreshTokenEnc) {
    // No refresh token — caller will get a 401 from Google and surface as
    // "connection unavailable" upstream.
    return access
  }
  const refresh = decryptToken(connectionRow.refreshTokenEnc)
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new DriveApiError(500, 'GOOGLE_ENV_MISSING', 'Google OAuth env vars not configured')
  }
  const params = new URLSearchParams({
    refresh_token: refresh,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  })
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new DriveApiError(res.status, undefined, `Refresh failed: ${body}`)
  }
  const raw = (await res.json()) as { access_token: string; expires_in?: number }
  const expiresAt = raw.expires_in ? new Date(now + raw.expires_in * 1000) : null
  await db
    .update(schema.connection)
    .set({
      accessTokenEnc: encryptToken(raw.access_token),
      expiresAt,
      lastUsedAt: new Date(),
    })
    .where(eq(schema.connection.id, connectionRow.id))
  return raw.access_token
}

// ---------------------------------------------------------------------------
// Read — search, get, list children
// ---------------------------------------------------------------------------

const SEARCH_FIELDS =
  'files(id,name,mimeType,iconLink,webViewLink,modifiedTime,parents),nextPageToken'

/**
 * Picker search. Filters out trashed files; sorts by recent activity. The
 * query is wrapped in `name contains '...'` if present; an empty query just
 * returns the most recently modified files the user has access to.
 */
export async function searchFiles(args: {
  token: string
  query?: string
  pageToken?: string
  pageSize?: number
}): Promise<{ files: DriveFileSummary[]; nextPageToken?: string }> {
  const parts: string[] = ['trashed=false']
  if (args.query && args.query.trim()) {
    // Escape single quotes in the query so they don't break the q expression.
    const safe = args.query.replace(/'/g, "\\'")
    parts.push(`name contains '${safe}'`)
  }
  const q = encodeURIComponent(parts.join(' and '))
  const sz = args.pageSize ?? 25
  const tokenParam = args.pageToken ? `&pageToken=${encodeURIComponent(args.pageToken)}` : ''
  const url = `/files?q=${q}&pageSize=${sz}&fields=${encodeURIComponent(
    SEARCH_FIELDS,
  )}&orderBy=modifiedTime%20desc${tokenParam}`
  const raw = await driveFetch<{
    files: Array<{
      id: string
      name: string
      mimeType: string
      iconLink?: string
      webViewLink: string
      modifiedTime?: string
      parents?: string[]
    }>
    nextPageToken?: string
  }>(url, { token: args.token })
  return {
    files: raw.files.map(projectFileSummary),
    nextPageToken: raw.nextPageToken,
  }
}

/** Get a single file's metadata. */
export async function getFile(args: { token: string; fileId: string }): Promise<DriveFileSummary> {
  const fields = encodeURIComponent('id,name,mimeType,iconLink,webViewLink,modifiedTime,parents')
  const raw = await driveFetch<{
    id: string
    name: string
    mimeType: string
    iconLink?: string
    webViewLink: string
    modifiedTime?: string
    parents?: string[]
  }>(`/files/${args.fileId}?fields=${fields}`, { token: args.token })
  return projectFileSummary(raw)
}

/** List direct children of a folder. */
export async function listFolderChildren(args: {
  token: string
  folderId: string
  pageSize?: number
}): Promise<DriveFileSummary[]> {
  const q = encodeURIComponent(`'${args.folderId}' in parents and trashed=false`)
  const sz = args.pageSize ?? 100
  const url = `/files?q=${q}&pageSize=${sz}&fields=${encodeURIComponent(
    SEARCH_FIELDS,
  )}&orderBy=folder,name`
  const raw = await driveFetch<{
    files: Array<{
      id: string
      name: string
      mimeType: string
      iconLink?: string
      webViewLink: string
      modifiedTime?: string
      parents?: string[]
    }>
  }>(url, { token: args.token })
  return raw.files.map(projectFileSummary)
}

function projectFileSummary(raw: {
  id: string
  name: string
  mimeType: string
  iconLink?: string
  webViewLink: string
  modifiedTime?: string
  parents?: string[]
}): DriveFileSummary {
  const s: DriveFileSummary = {
    id: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    webViewLink: raw.webViewLink,
  }
  if (raw.iconLink) s.iconUrl = raw.iconLink
  if (raw.modifiedTime) s.modifiedTime = raw.modifiedTime
  if (raw.parents) s.parents = raw.parents
  return s
}

// ---------------------------------------------------------------------------
// Extraction — per-mime dispatch.
// ---------------------------------------------------------------------------

/**
 * Fetch the file's content in whatever form the importer needs. Routes by
 * mime type. PDFs + images come back as raw bytes for the caller to save +
 * mount as PDFNode / ImageNode. Native Google types come back as text
 * excerpts for the DriveNode + AD prompt.
 */
export async function extractFile(args: {
  token: string
  fileId: string
}): Promise<DriveExtractedFile> {
  const summary = await getFile({ token: args.token, fileId: args.fileId })

  if (summary.mimeType === MIME_DOC) {
    const text = await driveFetchExportText(args.fileId, 'text/plain', args.token)
    return { kind: 'doc', summary, excerpt: truncate(text, EXCERPT_MAX) }
  }
  if (summary.mimeType === MIME_SHEET) {
    // CSV export = first sheet only, which is plenty for the AD's read.
    const csv = await driveFetchExportText(args.fileId, 'text/csv', args.token)
    return { kind: 'sheet', summary, excerpt: truncate(csv, EXCERPT_MAX) }
  }
  if (summary.mimeType === MIME_SLIDES) {
    // Slides exports to text/plain — gives slide titles + bodies + speaker notes.
    const text = await driveFetchExportText(args.fileId, 'text/plain', args.token)
    return { kind: 'slides', summary, excerpt: truncate(text, EXCERPT_MAX) }
  }
  if (summary.mimeType === MIME_PDF) {
    const bytes = await driveFetchBytes(`/files/${args.fileId}?alt=media`, args.token)
    return { kind: 'pdf', summary, bytes }
  }
  if (summary.mimeType.startsWith('image/')) {
    const ext = summary.mimeType.split('/')[1] ?? 'png'
    const bytes = await driveFetchBytes(`/files/${args.fileId}?alt=media`, args.token)
    return { kind: 'image', summary, bytes, ext }
  }
  // Anything else (Markdown files, plain text, mp4, etc.) — we don't have a
  // tailored extractor; pass file metadata through with a no-preview note.
  return {
    kind: 'other',
    summary,
    excerpt: `${summary.name}\n(${summary.mimeType} — no preview available)`,
  }
}

/**
 * Walk a folder and return both the child count and a capped preview list.
 * Folders skip extraction; we use this to render the card chips.
 */
export async function extractFolder(args: { token: string; folderId: string }): Promise<{
  summary: DriveFileSummary
  childCount: number
  childPreview: { name: string; mimeType: string }[]
}> {
  const summary = await getFile({ token: args.token, fileId: args.folderId })
  const children = await listFolderChildren({ token: args.token, folderId: args.folderId })
  const childPreview = children
    .slice(0, FOLDER_PREVIEW_CAP)
    .map((c) => ({ name: c.name, mimeType: c.mimeType }))
  return { summary, childCount: children.length, childPreview }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}
