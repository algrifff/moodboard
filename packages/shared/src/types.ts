export type ImageData = { url: string; thumbnailUrl?: string }
export type StickyData = { text: string; color: string; transparent?: boolean }
export type TextData = { text: string; font: string; fontSize: number }
export type PDFData = {
  url: string
  thumbnailUrl: string
  extractedText: string
  // Total page count; the canvas widget shows page-flip buttons when > 1.
  pageCount?: number
}
// A user-uploaded font file as a first-class canvas object. The browser
// registers `family` as a FontFace pointing at `url`; the FontNode renders
// the family name in the loaded typeface at display size, with optional
// sampleText override.
export type FontData = {
  url: string
  family: string
  sampleText?: string
}

// External-source nodes — content imported from a connected Drive account.
// The board owns its snapshot: `excerpt` lives on the canvas object itself so
// the board keeps rendering even if the source moves or is deleted.
// `connectionId` lets the refresh endpoint look up credentials to refetch on
// demand.

// Google Drive file — Docs, Sheets, Slides, or any other type that isn't
// routed to a dedicated node. PDFs and images come back through the existing
// PDFNode / ImageNode flows; only the "Google native" + arbitrary files
// land on this type.
//
// `excerpt` is the AI-readable representation:
//   - Doc       → first ~4000 chars of plain-text export
//   - Sheet     → CSV of the first sheet, capped
//   - Slides    → slide titles + speaker notes, joined
//   - other     → file name + mime + size, with a "(no preview)" note
export type DriveFileData = {
  connectionId: string
  fileId: string
  mimeType: string
  name: string
  iconUrl?: string
  // Public Drive URL — used by the "Open in Drive" link.
  webViewLink: string
  excerpt: string
  fetchedAt: string
  modifiedTime?: string
}

// Google Drive folder. Folders don't carry content of their own — they're
// hierarchy. The card shows the name + a child-count chip; the AD reads the
// child list as auxiliary context (not first-class content).
export type DriveFolderData = {
  connectionId: string
  folderId: string
  name: string
  webViewLink: string
  childCount: number
  // Names + mime types of the first 30 children, captured at import. The AD
  // uses this for context; the picker uses /children to walk the live tree.
  childPreview: { name: string; mimeType: string }[]
  fetchedAt: string
  modifiedTime?: string
}

// A web page imported by URL (Phase 14). No OAuth — the server fetches the
// page with a headless browser, extracts the brand-relevant signal, and
// snapshots it onto the canvas object. Brand logos discovered on the page
// land as separate `image` objects adjacent to the card so they're vision-
// readable by the AD the same way an uploaded image is.
//
// `readableText` is the AD's input — Mozilla Readability over the static
// HTML, capped to ~4000 chars. `colours` and `fonts` are computed-style
// reads from the rendered page so they reflect what the user actually sees,
// not what's declared in CSS sources.
export type WebPageData = {
  url: string
  host: string
  title: string
  description: string
  faviconUrl?: string
  readableText: string
  colours: { hex: string; role: string }[]
  fonts: { family: string; role: 'display' | 'body' }[]
  fetchedAt: string
}

// Shared aggregate of Spotify's audio-features endpoint. Every value is in
// 0..1 *except* tempo (BPM) and durationMs. We aggregate at extraction time
// so the canvas object stores ready-to-render tonal signal — the AD prompt
// reads from the aggregate, not the per-track features. Per-track features
// would explode prompt size for a 100-track playlist with no extra signal.
export type SpotifyAudioFeaturesAgg = {
  // Energy 0..1 — perceptual intensity & activity. Loud, fast, noisy = high.
  avgEnergy: number
  // Valence 0..1 — musical positiveness. High = cheerful / euphoric.
  avgValence: number
  // Danceability 0..1 — how suitable for dancing.
  avgDanceability: number
  // Acousticness 0..1 — confidence that the track is acoustic.
  avgAcousticness: number
  // Instrumentalness 0..1 — high = no vocals.
  avgInstrumentalness: number
  // Speechiness 0..1 — talk/podcast content. >0.66 = mostly spoken.
  avgSpeechiness: number
  // Tempo (BPM) — median rather than mean so a single outlier track
  // doesn't pull the centre value.
  medianTempo: number
  // Track sample size the aggregate was computed over. Lets the AD weight
  // a 50-track read more than a 3-track one.
  trackCount: number
}

