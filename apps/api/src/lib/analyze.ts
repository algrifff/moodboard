import Anthropic from '@anthropic-ai/sdk'
import type {
  AgentId,
  CanvasObject,
  DriveFileData,
  DriveFolderData,
  FontData,
  ImageData,
  NotionPageData,
  PDFData,
  SpotifyAlbumData,
  SpotifyPlaylistData,
  SpotifyTrackData,
  StickyData,
  TextData,
  VideoClipBreakdown,
  VideoClipData,
  VideoEditorBreakdown,
  VoiceNoteData,
  WebPageData,
} from '@moodboard/shared'
import { readFile } from 'node:fs/promises'
import { getAgent, SYNTHESIZER } from './agents'
import { GEMINI_VIDEO_MODEL } from './gemini'
import { isSafeFilename, pdfThumbPath, uploadPath } from './storage'
import { mimeFromExt } from './upload-validation'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
if (!ANTHROPIC_API_KEY) {
  console.warn('ANTHROPIC_API_KEY not set — /api/boards/:id/analyze will 503')
}

// Sonnet by default — the quality lift over Haiku is worth the 3× cost,
// and the content-hash cache makes repeat reads free.
export const FAST_MODEL = 'claude-haiku-4-5'
export const DEEP_MODEL = 'claude-sonnet-4-6'
export type AnalysisDepth = 'fast' | 'deep'
export const DEFAULT_DEPTH: AnalysisDepth = 'deep'

const client = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null

