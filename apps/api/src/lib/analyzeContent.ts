import type {
  CanvasObject,
  DriveFileData,
  DriveFolderData,
  FontData,
  ImageData,
  PDFData,
  SpotifyAlbumData,
  SpotifyPlaylistData,
  SpotifyTrackData,
  StickyData,
  TextData,
  VideoClipData,
  VoiceNoteData,
  FigmaFrameData,
  OutputCardData,
  WebPageData,
} from '@moodboard/shared'
import { readFile } from 'node:fs/promises'
import {
  driveKindLabel,
  formatSpotifyAlbum,
  formatSpotifyPlaylist,
  formatSpotifyTrack,
  formatVideoClip,
  formatVideoDuration,
} from './analyzeFormatters'
import { isSafeFilename, pdfThumbPath, uploadPath } from './storage'
import { mimeFromExt } from './upload-validation'

function isImageData(d: CanvasObject['data']): d is ImageData {
  return 'url' in d && typeof (d as ImageData).url === 'string'
}
function isStickyData(d: CanvasObject['data']): d is StickyData {
  return 'color' in d && typeof (d as StickyData).color === 'string'
}
function isTextData(d: CanvasObject['data']): d is TextData {
  return 'font' in d && typeof (d as TextData).font === 'string' && 'fontSize' in d
}
function isPdfData(d: CanvasObject['data']): d is PDFData {
  return (
    'extractedText' in d && 'thumbnailUrl' in d && typeof (d as PDFData).thumbnailUrl === 'string'
  )
}
function isFontData(d: CanvasObject['data']): d is FontData {
  return 'family' in d && typeof (d as FontData).family === 'string'
}
function isDriveFileData(d: CanvasObject['data']): d is DriveFileData {
  return (
    'fileId' in d &&
    typeof (d as DriveFileData).fileId === 'string' &&
    'mimeType' in d &&
    typeof (d as DriveFileData).mimeType === 'string'
  )
}
function isDriveFolderData(d: CanvasObject['data']): d is DriveFolderData {
  return (
    'folderId' in d && typeof (d as DriveFolderData).folderId === 'string' && 'childPreview' in d
  )
}
function isWebPageData(d: CanvasObject['data']): d is WebPageData {
  return (
    'readableText' in d &&
    typeof (d as WebPageData).readableText === 'string' &&
    'host' in d &&
    typeof (d as WebPageData).host === 'string'
  )
}
function isSpotifyPlaylistData(d: CanvasObject['data']): d is SpotifyPlaylistData {
  return (
    'playlistId' in d &&
    typeof (d as SpotifyPlaylistData).playlistId === 'string' &&
    'snapshotId' in d
  )
}
function isSpotifyTrackData(d: CanvasObject['data']): d is SpotifyTrackData {
  return 'trackId' in d && typeof (d as SpotifyTrackData).trackId === 'string' && 'albumName' in d
}
function isSpotifyAlbumData(d: CanvasObject['data']): d is SpotifyAlbumData {
  return 'albumId' in d && typeof (d as SpotifyAlbumData).albumId === 'string' && 'releaseDate' in d
}
function isVideoClipData(d: CanvasObject['data']): d is VideoClipData {
  return 'videoId' in d && typeof (d as VideoClipData).videoId === 'string' && 'platform' in d
}
function isVoiceNoteData(d: CanvasObject['data']): d is VoiceNoteData {
  return (
    'transcript' in d &&
    typeof (d as VoiceNoteData).transcript === 'string' &&
    'durationSec' in d &&
    typeof (d as VoiceNoteData).durationSec === 'number' &&
    'mimeType' in d &&
    typeof (d as VoiceNoteData).mimeType === 'string'
  )
}

function urlToFilename(url: string): string | null {
  const m = url.match(/^\/api\/files\/([^/]+)$/)
  return m && m[1] ? m[1] : null
}

const MAX_BYTES_PER_IMAGE = 4 * 1024 * 1024

type ImageBlock = {
  type: 'image'
  source: {
    type: 'base64'
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    data: string
  }
}