// One track entry on a playlist/album card. Capped to the top N when
// stored so a 200-track playlist doesn't blow the JSONB budget. The
// per-track audio features live alongside so we can highlight specific
// tracks ("hooky track #3 is high energy + low valence") if we ever want
// to surface them, but the aggregate above is what the AD reads.
export type SpotifyTrackSummary = {
  id: string
  name: string
  artists: string[]
  durationMs: number
  // Album name + release date give era + grouping signal that the AD
  // reads inline. Release date is Spotify's ISO `YYYY-MM-DD` or `YYYY`.
  albumName?: string
  albumReleaseDate?: string
  // Spotify's content flags + popularity score (0..100). Surfaced so the
  // AD can comment on era + accessibility + mass appeal of the mix.
  explicit?: boolean
  popularity?: number
  // 30s preview mp3 if available — used by the canvas card's hover preview.
  previewUrl?: string
  // Primary-artist genres for this track. Same source as the playlist's
  // aggregate topGenres, but kept per-track so the expanded detail view
  // can show which songs carry which genre. Empty when the artist is
  // untagged or the artists endpoint was unavailable.
  genres?: string[]
  // Optional because audio-features can 404 for tracks like local files
  // or podcasts that don't have features computed.
  audioFeatures?: {
    energy: number
    valence: number
    danceability: number
    tempo: number
  }
}

// Per-decade breakdown derived from track album release dates. The
// dominant decade is the head of the list; full distribution carried for
// when the AD wants to comment on a mix that straddles eras ("70s rock
// to 90s rap → genre-spanning, eclectic").
export type SpotifyEraAgg = {
  dominantDecade: string | null
  decadeBreakdown: { decade: string; count: number }[]
  yearMin: number | null
  yearMax: number | null
}

// A Spotify playlist imported via OAuth. The cover + name + audio-feature
// aggregate are the on-canvas signal; tracks[] is capped at the first 30
// for prompt budget, but the aggregate is computed over the *full*
// playlist's audio features at extraction time.
//
// `snapshotId` is Spotify's playlist-state etag. Refresh compares it to
// know whether the playlist changed; the analysis hash also bakes it in
// so a track add/remove busts the AD cache cleanly.
export type SpotifyPlaylistData = {
  connectionId: string
  playlistId: string
  snapshotId: string
  name: string
  description: string
  ownerName: string
  coverUrl?: string
  trackCount: number
  // First 30 tracks for display; aggregate is over the full set.
  tracks: SpotifyTrackSummary[]
  audioFeatures: SpotifyAudioFeaturesAgg
  // Track-weighted top genres across the playlist's primary artists. Up
  // to 8 entries, sorted by frequency. Empty when the playlist's artists
  // have no genres tagged (rare — Spotify tags most catalog artists).
  topGenres: string[]
  // Decade aggregate over per-track album release dates.
  era: SpotifyEraAgg
  // Public Spotify URL — used by the "Open in Spotify" link.
  url: string
  fetchedAt: string
}

// A single Spotify track. Audio features land directly on the data (no
// aggregation — there's one track's worth). `albumCoverUrl` is the
// track's album cover; we show it on the card.
export type SpotifyTrackData = {
  connectionId: string
  trackId: string
  name: string
  artists: string[]
  albumName: string
  albumCoverUrl?: string
  albumReleaseDate?: string
  durationMs: number
  explicit?: boolean
  popularity?: number
  previewUrl?: string
  // Genres of the track's primary artist. Same source as the playlist
  // aggregate but flat (it's one track).
  genres: string[]
  audioFeatures?: {
    energy: number
    valence: number
    danceability: number
    acousticness: number
    instrumentalness: number
    speechiness: number
    tempo: number
  }
  url: string
  fetchedAt: string
}

// A Spotify album. Aggregate audio features over all tracks; track list
// uncapped because albums are bounded (a 30-track album is rare).
export type SpotifyAlbumData = {
  connectionId: string
  albumId: string
  name: string
  artists: string[]
  releaseDate: string
  coverUrl?: string
  trackCount: number
  tracks: SpotifyTrackSummary[]
  audioFeatures: SpotifyAudioFeaturesAgg
  topGenres: string[]
  era: SpotifyEraAgg
  url: string
  fetchedAt: string
}

