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

// External-source nodes — content imported from a connected Notion or Drive
// account. The board owns its snapshot: `markdown` / `excerpt` lives on the
// canvas object itself so the board keeps rendering even if the source moves
// or is deleted. `connectionId` lets the refresh endpoint look up credentials
// to refetch on demand. A stale indicator on the node fires when remote
// `lastEditedAt > fetchedAt`.
export type NotionPageData = {
  connectionId: string
  pageId: string
  workspaceId: string
  title: string
  iconEmoji?: string
  iconUrl?: string
  coverUrl?: string
  // Public Notion URL — used by the "Open in Notion" link.
  url: string
  // The cached extraction. Source of truth for the on-canvas reader + the
  // AD/synthesiser. When the user clicks refresh, this is what gets swapped.
  markdown: string
  fetchedAt: string
  lastEditedAt?: string
}

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

export type CanvasObjectType =
  | 'image'
  | 'sticky'
  | 'text'
  | 'pdf'
  | 'font'
  | 'notion-page'
  | 'drive-file'
  | 'drive-folder'

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
    | NotionPageData
    | DriveFileData
    | DriveFolderData
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
}

// The full set of agent IDs the backend supports. Add new entries here as
// agents come online — the frontend uses this to enumerate the panel rows.
export type AgentId =
  | 'art-director'
  | 'business-analyst'
  | 'audience-profiler'
  | 'channel-strategist'
  | 'copywriter'

// What an agent returns. The Art Director is the historical structured
// shape; everything else returns sectioned paragraphs.
export type AgentOutput =
  | { agentId: 'art-director'; data: AIAnalysis }
  | {
      agentId: 'business-analyst' | 'audience-profiler' | 'channel-strategist' | 'copywriter'
      data: SectionedParagraphs
    }

export type Group = {
  id: string
  objectIds: string[]
  boundingBox: { x: number; y: number; w: number; h: number }
  analysis?: AIAnalysis
  analysisHash?: string
}

export type Board = {
  id: string
  userId: string | null
  name: string
  objects: CanvasObject[]
  groups: Group[]
  createdAt: string
  updatedAt: string
}
