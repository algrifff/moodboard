import { z } from 'zod'
import type { CanvasObject } from './types'

// URLs on canvas objects are typically server-relative `/api/files/<id>`
// paths, not absolute URLs. The boards endpoint accepts state via
// z.unknown() so this never bit there — Phase 18 share validation
// catches it now. Match webPageDataSchema's precedent: plain string.
export const imageDataSchema = z.object({
  url: z.string().min(1),
  thumbnailUrl: z.string().min(1).optional(),
})

export const stickyDataSchema = z.object({
  text: z.string(),
  color: z.string(),
  // When true, the note renders without its background colour — just the
  // markdown text on the canvas. Toggleable per-note via the floating
  // toolbar that appears when the note is selected.
  transparent: z.boolean().optional(),
})

export const textDataSchema = z.object({
  text: z.string(),
  font: z.string(),
  fontSize: z.number(),
})

export const pdfDataSchema = z.object({
  url: z.string().min(1),
  thumbnailUrl: z.string().min(1),
  extractedText: z.string(),
  pageCount: z.number().optional(),
})

export const fontDataSchema = z.object({
  url: z.string().min(1),
  family: z.string(),
  sampleText: z.string().optional(),
})

export const driveFileDataSchema = z.object({
  connectionId: z.string(),
  fileId: z.string(),
  mimeType: z.string(),
  name: z.string(),
  iconUrl: z.string().optional(),
  webViewLink: z.string(),
  excerpt: z.string(),
  fetchedAt: z.string(),
  modifiedTime: z.string().optional(),
})

export const driveFolderDataSchema = z.object({
  connectionId: z.string(),
  folderId: z.string(),
  name: z.string(),
  webViewLink: z.string(),
  childCount: z.number(),
  childPreview: z.array(
    z.object({
      name: z.string(),
      mimeType: z.string(),
    }),
  ),
  fetchedAt: z.string(),
  modifiedTime: z.string().optional(),
})

export const webPageDataSchema = z.object({
  url: z.string(),
  host: z.string(),
  title: z.string(),
  description: z.string(),
  faviconUrl: z.string().optional(),
  readableText: z.string(),
  colours: z.array(z.object({ hex: z.string(), role: z.string() })),
  fonts: z.array(z.object({ family: z.string(), role: z.enum(['display', 'body']) })),
  fetchedAt: z.string(),
})

const spotifyAudioFeaturesAggSchema = z.object({
  avgEnergy: z.number(),
  avgValence: z.number(),
  avgDanceability: z.number(),
  avgAcousticness: z.number(),
  avgInstrumentalness: z.number(),
  avgSpeechiness: z.number(),
  medianTempo: z.number(),
  trackCount: z.number(),
})

const spotifyTrackSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  artists: z.array(z.string()),
  durationMs: z.number(),
  albumName: z.string().optional(),
  albumReleaseDate: z.string().optional(),
  explicit: z.boolean().optional(),
  popularity: z.number().optional(),
  previewUrl: z.string().optional(),
  genres: z.array(z.string()).optional(),
  audioFeatures: z
    .object({
      energy: z.number(),
      valence: z.number(),
      danceability: z.number(),
      tempo: z.number(),
    })
    .optional(),
})

const spotifyEraAggSchema = z.object({
  dominantDecade: z.string().nullable(),
  decadeBreakdown: z.array(z.object({ decade: z.string(), count: z.number() })),
  yearMin: z.number().nullable(),
  yearMax: z.number().nullable(),
})

export const spotifyPlaylistDataSchema = z.object({
  connectionId: z.string(),
  playlistId: z.string(),
  snapshotId: z.string(),
  name: z.string(),
  description: z.string(),
  ownerName: z.string(),
  coverUrl: z.string().optional(),
  trackCount: z.number(),
  tracks: z.array(spotifyTrackSummarySchema),
  audioFeatures: spotifyAudioFeaturesAggSchema,
  topGenres: z.array(z.string()),
  era: spotifyEraAggSchema,
  url: z.string(),
  fetchedAt: z.string(),
})