// A voice note recorded in-browser via MediaRecorder, with live
// transcription from the Web Speech API. The audio file lives on the
// volume like any upload; the transcript travels alongside so the AD
// reads what was said the same way it reads a sticky note. In browsers
// without SpeechRecognition (Firefox) the audio still records and the
// transcript lands empty.
export type VoiceNoteData = {
  // /api/files/<id>.<ext> served by the files route.
  url: string
  // MediaRecorder's chosen MIME — audio/webm;codecs=opus on Chromium,
  // audio/mp4 on Safari. Stored so playback picks the right decoder.
  mimeType: string
  // Recording length in whole seconds.
  durationSec: number
  // Final transcript (may be empty when the live recogniser was
  // unavailable or the recording was silence).
  transcript: string
  // ISO timestamp of when the recording finished.
  fetchedAt: string
}

// A video clip imported from a public URL (YouTube, TikTok, Instagram Reel,
// X, Vimeo). yt-dlp pulls the metadata + audio; OpenAI Whisper transcribes
// the audio; the platform thumbnail is saved to /data like an upload. The
// transcript is the high-signal mood input the AD reads — what's actually
// said in the clip — alongside the title + channel.
export type VideoClipData = {
  // Normalised platform label ('youtube' | 'tiktok' | 'instagram' | 'x' |
  // 'vimeo' | 'other') — drives the "Open in …" chip + logging.
  platform: string
  // The canonical/webpage URL (yt-dlp's resolved `webpage_url`).
  url: string
  // Stable platform video id (yt-dlp `id`) — refresh + hash identity.
  videoId: string
  title: string
  channel: string
  // Duration in whole seconds (0 when unknown — some platforms omit it).
  durationSec: number
  // Saved thumbnail served from /api/files/… (empty when none was found).
  thumbnailUrl: string
  fetchedAt: string
}

// A granular craft breakdown of ONE video clip produced by Gemini (which
// watches frames + listens to audio + reads speech together). Identity fields
// (videoId/title/platform/url) are stamped from the clip object, never the
// model, so they're always trustworthy. Every timestamp is a "M:SS" string
// into that clip.
export type VideoClipBreakdown = {
  videoId: string
  title: string
  platform: string
  url: string
  // One-paragraph read of the overall edit style + what makes it work.
  summary: string
  // The attention hooks and WHY each lands + how to recreate it.
  hooks: { timestamp: string; what: string; whyItWorks: string; howToReplicate: string }[]
  // Cuts / transitions and the effect each creates.
  transitions: { timestamp: string; type: string; description: string }[]
  // Sound design beats — SFX, music drops, silence, risers.
  soundDesign: { timestamp: string; element: string; effect: string }[]
  // What's said + how it's delivered (cadence, emphasis, timing).
  spokenBeats: { timestamp: string; quote: string; delivery: string }[]
  // Cut cadence / rhythm / energy curve across the clip — one paragraph.
  pacing: string
  // Step-by-step playbook to replicate this clip's style on a new video.
  replicationPlaybook: string[]
  // Set when this clip couldn't be analysed (unsupported platform, download
  // failure, unreadable model response) — a short reason; arrays will be empty.
  unavailableReason?: string
}

// The Senior Video Editor agent's output — one craft breakdown per video clip
// in the group. Clips are watched + cached individually (each video is sent to
// Gemini exactly once, ever, keyed by its id), then assembled here.
export type VideoEditorBreakdown = {
  clips: VideoClipBreakdown[]
  // Clips beyond the per-group analysis cap that were left unanalysed.
  skipped?: number
  // Empty-state / global hint shown when there are no clips to break down yet.
  note?: string
}

export type CanvasObjectType =
  | 'image'
  | 'sticky'
  | 'text'
  | 'pdf'
  | 'font'
  | 'drive-file'
  | 'drive-folder'
  | 'web-page'
  | 'spotify-playlist'
  | 'spotify-track'
  | 'spotify-album'
  | 'video-clip'
  | 'voice-note'
  | 'output'

// Phase 23 — a design output placed on a board as a live card. The card
// renders the output's latest composed document, scaled; everything else
// about the output lives on the output itself. `width`/`height` are the
// document's design viewport, so the card keeps its aspect ratio.
export type OutputCardData = {
  outputId: string
  name: string
  format: string
  width: number
  height: number
}

export type CanvasObject = {
  id: string
  type: CanvasObjectType
  position: { x: number; y: number }
  size: { width: number; height: number }
  rotation: number
  zIndex: number
  data:
    | ImageData
    | StickyData
    | TextData
    | PDFData
    | FontData
    | DriveFileData
    | DriveFolderData
    | WebPageData
    | SpotifyPlaylistData
    | SpotifyTrackData
    | SpotifyAlbumData
    | VideoClipData
    | VoiceNoteData
    | OutputCardData
}