async function loadImageBlock(url: string): Promise<ImageBlock | null> {
  const filename = urlToFilename(url)
  if (!filename || !isSafeFilename(filename)) return null
  let buffer: Buffer
  try {
    buffer = await readFile(uploadPath(filename))
  } catch {
    return null
  }
  if (buffer.byteLength > MAX_BYTES_PER_IMAGE) {
    console.warn(
      `analyze: skipping ${filename} (${buffer.byteLength} bytes > ${MAX_BYTES_PER_IMAGE})`,
    )
    return null
  }
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const mime = mimeFromExt(ext)
  if (
    mime !== 'image/jpeg' &&
    mime !== 'image/png' &&
    mime !== 'image/gif' &&
    mime !== 'image/webp'
  ) {
    return null
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: mime, data: buffer.toString('base64') },
  }
}

async function loadPdfThumbBlock(url: string): Promise<ImageBlock | null> {
  const filename = urlToFilename(url)
  if (!filename || !isSafeFilename(filename)) return null
  let buffer: Buffer
  try {
    buffer = await readFile(pdfThumbPath(filename))
  } catch {
    return null
  }
  if (buffer.byteLength > MAX_BYTES_PER_IMAGE) return null
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64') },
  }
}

type ContentBlock = ImageBlock | { type: 'text'; text: string }