export const spotifyTrackDataSchema = z.object({
  connectionId: z.string(),
  trackId: z.string(),
  name: z.string(),
  artists: z.array(z.string()),
  albumName: z.string(),
  albumCoverUrl: z.string().optional(),
  albumReleaseDate: z.string().optional(),
  durationMs: z.number(),
  explicit: z.boolean().optional(),
  popularity: z.number().optional(),
  previewUrl: z.string().optional(),
  genres: z.array(z.string()),
  audioFeatures: z
    .object({
      energy: z.number(),
      valence: z.number(),
      danceability: z.number(),
      acousticness: z.number(),
      instrumentalness: z.number(),
      speechiness: z.number(),
      tempo: z.number(),
    })
    .optional(),
  url: z.string(),
  fetchedAt: z.string(),
})

export const spotifyAlbumDataSchema = z.object({
  connectionId: z.string(),
  albumId: z.string(),
  name: z.string(),
  artists: z.array(z.string()),
  releaseDate: z.string(),
  coverUrl: z.string().optional(),
  trackCount: z.number(),
  tracks: z.array(spotifyTrackSummarySchema),
  audioFeatures: spotifyAudioFeaturesAggSchema,
  topGenres: z.array(z.string()),
  era: spotifyEraAggSchema,
  url: z.string(),
  fetchedAt: z.string(),
})

export const videoClipDataSchema = z.object({
  platform: z.string(),
  url: z.string(),
  videoId: z.string(),
  title: z.string(),
  channel: z.string(),
  durationSec: z.number(),
  thumbnailUrl: z.string(),
  fetchedAt: z.string(),
})

export const voiceNoteDataSchema = z.object({
  url: z.string().min(1),
  mimeType: z.string(),
  durationSec: z.number(),
  transcript: z.string(),
  fetchedAt: z.string(),
})

export const canvasObjectSchema = z.object({
  id: z.string(),
  type: z.enum([
    'image',
    'sticky',
    'text',
    'pdf',
    'font',
    'drive-file',
    'drive-folder',
    'web-page',
    'spotify-playlist',
    'spotify-track',
    'spotify-album',
    'video-clip',
    'voice-note',
  ]),
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ width: z.number(), height: z.number() }),
  rotation: z.number(),
  zIndex: z.number(),
  data: z.union([
    imageDataSchema,
    stickyDataSchema,
    textDataSchema,
    pdfDataSchema,
    fontDataSchema,
    driveFileDataSchema,
    driveFolderDataSchema,
    webPageDataSchema,
    spotifyPlaylistDataSchema,
    spotifyTrackDataSchema,
    spotifyAlbumDataSchema,
    videoClipDataSchema,
    voiceNoteDataSchema,
  ]),
})

export const aiAnalysisSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  mood: z.string(),
  tone: z.string(),
  palette: z.array(z.string()),
  adjectives: z.array(z.string()),
  emotions: z.array(z.string()),
  typographicVoice: z.array(z.string()),
  themes: z.array(z.string()),
  references: z.array(z.string()),
  tensions: z.array(z.string()),
  risks: z.array(z.string()),
  hooks: z.array(z.string()),
  statements: z.array(z.string()),
  tropes: z.array(z.string()),
  logo: z.array(
    z.object({
      url: z.string(),
      reason: z.string(),
    }),
  ),
  fonts: z.array(
    z.object({
      name: z.string(),
      category: z.string(),
      role: z.string(),
      sample: z.string(),
    }),
  ),
})

export const sectionedParagraphsSchema = z.object({
  sections: z
    .array(
      z.object({
        heading: z.string(),
        body: z.string(),
      }),
    )
    .min(1)
    .max(10),
})

// The synthesiser's structured brief. Every field is present (Anthropic's
// json_schema mode requires it); empty arrays / empty strings signal "no
// content for this block" and the renderer skips them.
export const synthesisBriefSchema = z.object({
  throughline: z.string(),
  throughlineSource: z.string(),
  positioning: z.object({
    model: z.string(),
    niche: z.string(),
    category: z.string(),
  }),
  palette: z.array(
    z.object({
      hex: z.string(),
      role: z.string(),
      note: z.string(),
    }),
  ),
  typography: z.object({
    feel: z.string(),
  }),
  fonts: z.array(
    z.object({
      name: z.string(),
      category: z.string(),
      role: z.string(),
      sample: z.string(),
    }),
  ),
  logo: z.array(
    z.object({
      url: z.string(),
      reason: z.string(),
    }),
  ),
  references: z.array(z.string()),
  tensions: z.array(z.string()),
  audiences: z.array(z.object({ label: z.string(), insight: z.string() })),
  channels: z.array(z.object({ name: z.string(), play: z.string() })),
  hooks: z.array(z.string()),
  bodyCopy: z.string(),
  statements: z.array(z.string()),
  watchFors: z.array(z.string()),
  notes: z.array(z.string()),
  video: z.object({
    hooks: z.array(
      z.object({
        at: z.string(),
        say: z.string(),
        technique: z.string(),
        why: z.string(),
      }),
    ),
    transitions: z.array(z.object({ at: z.string(), type: z.string(), note: z.string() })),
    pacing: z.string(),
  }),
})