export type AIAnalysis = {
  // Top of the read — what an AD opens / closes the kickoff with.
  headline: string
  summary: string

  // Visual + emotional
  mood: string
  tone: string
  palette: string[]
  adjectives: string[]
  emotions: string[]
  typographicVoice: string[]
  themes: string[]

  // Art-director synthesis
  references: string[]
  tensions: string[]
  risks: string[]

  // Text content distillation (empty arrays when no text in the group)
  hooks: string[]
  statements: string[]
  tropes: string[]

  // Brand mark variants the AD identified from canvas content. A brand
  // typically has several — primary wordmark, icon, monogram, white/dark
  // colour variants. Each entry stands on its own. Empty array when no
  // image qualifies.
  logo: {
    url: string // /api/files/... matching one of the images on the canvas
    reason: string // one short clause naming the variant (e.g. "Primary
    // wordmark", "Monogram icon — single colour", "Inverted on dark")
  }[]
  fonts: {
    name: string // typeface name from a text node's `.font` or a specimen
    category: string // 'neo-grotesque', 'transitional serif', etc.
    role: string // 'display' | 'body' | 'caption'
    sample: string // verbatim phrase from the moodboard rendered at scale
  }[]
}

// Generic output shape used by every agent except the Art Director. A short
// list of heading + body sections — clean for any rendering surface, and
// flexible enough to host personas, channel rationales, copy variations, etc.
export type SectionedParagraphs = {
  sections: { heading: string; body: string }[]
}

// Structured brief produced by the synthesiser. Each field maps to a visual
// block in the renderer; empty arrays / empty strings mean "don't render this
// block." Each block has a primary contributor agent; when that agent didn't
// run, the block's values stay empty and the block self-skips.
//
// CONTRIBUTOR MAP (add new agents by extending this):
//   Art Director       → palette, typography(feel), fonts, logo, references,
//                        tensions, watchFors
//   Business Analyst   → positioning
//   Audience Profiler  → audiences
//   Channel Strategist → channels
//   Copywriter         → hooks, statements, bodyCopy, fonts(sample text source)
//   (cross-agent)      → throughline, notes
export type SynthesisBrief = {
  // The single concrete sentence the brief hangs on. May be a phrase pulled
  // verbatim from one of the agents — attribute via `throughlineSource`.
  throughline: string
  throughlineSource: string // agent label, or empty string if synthesised

  // What this brand IS, from the Business Analyst. Three short clauses;
  // each can be empty if no BA ran.
  positioning: {
    model: string // how the money flows
    niche: string // the wedge
    category: string // where it sits in its category
  }

  // Colours pulled from the Art Director's palette, ordered.
  palette: { hex: string; role: string; note: string }[]

  // Typographic voice — one-line description of the overall feel.
  // Concrete typeface samples live in `fonts` (Move A consolidation).
  typography: {
    feel: string
  }

  // Typefaces in use — name + category + role + sample phrase. The single
  // source of structured typography in the brief: TypographyBlock renders
  // the feel line, FontsBlock renders these samples at scale.
  fonts: {
    name: string // typeface name when known, '' if descriptive only
    category: string
    role: string // 'display' | 'subhead' | 'body' | 'caption'
    sample: string // real phrase from the moodboard
  }[]

  // The brand's mark variants, when any are identifiable on the canvas.
  // Mirrors AIAnalysis.logo — same shape, same semantics. Empty array
  // means no confident logo was found and the renderer skips the block.
  logo: {
    url: string
    reason: string
  }[]

  // Designers / studios / movements / eras / brands this work is in
  // conversation with — verbatim from the Art Director's references.
  references: string[]

  // Productive contrasts the brand intentionally holds — verbatim from the
  // Art Director's tensions. Distinct from watchFors: tensions are
  // load-bearing, watchFors are negatives.
  tensions: string[]

  // Audience cards from the Audience Profiler — verbatim segment names.
  audiences: { label: string; insight: string }[]

  // Channel plays from the Channel Strategist — verbatim channel names.
  channels: { name: string; play: string }[]

  // Verbatim copy lines from the Copywriter — taglines, headlines, CTAs.
  hooks: string[]
  // The single about-page / hero prose paragraph from the Copywriter,
  // exactly as written. Empty string if no Copywriter ran.
  bodyCopy: string
  // Short declarative brand-belief lines.
  statements: string[]
  // Specific things to avoid — synthesised across risks + tropes.
  watchFors: string[]
  // Markdown-style bullet lines for nuance the structured fields don't hold.
  notes: string[]

  // Video direction — populated only when the Senior Video Editor analysed a
  // clip in the group. The synthesiser translates the reference clips' craft
  // into a concrete, timestamped plan for the brand's OWN video. All-empty
  // (both arrays empty + blank pacing) when no video editor read was present,
  // and the renderer skips the block.
  video: {
    // Opening hooks to use in the brand's video — each with a timing cue, a
    // concrete line to SAY (or action to take), the technique it borrows from
    // the references, and why it lands.
    hooks: { at: string; say: string; technique: string; why: string }[]
    // Transitions that would work + when to fire them.
    transitions: { at: string; type: string; note: string }[]
    // One-line cut-rhythm / pacing recommendation for the brand's video.
    pacing: string
  }
}