// System prompts and output schemas live in agents.ts. This module is the
// content builder + Anthropic transport — agent-agnostic.

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
function isNotionPageData(d: CanvasObject['data']): d is NotionPageData {
  return (
    'markdown' in d &&
    typeof (d as NotionPageData).markdown === 'string' &&
    'pageId' in d &&
    typeof (d as NotionPageData).pageId === 'string'
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
async function buildGroupContent(objects: CanvasObject[]): Promise<ContentBlock[]> {
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
  const notionExcerpts: string[] = []
  const driveExcerpts: string[] = []
  const driveFolderLines: string[] = []
  const webExcerpts: string[] = []
  const spotifyBlocks: string[] = []
  const videoBlocks: string[] = []
  const voiceNoteBlocks: string[] = []
  // Per-source excerpt cap — keeps the prompt bounded when several land in
  // the same group. Whole-document analysis isn't the job; setting the tone
  // is. PDF / Notion / Drive / Web all share the same cap.
  const PDF_EXCERPT_MAX = 4000
  const NOTION_EXCERPT_MAX = 4000
  const DRIVE_EXCERPT_MAX = 4000
  const WEB_EXCERPT_MAX = 4000
  let stickyCount = 0
  let textCount = 0
  let notionCount = 0
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
    } else if (o.type === 'notion-page' && isNotionPageData(o.data)) {
      notionCount += 1
      const md = o.data.markdown.trim()
      if (md) {
        const excerpt = md.length > NOTION_EXCERPT_MAX ? `${md.slice(0, NOTION_EXCERPT_MAX)}…` : md
        const title = o.data.title || 'Untitled'
        const editedAt = o.data.lastEditedAt ?? 'unknown'
        notionExcerpts.push(
          `--- Notion page: "${title}" (last edited ${editedAt}) ---\n${excerpt}\n--- end Notion page ---`,
        )
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
    `Group: ${imageCount} image(s), ${pdfCount} PDF(s), ${stickyCount} sticky note(s), ${textCount} text label(s), ${fonts.length} uploaded font(s), ${notionCount} Notion page(s), ${driveFileCount} Drive file(s), ${driveFolderCount} Drive folder(s), ${webPageCount} web page(s), ${spotifyPlaylistCount} Spotify playlist(s), ${spotifyTrackCount} Spotify track(s), ${spotifyAlbumCount} Spotify album(s), ${videoCount} video clip(s), ${voiceNoteCount} voice note(s).`,
    textLines.length > 0
      ? '\nText content:'
      : pdfExcerpts.length > 0 ||
          notionExcerpts.length > 0 ||
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
  if (notionExcerpts.length > 0) {
    // Equal-weight treatment per Phase 12 plan: Notion pages are first-class
    // content the user pulled onto the board. Same register as the PDF block
    // — read for subject matter, voice, and references. Markdown typography
    // (heading hashes, list bullets) is not a typography signal.
    content.push({
      type: 'text',
      text:
        "Notion page contents (treat as reference material — read for subject matter, voice, brand strategy, and visual references). Markdown formatting (heading hashes, list bullets) is structural and does NOT dictate the brand's typography. If a Notion page explicitly names a typeface, treat that name as a deliberate typography reference and count it for the fonts field.\n\n" +
        notionExcerpts.join('\n\n'),
    })
  }
  if (driveExcerpts.length > 0) {
    // Same register as Notion + PDF blocks. Drive Docs / Sheets / Slides
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

// Short label for the Drive excerpt header.
function driveKindLabel(mimeType: string): string {
  if (mimeType === 'application/vnd.google-apps.document') return 'Doc'
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'Sheet'
  if (mimeType === 'application/vnd.google-apps.presentation') return 'Slides'
  return 'file'
}

// Cap how many tracks we list in the prompt. Big playlists already
// contribute via the audio-feature aggregate; listing 200 tracks is
// just token-burn for no extra signal. Twelve is enough that the AD
// can read the playlist's character + era from artist names.
const SPOTIFY_TRACK_DISPLAY_LIMIT = 12

// Format the era block as a one-line summary. "1990s-dominant (mix: 1990s ×8,
// 2000s ×3, 2010s ×1)" reads naturally inside the playlist preamble.
function formatEra(e: SpotifyPlaylistData['era']): string | null {
  if (!e.dominantDecade || e.decadeBreakdown.length === 0) return null
  const mix = e.decadeBreakdown
    .slice(0, 4)
    .map(({ decade, count }) => `${decade} ×${count}`)
    .join(', ')
  const range =
    e.yearMin != null && e.yearMax != null && e.yearMin !== e.yearMax
      ? ` (${e.yearMin}–${e.yearMax})`
      : ''
  return `Era: ${e.dominantDecade}-dominant${range} — mix: ${mix}`
}

// Per-track line includes whatever extra signal we have. Compact (one line)
// to keep the playlist block scannable, but the AD now sees popularity,
// explicit flag, and album release date alongside the artist name.
function trackLine(t: SpotifyPlaylistData['tracks'][number]): string {
  const parts = [`- ${t.name} — ${t.artists.join(', ')}`]
  const meta: string[] = []
  if (t.albumName) meta.push(t.albumName)
  if (t.albumReleaseDate) meta.push(t.albumReleaseDate.slice(0, 4))
  if (typeof t.popularity === 'number') meta.push(`pop ${t.popularity}`)
  if (t.explicit) meta.push('explicit')
  if (t.audioFeatures) {
    const af = t.audioFeatures
    meta.push(`E${af.energy.toFixed(2)}/V${af.valence.toFixed(2)}/${Math.round(af.tempo)}BPM`)
  }
  if (meta.length > 0) parts.push(`[${meta.join(' · ')}]`)
  return parts.join(' ')
}

function formatSpotifyPlaylist(d: SpotifyPlaylistData): string {
  const af = d.audioFeatures
  const head = [`Spotify playlist: "${d.name}" by ${d.ownerName} (${d.trackCount} tracks)`]
  // Description first — this is where the owner literally wrote what the
  // playlist is *for*. It's the highest-signal mood input we have.
  // Strip HTML/entities Spotify allows in playlist descriptions.
  const desc = stripPlaylistHtml(d.description)
  if (desc) head.push(`Owner's description: "${desc}"`)
  // Audio features may be zeroed when Spotify denied the audio-features
  // endpoint (Nov 2024 access lock for newly-registered apps). Suppress
  // the row in that case so the AD doesn't read it as "this playlist has
  // zero energy" — the absence is informational, not a value.
  if (af.trackCount > 0) {
    head.push(
      `Audio-feature aggregate (across ${af.trackCount} tracks): energy ${af.avgEnergy}, valence ${af.avgValence}, danceability ${af.avgDanceability}, acousticness ${af.avgAcousticness}, speechiness ${af.avgSpeechiness}, median tempo ${af.medianTempo} BPM`,
    )
  } else {
    head.push(
      'Audio-feature aggregate: unavailable (Spotify did not return audio features for this playlist — read mood from artist genres + track titles + description).',
    )
  }
  if (d.topGenres.length > 0) {
    head.push(`Top genres (track-weighted, primary artist): ${d.topGenres.join(', ')}`)
  }
  const eraLine = formatEra(d.era)
  if (eraLine) head.push(eraLine)
  // Empty playlist body (editorial / curated playlist on a post-cutoff
  // app) — be explicit so the AD doesn't hallucinate track names.
  if (d.tracks.length === 0) {
    head.push(
      'Track list unavailable: Spotify withheld the playlist body. Read the mood from the description + playlist name alone.',
    )
    return `--- ${head.join('\n')} ---\n--- end Spotify playlist ---`
  }
  const trackLines = d.tracks.slice(0, SPOTIFY_TRACK_DISPLAY_LIMIT).map(trackLine)
  if (d.tracks.length > SPOTIFY_TRACK_DISPLAY_LIMIT) {
    trackLines.push(`(…and ${d.trackCount - SPOTIFY_TRACK_DISPLAY_LIMIT} more)`)
  }
  return `--- ${head.join('\n')} ---\nTrack list:\n${trackLines.join('\n')}\n--- end Spotify playlist ---`
}

// Spotify lets owners include limited HTML + entities in playlist
// descriptions. Strip so the AD reads plain text.
function stripPlaylistHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatSpotifyTrack(d: SpotifyTrackData): string {
  const head = [`Spotify track: "${d.name}" by ${d.artists.join(', ')} (${d.albumName})`]
  if (d.albumReleaseDate) head.push(`Released: ${d.albumReleaseDate}`)
  if (d.genres.length > 0) head.push(`Genres: ${d.genres.join(', ')}`)
  if (typeof d.popularity === 'number') head.push(`Popularity (0–100): ${d.popularity}`)
  if (d.explicit) head.push('Explicit content')
  if (d.audioFeatures) {
    const af = d.audioFeatures
    head.push(
      `Audio features: energy ${af.energy}, valence ${af.valence}, danceability ${af.danceability}, acousticness ${af.acousticness}, speechiness ${af.speechiness}, tempo ${Math.round(af.tempo)} BPM`,
    )
  }
  return `--- ${head.join('\n')} ---\n--- end Spotify track ---`
}

function formatSpotifyAlbum(d: SpotifyAlbumData): string {
  const af = d.audioFeatures
  const head = [
    `Spotify album: "${d.name}" by ${d.artists.join(', ')} (${d.releaseDate}, ${d.trackCount} tracks)`,
    `Audio-feature aggregate: energy ${af.avgEnergy}, valence ${af.avgValence}, danceability ${af.avgDanceability}, acousticness ${af.avgAcousticness}, median tempo ${af.medianTempo} BPM`,
  ]
  if (d.topGenres.length > 0) {
    head.push(`Genres: ${d.topGenres.join(', ')}`)
  }
  const eraLine = formatEra(d.era)
  if (eraLine) head.push(eraLine)
  const trackLines = d.tracks.slice(0, SPOTIFY_TRACK_DISPLAY_LIMIT).map(trackLine)
  if (d.tracks.length > SPOTIFY_TRACK_DISPLAY_LIMIT) {
    trackLines.push(`(…and ${d.tracks.length - SPOTIFY_TRACK_DISPLAY_LIMIT} more)`)
  }
  return `--- ${head.join('\n')} ---\nTrack list:\n${trackLines.join('\n')}\n--- end Spotify album ---`
}

function formatVideoClip(d: VideoClipData): string {
  // The AD only gets framing here (title / channel / platform / duration).
  // The deep read — hooks, transitions, pacing, sound, dialogue — comes from
  // the Senior Video Editor agent (Gemini), which the synthesizer folds in.
  const dur = d.durationSec > 0 ? ` (${formatVideoDuration(d.durationSec)})` : ''
  const platform = d.platform && d.platform !== 'other' ? ` [${d.platform}]` : ''
  const head = `Video: "${d.title || 'Untitled'}"${d.channel ? ` by ${d.channel}` : ''}${dur}${platform}`
  return `--- ${head} ---\n--- end video ---`
}

function formatVideoDuration(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
  return `${m}:${r.toString().padStart(2, '0')}`
}

// ── Senior Video Editor: multi-clip orchestration helpers ──────────────────
// Each video is watched by Gemini exactly once, ever — the route caches per
// clip (keyed by videoClipCacheTag + the clip's own hash), independent of the
// group. These helpers keep the cap, cache key, and assembly in one place; the
// route owns the DB reads/writes and the bounded-concurrency walk.

// Cap clips analysed per group. Beyond this they're reported as `skipped` and
// the user can re-run to fold them in — bounds worst-case spend per group.
export const MAX_VIDEO_CLIPS = 6

// How many clips to send to Gemini at once. Independent calls (unlike the
// Anthropic parallel-firing 502s), but keep it modest so a big group doesn't
// open a dozen downloads/uploads at once.
export const VIDEO_CLIP_CONCURRENCY = 3

// Per-clip cache bucket — distinct from the editor's group tag so one video
// reuses its breakdown across boards, groups, and re-runs. Bump the version
// when the per-clip prompt or stored shape changes.
export function videoClipCacheTag(): string {
  return `video-clip@${GEMINI_VIDEO_MODEL}@v1`
}

// Assemble per-clip breakdowns into the agent's output. Empty group → a clear
// hint; clips dropped by the cap → a `skipped` count the UI surfaces.
export function assembleVideoEditorBreakdown(
  clips: VideoClipBreakdown[],
  skipped: number,
): VideoEditorBreakdown {
  if (clips.length === 0) {
    return {
      clips: [],
      note: 'Group this agent with one or more video clips and it will break each one down.',
    }
  }
  return skipped > 0 ? { clips, skipped } : { clips }
}

// Bounded-concurrency map that preserves input order — the per-clip walk wants
// it, and exporting it keeps the behaviour test-friendly.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i] as T, i)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Run a single agent against a group. Returns the agent-specific data
 * (validated against the agent's zod schema).
 */
export async function analyzeGroup(
  objects: CanvasObject[],
  agentId: AgentId,
  depth: AnalysisDepth = DEFAULT_DEPTH,
): Promise<unknown> {
  // The Senior Video Editor doesn't run on Claude — it's analysed per-clip in
  // the route (getVideoEditorResult) so each video caches independently. Guard
  // against a misroute landing on the Anthropic path below.
  if (agentId === 'video-editor') {
    throw new Error('video-editor must be analysed per-clip in the route, not analyzeGroup')
  }
  if (!client) {
    throw new Error('Anthropic client not configured (ANTHROPIC_API_KEY missing)')
  }
  const agent = getAgent(agentId)
  const model = depth === 'fast' ? FAST_MODEL : DEEP_MODEL
  const content = await buildGroupContent(objects)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: Anthropic.Message = (await client.messages.create({
    model,
    max_tokens: agent.maxTokens,
    system: [
      {
        type: 'text',
        text: agent.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output_config: {
      format: { type: 'json_schema', schema: agent.jsonSchema },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)) as Anthropic.Message

  let parsed: unknown
  for (const block of response.content) {
    if (block.type === 'text') {
      try {
        parsed = JSON.parse(block.text)
        break
      } catch {
        // try next block
      }
    }
  }
  if (parsed === undefined) {
    throw new Error('Claude returned no parseable JSON output')
  }
  const result = agent.outputSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Agent ${agent.id} JSON failed schema: ${result.error.message}`)
  }
  return result.data
}

export function modelTag(agentId: AgentId, depth: AnalysisDepth): string {
  // The Senior Video Editor runs on Gemini, not Claude — its cache bucket is
  // keyed by the Gemini model, independent of the Claude depth setting.
  if (agentId === 'video-editor') {
    // v2 = output reshaped to { clips: [...] }; every clip in the group is
    //      analysed (each video per-clip cached) rather than just the first.
    return `video-editor@${GEMINI_VIDEO_MODEL}@v2`
  }
  // Suffix bumps invalidate the on-disk cache when the schema changes.
  // v3 = agent registry introduction (different cache bucket per agent).
  // v4 = AIAnalysis gained logo + fonts fields; prompt + content builder
  //      changed (image URL labels, text-node font metadata).
  // v5 = font specimen objects emit ground-truth family name in the
  //      content builder; group header gained a font-count line.
  // v6 = uploaded fonts emitted as a dedicated top-of-prompt BRAND
  //      FONTS block with MUST-INCLUDE instructions; PDF excerpt
  //      preamble explicitly notes typography in PDFs is incidental;
  //      AD prompt restructured to enforce strict trust hierarchy.
  // v7 = font priority re-ordered: photos with type rank above text-
  //      node and PDF content, which only count when they explicitly
  //      name a typeface. CSS-fallback-stack text-node font tags are
  //      now explicitly in the IGNORE list.
  // v8 = logo schema changed from single object to array — AD now
  //      returns every mark variant (wordmark, icon, colour variants).
  // v9 = Notion pages now feed into the AD/synth prompt as a dedicated
  //      content block with equal weight to PDFs. Cache invalidates so
  //      groups that already contained an external node re-run with the
  //      page contents in context.
  // v10 = Notion markdown converter expanded — column_list / synced_block
  //      now inline their children, tables flatten to pipe-tables, media
  //      blocks render as labelled links, per-block error isolation. The
  //      markdown for any page that contains these blocks changes.
  // v11 = Google Drive files + folders feed into the AD/synth prompt with
  //      equal weight to PDFs / Notion. Header counts updated.
  // v12 = Web pages (Phase 14) feed in as a dedicated content block with
  //      palette + typography hints surfaced inline. Header counts gain
  //      a web page(s) line. Cache invalidates so groups that already
  //      contained a web-page object re-run with the new block.
  // v13 = Spotify (Phase 15) playlists/tracks/albums feed in as a
  //      dedicated tonal block with audio-feature aggregates surfaced
  //      to the AD. Header counts gain Spotify lines.
  // v14 = Spotify blocks now carry track-weighted top genres, decade
  //      era aggregate, and per-track explicit/popularity/album-year
  //      metadata. The AD reads genre vibe + era directly.
  // v15 = Spotify playlists surface the owner's description prominently
  //      and suppress zero-valued audio-feature lines when Spotify did
  //      not actually return them (Nov 2024 access lock fallback). The
  //      AD now has explicit "track list unavailable" wording for
  //      editorial playlists so it doesn't hallucinate tracks.
  // v16 = Video clips (Phase 16) feed in as a reference block — Whisper
  //      transcript + title + channel. Header counts gain a video line.
  const v = 'v16'
  return `${agentId}@${depth === 'fast' ? FAST_MODEL : DEEP_MODEL}@${v}`
}

export function synthesisModelTag(agentIds: AgentId[], depth: AnalysisDepth): string {
  // v3 — added positioning / references / tensions / bodyCopy fields.
  // v4 — added logo + fonts; dropped typography.samples (consolidated
  //      into fonts). AD prompt changes (image URL labels, text-node
  //      font metadata) also affect synth inputs, so bumping here too.
  // v5 — font specimen objects emit ground-truth family in the AD
  //      content; downstream synthesis input changes too.
  // v6 — uploaded fonts now in a dedicated BRAND FONTS block at the
  //      top of the AD prompt; downstream synth inputs change.
  // v7 — font priority hierarchy re-ordered (photos > text/PDF unless
  //      explicit naming); AD output shape unchanged but content
  //      shifts noticeably, so downstream synth needs to re-run.
  // v8 — logo schema is now an array; downstream synth output shape
  //      changed to match.
  // v9 — Notion page contents now appear in the AD/synth input prompt.
  //      Synth output shape unchanged but the upstream content shifts.
  // v10 — Notion markdown converter expanded (columns, tables, media);
  //       upstream content shifts again.
  // v11 — Drive files + folders feed into the synth prompt with equal
  //       weight to PDFs / Notion.
  // v12 — Web pages feed into the synth prompt with palette + typography
  //       hints in the excerpt headers.
  // v13 — Spotify playlists/tracks/albums feed into the synth prompt with
  //       audio-feature aggregates in a tonal-signal block.
  // v14 — Spotify blocks gain top-genre + era + per-track meta. Synth
  //       reads from the same prompt so the version bumps in lockstep.
  // v15 — Spotify playlist prompt now leads with the owner's
  //       description and suppresses zero audio-features instead of
  //       reading them as literal zeros.
  // v16 — Video clips feed into the synth prompt as a reference block
  //       (transcript + title + channel). Bumps in lockstep with the AD.
  // v17 — Senior Video Editor output reshaped to { clips: [...] }; when it's
  //       one of the synthesised agents its read changes shape, so the synth
  //       bucket must invalidate.
  // v18 — brief gained a `video` block (hooks/transitions/pacing distilled
  //       from the Senior Video Editor's read); synth output schema + prompt
  //       changed, so the bucket invalidates.
  // v19 — naming discipline: brief keeps proper names (brands / creators /
  //       public figures) out of every field except `references`. Re-synth so
  //       existing briefs that named a video creator get cleaned.
  const v = 'v19'
  const sorted = [...agentIds].sort().join(',')
  return `synth:${sorted}@${depth === 'fast' ? FAST_MODEL : DEEP_MODEL}@${v}`
}

/**
 * Synthesise a unified read from multiple agents' outputs. The moodboard's
 * content + each agent's read are fed in as context for the synthesiser.
 */
export async function synthesizeGroup(
  objects: CanvasObject[],
  agentResults: Array<{ id: AgentId; label: string; data: unknown }>,
  depth: AnalysisDepth = DEFAULT_DEPTH,
): Promise<unknown> {
  if (!client) {
    throw new Error('Anthropic client not configured (ANTHROPIC_API_KEY missing)')
  }
  const model = depth === 'fast' ? FAST_MODEL : DEEP_MODEL
  const content = await buildGroupContent(objects)

  // Append each prior agent's output as a labelled text block so the
  // synthesiser can read them as separate "specialist takes."
  for (const r of agentResults) {
    const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2)
    content.push({
      type: 'text',
      text: `--- ${r.label}'s read ---\n${body}\n--- end ${r.label}'s read ---`,
    })
  }
  content.push({
    type: 'text',
    text: 'Now: synthesise these into one unified read.',
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: Anthropic.Message = (await client.messages.create({
    model,
    max_tokens: SYNTHESIZER.maxTokens,
    system: [
      {
        type: 'text',
        text: SYNTHESIZER.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output_config: {
      format: { type: 'json_schema', schema: SYNTHESIZER.jsonSchema },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)) as Anthropic.Message

  let parsed: unknown
  for (const block of response.content) {
    if (block.type === 'text') {
      try {
        parsed = JSON.parse(block.text)
        break
      } catch {
        // try next
      }
    }
  }
  if (parsed === undefined) {
    throw new Error('Claude returned no parseable JSON output')
  }
  const result = SYNTHESIZER.outputSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Synthesiser JSON failed schema: ${result.error.message}`)
  }
  return result.data
}