export const agentIdSchema = z.enum([
  'art-director',
  'business-analyst',
  'audience-profiler',
  'channel-strategist',
  'copywriter',
  'video-editor',
])
export type AgentIdInput = z.infer<typeof agentIdSchema>

// Senior Video Editor agent output (Gemini-produced). Validated server-side
// after Gemini returns JSON, and on the client when reading agent results.
// Craft-only shape Gemini is asked to return for ONE clip — no identity, no
// unavailable flag (the server stamps identity from the clip object and owns
// the unavailable path). Used to validate raw model output.
export const geminiVideoCraftSchema = z.object({
  summary: z.string(),
  hooks: z.array(
    z.object({
      timestamp: z.string(),
      what: z.string(),
      whyItWorks: z.string(),
      howToReplicate: z.string(),
    }),
  ),
  transitions: z.array(
    z.object({ timestamp: z.string(), type: z.string(), description: z.string() }),
  ),
  soundDesign: z.array(
    z.object({ timestamp: z.string(), element: z.string(), effect: z.string() }),
  ),
  spokenBeats: z.array(
    z.object({ timestamp: z.string(), quote: z.string(), delivery: z.string() }),
  ),
  pacing: z.string(),
  replicationPlaybook: z.array(z.string()),
})

// One clip's stored breakdown = craft fields + identity (+ optional
// unavailable reason). This is the per-clip cache payload.
export const videoClipBreakdownSchema = geminiVideoCraftSchema.extend({
  videoId: z.string(),
  title: z.string(),
  platform: z.string(),
  url: z.string(),
  unavailableReason: z.string().optional(),
})

// The Senior Video Editor agent's full output — one breakdown per clip.
export const videoEditorBreakdownSchema = z.object({
  clips: z.array(videoClipBreakdownSchema),
  skipped: z.number().optional(),
  note: z.string().optional(),
})

export const analyzeRequestSchema = z.object({
  objectIds: z.array(z.string()).min(1).max(50),
  agentId: agentIdSchema.default('art-director'),
  force: z.boolean().optional(),
  depth: z.enum(['fast', 'deep']).optional(),
})
export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>

// Response payload is a discriminated union by agentId. Each agent's
// `data` validates against its own schema.
export const analyzeResponseSchema = z.object({
  agentId: agentIdSchema,
  data: z.unknown(),
  cached: z.boolean(),
  groupKey: z.string(),
})
export type AnalyzeResponse = z.infer<typeof analyzeResponseSchema>

// Synthesise multiple agent outputs into a single unified read.
export const synthesizeRequestSchema = z.object({
  objectIds: z.array(z.string()).min(1).max(50),
  // Cap = the number of agents (agentIdSchema). Was 5 when there were five
  // agents; the Senior Video Editor made six, so a "select all" synthesis hit
  // the old cap. Bump this in lockstep whenever an agent is added.
  agentIds: z.array(agentIdSchema).min(2).max(6),
  force: z.boolean().optional(),
  depth: z.enum(['fast', 'deep']).optional(),
})
export type SynthesizeRequest = z.infer<typeof synthesizeRequestSchema>

export const synthesizeResponseSchema = z.object({
  agentIds: z.array(agentIdSchema),
  data: synthesisBriefSchema,
  cached: z.boolean(),
  groupKey: z.string(),
})
export type SynthesizeResponse = z.infer<typeof synthesizeResponseSchema>

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  time: z.string(),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>

export const uploadResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  url: z.string(),
  size: z.number(),
  mimeType: z.string(),
  // PDF-specific (omitted on image uploads)
  thumbnailUrl: z.string().optional(),
  extractedText: z.string().optional(),
  pageCount: z.number().optional(),
  // Font-specific. Server derives from the original filename so the client
  // doesn't have to parse the font binary.
  fontFamily: z.string().optional(),
})