// The full set of agent IDs the backend supports. Add new entries here as
// agents come online — the frontend uses this to enumerate the panel rows.
export type AgentId =
  | 'art-director'
  | 'business-analyst'
  | 'audience-profiler'
  | 'channel-strategist'
  | 'copywriter'
  | 'video-editor'

// What an agent returns. The Art Director is the historical structured
// shape; everything else returns sectioned paragraphs.
export type AgentOutput =
  | { agentId: 'art-director'; data: AIAnalysis }
  | {
      agentId: 'business-analyst' | 'audience-profiler' | 'channel-strategist' | 'copywriter'
      data: SectionedParagraphs
    }
  | { agentId: 'video-editor'; data: VideoEditorBreakdown }

// ---------------------------------------------------------------------------
// Phase 18 — shareable moodboards (frozen snapshot + PDF)
//
// A share is an immutable read-only projection of a board at a moment in
// time. The blob carries everything a viewer needs to render the canvas
// hero + per-group brief without a database round trip beyond the share
// row itself. The owner can "Update snapshot" — same token, new payload.
// ---------------------------------------------------------------------------

// What an agent-row run produced for a group, baked into the share
// snapshot. Mirrors the four "ready" SlotState kinds the editor's
// AIAnalysisPanel renders (excluding loading/error/idle, which would
// be meaningless once frozen). The viewer dispatches on `kind` to
// pick the matching readout component.
export type SharedAnalysisDisplay =
  | { kind: 'ad'; data: AIAnalysis }
  | { kind: 'sectioned'; data: SectionedParagraphs }
  | { kind: 'video'; data: VideoEditorBreakdown }
  | { kind: 'brief'; data: SynthesisBrief }

// One group as captured in the snapshot. Distinct from the live
// runtime Group type because (a) it carries the baked analysis
// display (which only lives in localStorage on the editor) and (b)
// the bounds shape matches what GroupOutline / ColorPaletteWidget
// consume.
export type SharedGroupSnapshot = {
  // Stable identity — sorted-join of object IDs, same as groupId() in
  // apps/web/src/lib/aabb.ts. Lets the viewer key React lists.
  key: string
  objectIds: string[]
  bounds: { left: number; top: number; right: number; bottom: number }
  // Final palette hexes (AI palette when synthesis ran, otherwise the
  // image-derived palette). Empty array when neither was available.
  palette: string[]
  // The analysis display baked at share-time, including any inline
  // edits the user made. Absent when the group's agent row never
  // produced a finished run. Covers all four ready kinds so a single-
  // agent Art Director run survives the snapshot the same way a
  // multi-agent synthesis does.
  display?: SharedAnalysisDisplay
  // Back-compat: an earlier draft of this type used `brief` for
  // synthesis output only. Keep it as a read-time alias so existing
  // shares created before `display` landed still render correctly.
  brief?: SynthesisBrief
}

// The serialised payload stored in share.snapshot. Version stamped so a
// future schema change can be migrated without breaking old shares.
export type SharedBoardSnapshot = {
  version: 1
  boardName: string
  capturedAt: string
  objects: CanvasObject[]
  groups: SharedGroupSnapshot[]
}

// What GET /api/shares/:token returns. Owner-side fields (assetFilenames,
// pdfFilename) stay server-side.
export type ShareView = {
  token: string
  boardName: string
  snapshot: SharedBoardSnapshot
  capturedAt: string
  updatedAt: string
}
