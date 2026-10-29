import type { AgentId } from '@moodboard/shared'
import { GEMINI_VIDEO_MODEL } from './gemini'

// Sonnet by default — the quality lift over Haiku is worth the 3× cost,
// and the content-hash cache makes repeat reads free.
export const FAST_MODEL = 'claude-haiku-4-5'
export const DEEP_MODEL = 'claude-sonnet-4-6'
export type AnalysisDepth = 'fast' | 'deep'
export const DEFAULT_DEPTH: AnalysisDepth = 'deep'

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