export type UploadResponse = z.infer<typeof uploadResponseSchema>

// Lightweight projection of a single canvas object — enough for a dashboard
// thumbnail (position, size, type, and visual hint like a sticky colour or
// image thumbnail URL) without shipping the full ImageData / TextData
// payloads. Text content is intentionally omitted to avoid leaking
// user-written content into the dashboard.
export const boardPreviewObjectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  type: z.enum([
    'image',
    'sticky',
    'text',
    'pdf',
    'font',
    'drive-file',
    'drive-folder',
    'web-page',
    'spotify-playlist',
    'spotify-track',
    'spotify-album',
    'video-clip',
    'voice-note',
  ]),
  color: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  // For font specimens — family + url so the dashboard can register the
  // FontFace and render the "Aa" badge in the actual uploaded typeface.
  family: z.string().optional(),
  url: z.string().optional(),
  // For external nodes — used by the dashboard to render a small provider
  // chip + title without shipping the full body.
  title: z.string().optional(),
  // For drive files — mime type so the dashboard can render the right glyph.
  mimeType: z.string().optional(),
  // For web pages — favicon + host string for the dashboard chip.
  host: z.string().optional(),
})
export type BoardPreviewObject = z.infer<typeof boardPreviewObjectSchema>

// What the dashboard renders as a board's thumbnail. `bounds` is `null`
// for empty boards (no objects yet) — the renderer falls back to the
// placeholder swatch in that case. `objects` is capped server-side to
// the largest N by area so a 200-image board doesn't dump 200 SVG
// elements per card.
export const boardPreviewSchema = z.object({
  bounds: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  objects: z.array(boardPreviewObjectSchema),
})
export type BoardPreview = z.infer<typeof boardPreviewSchema>

export const boardSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  preview: boardPreviewSchema.optional(),
})
export type BoardSummary = z.infer<typeof boardSummarySchema>

export const boardSummariesResponseSchema = z.object({
  boards: z.array(boardSummarySchema),
})
export type BoardSummariesResponse = z.infer<typeof boardSummariesResponseSchema>

// Wire shape for a stored canvas object. The envelope is validated; `data`
// passes through untouched — parsing it against the per-type union would
// strip fields the union doesn't know about yet.
export const storedCanvasObjectSchema = canvasObjectSchema.extend({
  data: z.record(z.string(), z.unknown()),
})

// `versions` maps object id → server version. The client echoes the version
// back as `baseVersion` on its next write so the server can detect a
// teammate's concurrent edit instead of silently overwriting it.
export const fullBoardSchema = z.object({
  id: z.string(),
  name: z.string(),
  objects: z.array(storedCanvasObjectSchema),
  versions: z.record(z.string(), z.number().int()),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type FullBoard = Omit<z.infer<typeof fullBoardSchema>, 'objects'> & {
  objects: CanvasObject[]
}

export const boardResponseSchema = z.object({ board: fullBoardSchema })
export type BoardResponse = z.infer<typeof boardResponseSchema>

export const createBoardRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
})
export type CreateBoardRequest = z.infer<typeof createBoardRequestSchema>

// ---------------------------------------------------------------------------
// Phase 12 — external connections
// ---------------------------------------------------------------------------

// Summary returned by GET /api/connections — tokens stay server-side; the
// client only sees what's needed to label the connection in the picker.
export const connectionSummarySchema = z.object({
  id: z.string(),
  provider: z.enum(['drive', 'spotify']),
  accountEmail: z.string(),
  workspaceName: z.string().nullable().optional(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable().optional(),
})
export type ConnectionSummary = z.infer<typeof connectionSummarySchema>

export const connectionsListResponseSchema = z.object({
  connections: z.array(connectionSummarySchema),
})

// Uniform tile shape across providers — what the picker drawer renders.
// Optional fields populate per provider: Drive fills `mimeType` +
// `thumbnailUrl`.
// Widened to include 'spotify' so the picker can render the user's own
// playlists. Spotify tiles use `kind: 'page'` since the union is page|
// file|folder and the picker treats kind generically for layout — only
// the drawer's onImport dispatcher needs to special-case Spotify.
export const pickerTileSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  provider: z.enum(['drive', 'spotify']),
  kind: z.enum(['page', 'file', 'folder']),
  title: z.string(),
  iconUrl: z.string().optional(),
  mimeType: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  lastEditedAt: z.string().optional(),
  // Spotify-specific: which Spotify resource this tile imports as. Playlist
  // tiles come from browsing /me/playlists; track tiles come from catalog
  // search. The drawer's onImport dispatches on this. Absent → playlist
  // (back-compat with existing browse tiles).
  spotifyKind: z.enum(['playlist', 'track', 'album']).optional(),
  // Secondary line under the title (e.g. a track's artist · album). Used by
  // Spotify track-search tiles where the title alone is just the song name.
  subtitle: z.string().optional(),
})
export type PickerTile = z.infer<typeof pickerTileSchema>