/** Build the multi-modal content array for a group — agent-agnostic. */
export async function buildGroupContent(objects: CanvasObject[]): Promise<ContentBlock[]> {
  const content: ContentBlock[] = []

  // Collect font specimens up front so we can emit them as their own
  // dedicated block at the top of the message. When they were buried
  // inside the regular text-lines section, the AD often ignored them
  // in favour of typography it inferred from PDF excerpts.
  const fonts: FontData[] = []
  for (const o of objects) {
    if (o.type === 'font' && isFontData(o.data)) fonts.push(o.data)
  }

  let imageCount = 0
  let pdfCount = 0
  for (const o of objects) {
    if (o.type === 'image' && isImageData(o.data)) {
      const block = await loadImageBlock(o.data.url)
      if (block) {
        // Label the image with its URL so the AD can write the URL back
        // when identifying a logo. Without this, agents have no stable
        // identifier to refer to images.
        content.push({ type: 'text', text: `Image URL: ${o.data.url}` })
        content.push(block)
        imageCount += 1
      }
    } else if (o.type === 'figma-frame') {
      const d = o.data as FigmaFrameData
      const block = await loadImageBlock(d.url)
      if (block) {
        content.push({
          type: 'text',
          text: `Figma frame “${d.name}” from the file “${d.fileName}” — image URL: ${d.url}`,
        })
        content.push(block)
        imageCount += 1
      }
    } else if (o.type === 'pdf' && isPdfData(o.data)) {
      const block = await loadPdfThumbBlock(o.data.thumbnailUrl)
      if (block) {
        content.push({ type: 'text', text: `PDF thumbnail URL: ${o.data.thumbnailUrl}` })
        content.push(block)
        pdfCount += 1
      }
    }
  }

  const textLines: string[] = []
  const pdfExcerpts: string[] = []
  const driveExcerpts: string[] = []
  const driveFolderLines: string[] = []
  const webExcerpts: string[] = []
  const spotifyBlocks: string[] = []
  const videoBlocks: string[] = []
  const voiceNoteBlocks: string[] = []
  // Per-source excerpt cap — keeps the prompt bounded when several land in
  // the same group. Whole-document analysis isn't the job; setting the tone
  // is. PDF / Drive / Web all share the same cap.
  const PDF_EXCERPT_MAX = 4000
  const DRIVE_EXCERPT_MAX = 4000
  const WEB_EXCERPT_MAX = 4000
  let stickyCount = 0
  let textCount = 0
  let driveFileCount = 0
  let driveFolderCount = 0
  let webPageCount = 0
  let spotifyPlaylistCount = 0
  let spotifyTrackCount = 0
  let spotifyAlbumCount = 0
  let videoCount = 0
  let voiceNoteCount = 0
  for (const o of objects) {
    if (o.type === 'sticky' && isStickyData(o.data)) {
      stickyCount += 1
      const t = o.data.text.trim() || '(empty)'
      textLines.push(`- Sticky note (color ${o.data.color}): "${t}"`)
    } else if (o.type === 'text' && isTextData(o.data)) {
      textCount += 1
      const t = o.data.text.trim() || '(empty)'
      // Surface the user-chosen font + size — this is ground truth for the
      // AD's `fonts` field. Without it the AD would have to guess from
      // image evidence alone.
      textLines.push(
        `- Text label: "${t}" [font: ${o.data.font}, size: ${Math.round(o.data.fontSize)}px]`,
      )
    } else if (o.type === 'pdf' && isPdfData(o.data)) {
      const raw = o.data.extractedText.trim()
      if (raw) {
        const excerpt = raw.length > PDF_EXCERPT_MAX ? `${raw.slice(0, PDF_EXCERPT_MAX)}…` : raw
        pdfExcerpts.push(`--- PDF excerpt ---\n${excerpt}\n--- end PDF ---`)
      }
    } else if (o.type === 'drive-file' && isDriveFileData(o.data)) {
      driveFileCount += 1
      const raw = o.data.excerpt.trim()
      if (raw) {
        const excerpt = raw.length > DRIVE_EXCERPT_MAX ? `${raw.slice(0, DRIVE_EXCERPT_MAX)}…` : raw
        const label = driveKindLabel(o.data.mimeType)
        const editedAt = o.data.modifiedTime ?? 'unknown'
        driveExcerpts.push(
          `--- Drive ${label}: "${o.data.name}" (modified ${editedAt}) ---\n${excerpt}\n--- end Drive ${label} ---`,
        )
      }
    } else if (o.type === 'drive-folder' && isDriveFolderData(o.data)) {
      driveFolderCount += 1
      // Folders carry context, not content — the AD treats them as
      // structural hints ("a folder called 'Brand Assets' containing
      // logos and photos sits here"). Capped at the preview list.
      const items =
        o.data.childPreview.length === 0
          ? '(no items)'
          : o.data.childPreview.map((c) => `${c.name} (${c.mimeType})`).join(', ')
      driveFolderLines.push(
        `- Drive folder: "${o.data.name}" (${o.data.childCount} items) — ${items}`,
      )
    } else if (o.type === 'web-page' && isWebPageData(o.data)) {
      webPageCount += 1
      const raw = o.data.readableText.trim()
      const head = [`Web page: "${o.data.title}" — ${o.data.url}`]
      if (o.data.description) head.push(`Description: ${o.data.description}`)
      if (o.data.colours.length > 0) {
        const hexList = o.data.colours.map((c) => c.hex).join(', ')
        head.push(`Brand palette sampled from the page: ${hexList}`)
      }
      if (o.data.fonts.length > 0) {
        const fontList = o.data.fonts.map((f) => `${f.family} (${f.role})`).join(', ')
        head.push(`Typography in use on the page: ${fontList}`)
      }
      const body = raw
        ? raw.length > WEB_EXCERPT_MAX
          ? `${raw.slice(0, WEB_EXCERPT_MAX)}…`
          : raw
        : '(no readable body text — work from the title, description, palette, and fonts above)'
      webExcerpts.push(`--- ${head.join('\n')} ---\n${body}\n--- end web page ---`)
    } else if (o.type === 'spotify-playlist' && isSpotifyPlaylistData(o.data)) {
      spotifyPlaylistCount += 1
      spotifyBlocks.push(formatSpotifyPlaylist(o.data))
    } else if (o.type === 'spotify-track' && isSpotifyTrackData(o.data)) {
      spotifyTrackCount += 1
      spotifyBlocks.push(formatSpotifyTrack(o.data))
    } else if (o.type === 'spotify-album' && isSpotifyAlbumData(o.data)) {
      spotifyAlbumCount += 1
      spotifyBlocks.push(formatSpotifyAlbum(o.data))
    } else if (o.type === 'video-clip' && isVideoClipData(o.data)) {
      videoCount += 1
      videoBlocks.push(formatVideoClip(o.data))
    } else if (o.type === 'output') {
      const d = o.data as OutputCardData
      textLines.push(`- Design output (${d.format}): "${d.name}"`)
    } else if (o.type === 'figma-frame') {
      const d = o.data as FigmaFrameData
      textLines.push(`- Figma frame (${d.width}×${d.height}): "${d.name}" from "${d.fileName}"`)
    } else if (o.type === 'voice-note' && isVoiceNoteData(o.data)) {
      voiceNoteCount += 1
      // Voice notes get a dedicated block (below) rather than mixing
      // into the generic text-content section. The transcript is the
      // user speaking directly — load-bearing intent — and deserves
      // its own preamble so agents don't read it as just another
      // sticky. Empty transcripts (Gemini failed, recording silent,
      // or page-reload-mid-transcribe) still produce a placeholder
      // so the agent knows a voice note is present.
      const raw = o.data.transcript.trim()
      const body = raw || '(no transcript captured)'
      voiceNoteBlocks.push(
        `--- Voice note (${formatVideoDuration(o.data.durationSec)}) ---\n${body}\n--- end voice note ---`,
      )
    }
  }

  // BRAND FONTS — emitted before any other text content. This is the
  // highest-trust signal for the AD's `fonts` field: the user
  // physically uploaded a font file and dropped it on the moodboard.
  // PDFs and photography are secondary; uploaded fonts dictate.
  if (fonts.length > 0) {
    const lines = fonts
      .map((f, i) => {
        const fmt = f.url.endsWith('.woff2')
          ? 'woff2'
          : f.url.endsWith('.woff')
            ? 'woff'
            : f.url.endsWith('.otf')
              ? 'otf'
              : 'ttf'
        return `  ${i + 1}. "${f.family}" (uploaded ${fmt})`
      })
      .join('\n')
    content.push({
      type: 'text',
      text:
        '=== BRAND FONTS — UPLOADED BY THE USER ===\n' +
        "The user has uploaded the following typeface file(s) and placed them on the moodboard. These are the brand's deliberately-chosen typefaces. Each of these MUST appear as an entry in your `fonts` output field, with `name` copied verbatim. Do not skip an uploaded font in favour of typography you inferred from a PDF excerpt or an image — uploaded fonts override every other source.\n\n" +
        lines +
        '\n=== END BRAND FONTS ===',
    })
  }

  const header = [
    `Group: ${imageCount} image(s), ${pdfCount} PDF(s), ${stickyCount} sticky note(s), ${textCount} text label(s), ${fonts.length} uploaded font(s), ${driveFileCount} Drive file(s), ${driveFolderCount} Drive folder(s), ${webPageCount} web page(s), ${spotifyPlaylistCount} Spotify playlist(s), ${spotifyTrackCount} Spotify track(s), ${spotifyAlbumCount} Spotify album(s), ${videoCount} video clip(s), ${voiceNoteCount} voice note(s).`,
    textLines.length > 0
      ? '\nText content:'
      : pdfExcerpts.length > 0 ||
          driveExcerpts.length > 0 ||
          webExcerpts.length > 0 ||
          spotifyBlocks.length > 0 ||
          videoBlocks.length > 0 ||
          voiceNoteBlocks.length > 0
        ? ''
        : '\n(No text content — work purely from the images and sticky colours.)',
    ...textLines,
    ...driveFolderLines,
  ].join('\n')
  content.push({ type: 'text', text: header })
  if (pdfExcerpts.length > 0) {
    content.push({
      type: 'text',
      text:
        'PDF contents (treat as reference material — read for subject matter, voice, and visual references). PDF layout typography is incidental and does NOT dictate the brand\'s chosen fonts. BUT if a PDF excerpt explicitly names a typeface ("use Helvetica", "set in Akzidenz Grotesk", etc.), treat that name as a deliberate typography reference and count it for the fonts field.\n\n' +
        pdfExcerpts.join('\n\n'),
    })
  }
  if (driveExcerpts.length > 0) {
    // Same register as the PDF block. Drive Docs / Sheets / Slides
    // are first-class content the user pulled onto the board.
    content.push({
      type: 'text',
      text:
        "Google Drive file contents (treat as reference material — read for subject matter, voice, brand strategy, and visual references). Sheet CSV columns + first rows give structural hints; Slides excerpts include slide titles + notes. If a file explicitly names a typeface, treat that as a deliberate typography reference. File layout / mime-specific structure does NOT dictate the brand's fonts.\n\n" +
        driveExcerpts.join('\n\n'),
    })
  }
  if (webExcerpts.length > 0) {
    // Web pages carry brand-strategy signal directly — the user has chosen
    // to pull a homepage / about-page / blog post onto the board, so its
    // copy, declared palette, and rendered typography are all deliberate
    // references. The palette + typography hints in each excerpt's header
    // are sampled from the rendered page — give them real weight when
    // filling out the AD's palette/typographicVoice/fonts fields, even
    // before vision sees the logo images that landed next to the card.
    content.push({
      type: 'text',
      text:
        "Web page contents (treat as primary brand reference — the user pasted this URL onto the board because the brand it points at matters). Read for voice, positioning, audience, and tonal signal. The header of each excerpt lists palette colours and typefaces sampled directly from the rendered page — these are first-class evidence for the brand's chosen palette and fonts, on par with uploaded font files and ahead of PDF-incidental typography.\n\n" +
        webExcerpts.join('\n\n'),
    })
  }
  if (spotifyBlocks.length > 0) {
    // Spotify entries land as a dedicated tonal-signal block. Audio-features
    // map onto qualitative read directly: high valence = upbeat / happy, low
    // = melancholy / serious; high energy = loud / intense, low = calm /
    // introspective; high acousticness = stripped / unplugged, low =
    // produced / electronic. The AD should fold these into mood + tone +
    // adjectives + emotions, and they're orthogonal evidence from the
    // visual signal — neither overrules the other; they triangulate.
    content.push({
      type: 'text',
      text:
        'Spotify references on this board (treat as TONAL signal — the user dropped these because their feel matters to the brief). Each block surfaces aggregate audio-feature numbers; read them like this:\n' +
        '  energy 0..1     — perceptual intensity. >0.7 loud/fast, <0.3 calm/sparse.\n' +
        '  valence 0..1    — musical positivity. >0.7 cheerful/euphoric, <0.3 melancholy/serious.\n' +
        '  danceability    — 0..1, self-explanatory.\n' +
        '  acousticness    — 0..1. >0.7 stripped/unplugged, <0.3 produced/electronic.\n' +
        '  speechiness     — 0..1. >0.66 mostly spoken (podcast / rap).\n' +
        '  tempo (BPM)     — median across tracks.\n' +
        "Read for mood, tone, emotion, era, and audience. Audio features are first-class evidence for the AD's mood / tone / emotions / adjectives fields. They do NOT dictate typography, palette, or visual references — those come from the visual sources.\n\n" +
        spotifyBlocks.join('\n\n'),
    })
  }
  if (videoBlocks.length > 0) {
    // Video clips appear here only as framing (title / channel / platform /
    // duration). The deep read — hooks, transitions, pacing, sound design,
    // dialogue — is produced by the Senior Video Editor agent (Gemini) and
    // reaches the synthesizer through that agent's output, not this block.
    content.push({
      type: 'text',
      text:
        'Video clips on this board (the user pasted these because the content or vibe matters). Treat the title + channel as a topical/voice hint. The detailed video breakdown is handled by the Senior Video Editor agent.\n\n' +
        videoBlocks.join('\n\n'),
    })
  }
  if (voiceNoteBlocks.length > 0) {
    // Voice notes are the user speaking into the moodboard — direct
    // verbal intent for the brand. Transcripts are Gemini-cleaned (ums,
    // false starts, repeats stripped) so the prose reads cleanly while
    // preserving the user's actual word choice, cadence, and emphasis.
    //
    // Weight these as LOAD-BEARING intent — on par with web pages and
    // ahead of stickies — because the user articulated their thinking
    // here rather than just collecting references. Read for:
    //   • intent + positioning (what they're actually trying to build)
    //   • brand voice (the words and sentence shapes they reach for)
    //   • specifics (names, numbers, references they call out by name)
    //   • audience cues (who they describe wanting to reach)
    // Voice notes do NOT dictate typography, palette, or visual
    // references — those come from the visual sources. A voice note that
    // names a typeface ("set in Söhne", "use Helvetica") DOES count as
    // an explicit typography reference for the fonts field.
    content.push({
      type: 'text',
      text:
        "User voice notes — the brand owner thinking out loud about this work. Treat these as direct intent: the brand's voice IS the voice in these recordings. Read for positioning, audience, references, and tone. Match their cadence and vocabulary when writing copy or naming the read.\n\n" +
        voiceNoteBlocks.join('\n\n'),
    })
  }
  content.push({ type: 'text', text: 'Give me the read.' })
  return content
}
