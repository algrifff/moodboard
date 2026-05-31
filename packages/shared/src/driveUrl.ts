// Google Drive URL recogniser. Drive surfaces files through three host
// patterns:
//
//   https://docs.google.com/document/d/{id}/edit?usp=share_link
//   https://docs.google.com/spreadsheets/d/{id}/edit?gid=...
//   https://docs.google.com/presentation/d/{id}/edit#slide=id.p
//   https://drive.google.com/file/d/{id}/view?usp=sharing      (uploads, PDFs, images)
//   https://drive.google.com/drive/folders/{id}                (folders)
//   https://drive.google.com/drive/u/0/folders/{id}            (account-scoped folders)
//   https://drive.google.com/open?id={id}                       (legacy)
//
// The id is always either:
//   - 33+ chars [A-Za-z0-9_-] (recent Drive files)
//   - the legacy 25-char form
//
// We tolerate either. Returns null when the URL doesn't look like a Drive
// resource a connected user could open with our drive.readonly scope.

const DRIVE_HOST_RE = /^(drive|docs)\.google\.com$/i

// Matches a Drive resource id in any of the path positions above. The
// minimum length of 25 was Drive's legacy id length; modern ids are 33+ but
// we keep the looser floor for forwards compatibility.
const ID_RE = /[A-Za-z0-9_-]{25,}/

/**
 * Pull a Drive file or folder id out of a URL string. Returns null if the
 * URL isn't a recognised Drive surface or no id is present.
 */
export function extractDriveFileId(input: string): string | null {
  const url = parseUrl(input)
  if (!url) return null
  if (!DRIVE_HOST_RE.test(url.hostname)) return null

  // Path-form matches (covers /d/{id} for docs, /file/d/{id}, /folders/{id}).
  const path = url.pathname
  const pathMatches: RegExp[] = [
    /\/(?:document|spreadsheets|presentation|file|forms)\/d\/([A-Za-z0-9_-]{25,})/i,
    /\/drive(?:\/u\/\d+)?\/folders\/([A-Za-z0-9_-]{25,})/i,
  ]
  for (const re of pathMatches) {
    const m = path.match(re)
    if (m?.[1]) return m[1]
  }

  // Legacy /open?id={id}.
  const idParam = url.searchParams.get('id')
  if (idParam && ID_RE.test(idParam)) return idParam

  return null
}

function parseUrl(s: string): URL | null {
  try {
    return new URL(s.trim())
  } catch {
    return null
  }
}