export const pickerSearchResponseSchema = z.object({
  tiles: z.array(pickerTileSchema),
  nextCursor: z.string().optional(),
})

export const pickerRecentsResponseSchema = z.object({
  tiles: z.array(pickerTileSchema),
})

export const pickerChildrenResponseSchema = z.object({
  tiles: z.array(pickerTileSchema),
})

// Drive import is a discriminated response — files come back as DriveFileData,
// folders as DriveFolderData, and inline content types (PDF, image) come back
// as their existing shape so the client can mount them as PDFNode / ImageNode
// without dedicated Drive variants for those.
export const importDriveResponseSchema = z.object({
  kind: z.enum(['file', 'folder', 'pdf', 'image']),
  data: z.union([driveFileDataSchema, driveFolderDataSchema, pdfDataSchema, imageDataSchema]),
})

// Web import returns the page card data + 0–3 logo images saved to /data/
// uploads. The client mounts the card at the cursor and stacks the logos
// adjacent to it. The /refresh path returns the same shape so a stale card
// can be re-extracted; logo images aren't auto-replaced (they live as their
// own canvas objects after the initial import).
//
// Note: the logo image urls are server-relative `/api/files/...` paths, not
// absolute URLs, so we relax `z.string().url()` to plain `z.string()` here.
// Matches how UploadResponse types url at the boundary — only the runtime
// validator is loosened; the structural type stays ImageData-compatible.
export const importWebResponseSchema = z.object({
  page: webPageDataSchema,
  logoImages: z.array(
    z.object({
      url: z.string(),
      thumbnailUrl: z.string().optional(),
    }),
  ),
})

// Spotify import discriminates by `kind` so a single endpoint serves
// playlists, tracks, and albums. The URL recogniser on the client knows
// which to expect from the pasted URL shape (/playlist/, /track/, /album/);
// the server validates by hitting the right Spotify endpoint and shapes
// the response with matching `kind`.
export const importSpotifyResponseSchema = z.object({
  kind: z.enum(['playlist', 'track', 'album']),
  data: z.union([spotifyPlaylistDataSchema, spotifyTrackDataSchema, spotifyAlbumDataSchema]),
})

// Video import — single shape (no connection, no sub-kinds). The client
// mounts it as a VideoClipNode at the cursor.
export const importVideoResponseSchema = z.object({
  data: videoClipDataSchema,
})

export const updateBoardRequestSchema = z.object({
  name: z.string().min(1).max(120),
})
export type UpdateBoardRequest = z.infer<typeof updateBoardRequestSchema>

// Object-level save. `baseVersion` is the version the client last saw
// (null = the client believes it's creating the object). A write whose
// baseVersion doesn't match the stored version is rejected as a conflict
// and the server's current copy comes back instead.
export const MAX_OBJECT_WRITES = 500
export const saveBoardObjectsRequestSchema = z.object({
  upserts: z
    .array(z.object({ object: storedCanvasObjectSchema, baseVersion: z.number().int().nullable() }))
    .max(MAX_OBJECT_WRITES),
  deletes: z
    .array(z.object({ id: z.string().min(1), baseVersion: z.number().int() }))
    .max(MAX_OBJECT_WRITES),
})
export type SaveBoardObjectsRequest = z.infer<typeof saveBoardObjectsRequestSchema>

export const boardObjectConflictSchema = z.object({
  id: z.string(),
  // null when the object no longer exists on the server.
  object: storedCanvasObjectSchema.nullable(),
  version: z.number().int().nullable(),
})

export const saveBoardObjectsResponseSchema = z.object({
  // New version for every write that applied (deletes are omitted).
  versions: z.record(z.string(), z.number().int()),
  conflicts: z.array(boardObjectConflictSchema),
})
export type SaveBoardObjectsResponse = Omit<
  z.infer<typeof saveBoardObjectsResponseSchema>,
  'conflicts'
> & {
  conflicts: { id: string; object: CanvasObject | null; version: number | null }[]
}

// ---------------------------------------------------------------------------
// Phase 18 — shareable moodboards
// ---------------------------------------------------------------------------

// Discriminated union mirroring SharedAnalysisDisplay in types.ts.
export const sharedAnalysisDisplaySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ad'), data: aiAnalysisSchema }),
  z.object({ kind: z.literal('sectioned'), data: sectionedParagraphsSchema }),
  z.object({ kind: z.literal('video'), data: videoEditorBreakdownSchema }),
  z.object({ kind: z.literal('brief'), data: synthesisBriefSchema }),
])

export const sharedGroupSnapshotSchema = z.object({
  key: z.string(),
  objectIds: z.array(z.string()),
  bounds: z.object({
    left: z.number(),
    top: z.number(),
    right: z.number(),
    bottom: z.number(),
  }),
  palette: z.array(z.string()),
  display: sharedAnalysisDisplaySchema.optional(),
  // Back-compat for pre-`display` shares that only carried briefs.
  brief: synthesisBriefSchema.optional(),
})

export const sharedBoardSnapshotSchema = z.object({
  version: z.literal(1),
  boardName: z.string().min(1).max(200),
  capturedAt: z.string(),
  // Reuse the existing canvas-object schema so the snapshot stays
  // structurally identical to what the editor stores.
  objects: z.array(canvasObjectSchema),
  groups: z.array(sharedGroupSnapshotSchema),
})
export type SharedBoardSnapshotInput = z.infer<typeof sharedBoardSnapshotSchema>

export const createShareRequestSchema = z.object({
  snapshot: sharedBoardSnapshotSchema,
})
export type CreateShareRequest = z.infer<typeof createShareRequestSchema>

export const shareViewSchema = z.object({
  token: z.string(),
  boardName: z.string(),
  snapshot: sharedBoardSnapshotSchema,
  capturedAt: z.string(),
  updatedAt: z.string(),
})
export type ShareViewParsed = z.infer<typeof shareViewSchema>

export const shareResponseSchema = z.object({ share: shareViewSchema })
export type ShareResponse = z.infer<typeof shareResponseSchema>

// ---------------------------------------------------------------------------
// Asset walker — pulls every /api/files/<filename> reference out of a
// SharedBoardSnapshot. Used by the share creator to populate the
// assetFilenames allowlist that gates the public share-file route.
// External URLs (Spotify CDN, etc.) pass through unchanged
// — the viewer requests them directly.
// ---------------------------------------------------------------------------

const API_FILES_PREFIX = '/api/files/'

function pushIfApiFile(out: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return
  if (!value.startsWith(API_FILES_PREFIX)) return
  const filename = value.slice(API_FILES_PREFIX.length).split('?')[0]?.split('#')[0]
  if (filename && filename.length > 0) out.add(filename)
}

export function collectAssetFilenames(snapshot: {
  objects: { type: string; data: Record<string, unknown> }[]
}): string[] {
  const out = new Set<string>()
  for (const o of snapshot.objects) {
    const d = o.data
    if (!d || typeof d !== 'object') continue
    // The fields that may carry /api/files URLs across object types:
    //   image.url, image.thumbnailUrl
    //   pdf.url, pdf.thumbnailUrl
    //   font.url
    //   voice-note.url
    //   video-clip.thumbnailUrl
    // Walking every string-valued field is safe — other URLs are
    // external and won't pass the prefix check.
    for (const key of Object.keys(d)) {
      pushIfApiFile(out, (d as Record<string, unknown>)[key])
    }
    // LogoImages on web-page are nested arrays of {url}. Walk one
    // level of arrays-of-objects-with-url for completeness.
    for (const value of Object.values(d)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object') {
            for (const v of Object.values(item)) {
              pushIfApiFile(out, v)
            }
          }
        }
      }
    }
  }
  return Array.from(out).sort()
}
