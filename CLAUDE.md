# CLAUDE.md — moodboard.ai

Operational rules for working on this codebase. The product brief and phased plan live in [PLAN.md](PLAN.md). Read both before making non-trivial changes.

---

## What this app is

Infinite-canvas mood board. Users drop images, sticky notes, text, and PDFs onto a canvas. When two or more items come within 48px of each other in world space they auto-group; a coloured outline appears, a palette widget extracts colours, and Claude analyses the group's mood/tone/themes. The "feel" of the grouping moment is the whole product.

---

## Tech stack (locked — do not re-litigate)

- **Frontend:** Vite + React 19 + TypeScript + Tailwind + shadcn/ui
- **Canvas:** Konva.js + react-konva
- **Animation:** Framer Motion (DOM) + Konva tween/custom easing (canvas)
- **State:** Zustand
- **Backend:** Hono on Node.js
- **DB:** Postgres on Railway (via Drizzle)
- **Auth (Phase 4+):** better-auth
- **AI:** Anthropic Claude — `claude-sonnet-4-6` for depth, `claude-haiku-4-5-20251001` for fast passes
- **Files:** Railway volume mounted at `/data`
- **Package manager:** **pnpm only.** Never npm, never yarn.

If you think you need to swap any of these, stop and ask — there's almost always a reason it's locked.

---

## Canonical architecture decisions

These are load-bearing. Don't drift from them without an explicit conversation.

### Hybrid Konva + DOM rendering

- **Konva renders:** images, PDF thumbnails, group outlines, pan/zoom transform, hit detection
- **DOM overlays render:** sticky notes, editable text, palette widget, AI analysis panel, toolbar/chrome
- DOM overlays are absolutely positioned and tracked to the canvas via `worldToScreen({x, y}, {scale, offsetX, offsetY})` driven by a Zustand slice that subscribes to Stage `dragmove` / `wheel`.

### Editable text = DOM contentEditable, never Konva.Text

Konva.Text is read-only-grade. Real `contentEditable` gives IME, spellcheck, paste, autocomplete for free.

### Grouping rule (48px world-space proximity)

- Two items belong to the same group when their bounding boxes are within **48px in world space** — overlapping, touching edges, or with a gap ≤ 48px all count.
- Group computation: build a proximity graph (nodes = items, edges = pairs within 48px), then connected components = groups.
- A group requires **≥ 2 items**. Isolated items are not groups.
- Live during drag: recompute throttled to ~30Hz. Show preview outline immediately when proximity is entered.
- Item drops below 48px to all other group members → leaves the group. Group drops below 2 items → dissolves.

### Group outline visuals (canonical)

- 20px world-space padding around items
- 12px corner radius
- 1.5px solid stroke, accent `#7B5CFF`
- Background fill `rgba(123, 92, 255, 0.03)`
- Rendered on a layer **behind** items

### AI analysis cache (mandatory — burns money otherwise)

- Cache key = stable hash of `(sorted object IDs + per-object content hash + model version tag)`
- Cached results stored in Postgres (in-memory during dev is fine pre-Phase 4)
- Only call Claude when the hash changes or the user clicks "Re-analyze"
- AI call debounced 800ms after the group settles (no `dragend` within window)

### Overlap detection complexity

- Naive O(n²) pairwise check on `dragend` is fine for < 100 objects
- Don't add `rbush` or spatial indexing until profiling shows it's needed

### Team + board storage (Phase 20)

- **One internal team.** Every signed-in user sees and edits every board, asset, share, and group's panel state. `created_by` is attribution, never access control. Personal: OAuth connections, API keys, source recents. Sign-up gated by `ALLOWED_EMAIL_DOMAINS`.
- **Canvas objects are rows** in `board_object` (full `CanvasObject` in `object` jsonb, `type` lifted out, `version` per row). Never reintroduce a whole-board blob write.
- **Writes are versioned.** Clients send the version they last saw; a mismatch is a conflict and the server copy wins (`lib/boardObjects.ts`, `apps/web/src/lib/boardSync.ts`). Server-side appends insert a single row.
- **Pan/zoom is per viewer** (localStorage), not board state.
- **Group panel state** (displayed read, agent row, palette lock) lives in `board_group_display`, keyed by `groupId()`. No browser storage for anything a teammate should see.
- **Migrations:** edit `schema.ts`, `db:generate --name=…`, commit the SQL. The API applies them on start. Never `db:push` a shared database.
- **Rate limits** are Postgres-backed (`lib/rateLimit.ts`) so they hold across instances.

### Agent sidebar (Phase 21)

- **One tool implementation, two transports.** Canvas tools live in `apps/api/src/lib/canvasTools.ts`; `mcpTools.ts` (MCP, takes `boardId`) and the sidebar orchestrator (bound to the open board) both expose `CANVAS_TOOLS`. Never fork a tool per transport.
- **Analysis runs go through `lib/groupAnalysis.ts`** (cache → model → `recordGroupDisplay`) whether triggered by the routes, MCP or the orchestrator.
- **Threads are team-visible**, persisted per turn in Anthropic content-block form (`agent_message.content`); server notices are `is_error` rows, never replayed to the model.
- **Server-originated board writes** reach the open canvas as `{ object, version }` and must be folded into the autosave's synced state (`foldServerObjects`) before `applyRemote` — otherwise they read as local edits or conflicts.
- **The orchestrator's model client is injected** (`agentRoutes(defaultModelClient())`); tests use a fake streaming client. Model is `DEEP_MODEL`.

### Clients, kits, library, Linear (Phase 22)

- **`--kit-*` is a contract.** `kitToCss` (`packages/shared/src/kitCss.ts`) emits fixed variables (`--kit-color-{background,surface,text,primary,accent,on-primary,on-accent}`, `--kit-font-{display,body,mono}` + `-weight`, `--kit-logo`) plus one per palette role / logo. Templates read only these; names only ever get added, never renamed. Documented in that file.
- **Kit versions are immutable.** Edits append a `style_kit_version` (stale `baseVersion` → 409); the kit row only points at its latest. Never update a version in place.
- **Assets have two kinds.** `asset.kind` is the storage directory (`upload`/`pdf`/`pdf-thumb`); `asset.mediaKind` is the library kind. Record every asset through `recordAsset` in `lib/assetLibrary.ts` — never insert into `asset` directly.
- **Library search is Postgres full-text** over the generated `asset.search` column (name + tags + caption); build queries with `buildTsQuery`, never interpolate user text into a tsquery. Captioning (FAST_MODEL) is skipped without `ANTHROPIC_API_KEY`.
- **Linear is manual.** Only picking an issue starts a thread; the one write is a comment posting a _picked_ design back (Phase 24, below). `lib/linear.ts` is pure (fetch injected) and tested with fixture responses. Team/project → client mappings are team-wide; the Linear connection itself is personal (scopes `read,comments:create`; older read-only connections must reconnect to post).
- **Client/kit/asset/Linear agent tools live in `CANVAS_TOOLS`** (bodies in `lib/designTools.ts`) so MCP and the sidebar get them together.

### Design output = HTML (Phase 23+)

Every design the agents produce is a self-contained HTML/CSS document — no PPTX, no PDF export, no image generation, no new rendering libraries. Video is the same HTML on a seekable CSS/WAAPI timeline, captured by Playwright + ffmpeg. See the roadmap in PLAN.md.

- **Templates and outputs are versioned text in Postgres.** `template_version` / `output_version` rows are immutable (HTML + CSS + slot values + pinned kit version); edits append, restores copy forward, stale `baseVersion` → 409. Same rules as kits.
- **The slot contract** (`packages/shared/src/slots.ts`): `data-slot="name"` (lowercase, digits, dashes) on an `<img>` is an image slot (value replaces `src`), on anything else a text slot (value replaces the content). The markup inside is the default; a missing value keeps it; a name may repeat. `data-slot-label` is the label — the HTML is the single source of truth, the `slots` column is a cache. Parse/fill/rename only through these helpers, never ad-hoc regex.
- **Slot values are never markup.** Text is escaped, newlines become `<br>`. Image values must be library files (`/api/files/<name>`, `isSlotImageValue`). Structure lives in the output's HTML, which agents edit directly.
- **Templates read only the fixed `--kit-*` variables** (plus custom properties they define), with motion as CSS keyframes/WAAPI only — no `setTimeout`/rAF. The composer sets `html[data-kit-logo="present|none"]` so a template can swap a logo for a wordmark. `starterTemplates.test.ts` enforces both for the starters.
- **Starter templates are files** in `apps/api/src/templates/<key>/` (`meta.json`, `template.html`, `template.css`, optional `template.js`), synced on boot by key: changed files append a version. Edit the files, not the DB.
- **Compose, don't serve parts.** `lib/compose.ts` builds the one document every surface uses (preview, share, download, board card, frame renderer): template HTML with slots filled, `kitToCss` then template CSS, every `/api/files` reference inlined as a `data:` URI (`lib/inlineAssets.ts`; unresolvable → blank + `X-Missing-Assets`). External `http(s)` kit assets are not fetched.
- **CSP is part of the document.** A `<meta>` policy allows no network (`default-src 'none'`, `img/font/media-src data:`), inline styles, and only the scripts composition put there, by sha256 hash: the template's `js` and, on authenticated `?edit=1` renders, the inline editor. Render routes repeat it as a header plus `frame-ancestors 'self'; sandbox allow-scripts` and `nosniff`. `js` is copied from template versions only — no route accepts it.
- **Previews are sandboxed iframes without `allow-same-origin`** (`components/outputs/OutputFrame.tsx`). The inline editor talks to the app only by `postMessage` (`SLOT_EDIT_MESSAGE` / `SLOT_FOCUS_MESSAGE`); the parent checks `event.source` against its own frames.
- **Output share links** reuse Phase 18's token model (`output_share`, one per output, pinned to a version; "update" moves the pin, keeps the token). `/api/output-shares/:token/*` is the only public surface.

### Output agents (Phase 24)

- **One render pipeline.** `lib/renderFrame.ts` renders a composed document in the shared headless Chromium (`lib/browser.ts`, `CHROMIUM_PATH` or Playwright's build; closed on SIGINT/SIGTERM): fresh context per document, every request aborted, `RENDER_CONCURRENCY` (default 2) documents at once, 20s timeout. A frame is a seek — pause every `document.getAnimations()` and set `currentTime` (default: end state). Phase 25's MP4 renderer steps the same `withDocument` seek; don't build a second renderer. Output frames go through `lib/outputRender.ts`; the end-state frame of a version is its thumbnail, cached at `/data/outputs/<id>@v<n>.png` and served by `GET /api/outputs/:id/thumbnail`.
- **The designer is bounded.** `design_output` (in `CANVAS_TOOLS`) runs `lib/designer.ts`: per variant (max 3, run side by side) a `DEEP_MODEL` tool loop of at most `DESIGNER_MAX_STEPS` (12) turns and `DESIGNER_MAX_RENDERS` (4) renders. It can't finish without a render of its latest version; multi-section formats must `plan_outline` before `create_output`. Hitting a bound returns what it has; a model error fails that variant with the reason, shown on the card. Model client, toolbox (`designToolbox.ts`) and cache are injected — `designer.test.ts` uses fakes.
- **Renders go back as images.** `render_output_frame` returns the PNG as an image block in the tool result so the model critiques what it made. Keep the system prompt and tool list stable (both cached).
- **Designer cache key** (`lib/designHash.ts`): sha256 of brief (whitespace-normalised) + client id + kit id@version + every candidate template id@version + the client's library asset ids + format + variant index + `DESIGNER_MODEL_TAG`. Stored per variant in `design_cache` (a hit whose output was deleted is a miss). `regenerate: true` is the only bypass. Bump the tag's `vN` when the designer prompt or tools change. `design_cache` also caches save-as-template slot proposals (`slot-proposer@FAST_MODEL@vN` + document).
- **Agents edit structure as text.** `update_output_html` is exact find/replace on an output's HTML/CSS (each find unique unless `all`), checked by `lib/docEdits.ts` (no scripts/handlers/document tags/`<style>`/external URLs/`@import`) and saved as a new version. Never let agents write `js`.
- **Post-back is manual.** Only a design run's _picked_ variant (card button or `pick_design_variant` on the user's say-so) can be posted, and only on the user's explicit action or request (`linearPostGate` in `lib/linearPost.ts`; `POST /api/design-runs/:id/linear-comment`, `post_linear_comment`). Never auto-post after a run.
- **Progress is streamed, not stored.** Long tools report through `ToolContext.onProgress` → `tool-progress` SSE events keyed by tool_use id; the finished result is the tool's payload. `design_run` rows hold the brief, variants, pick and post.

### Video (Phase 25)

- **A video is an output whose root has `data-duration` (ms)** in a fixed viewport; `data-poster` (ms) picks its still (default 35%). Motion is CSS `@keyframes` / WAAPI with explicit delays and `animation-fill-mode: both`, finished before the duration — no transitions, no `animation-play-state`, no script timing. Parse it only through `parseVideoDoc` (`packages/shared/src/video.ts`); `starterTemplates.test.ts` enforces the convention, `docEdits` keeps agent edits inside it.
- **One seek, everywhere.** Composition adds `lib/videoTimeline.ts`'s script to video documents (hash-whitelisted by CSP like the editor's): inert until `window.__moodboardTimeline.seek(t)` or a `moodboard:video-seek` postMessage from the parent. The MP4 renderer, thumbnails and the output view's scrubber all use it. Don't build another stepping path.
- **Render limits are enforced in one place** (`videoRenderProblems`): ≤ 1920×1080 pixels (either orientation), ≤ 60 s, ≤ 1800 frames (60 fps → 30 s), fps 30 or 60. The enqueue route, the handler, the agent's edit checks and the UI all use it. Output is silent H.264 yuv420p, BT.709, faststart, via JPEG frames piped to ffmpeg (`lib/renderVideo.ts`); MP4s have their own render pool (`VIDEO_RENDER_CONCURRENCY`) so they never starve frame renders. Files are `<id>@v<n>@<fps>fps.mp4` + `.json` on `/data/outputs/`; downloads support range requests; share links serve the pinned version's MP4.
- **Background jobs go through `render_job`** (`lib/jobs.ts`, worker in `lib/jobRunner.ts`): claim with `FOR UPDATE SKIP LOCKED`, every worker write guarded by `(id, locked_by, status = running)`, heartbeats keep `locked_at` fresh, `requeueStaleJobs` (maintenance tick + worker poll) returns dead workers' jobs, retries up to `max_attempts` unless the handler throws `PermanentJobError`, cancel is a state change the worker notices at its next heartbeat. An identical queued/running job is returned, not duplicated; the queue is capped (`JOB_QUEUE_MAX`). New background work = a new `kind` + handler, not a new loop. Designer runs (Phase 24) still run in-request; moving them onto the queue is a follow-up.
- **Renders never block the agent.** `design_video` / `render_video` enqueue and return the job; the sidebar card follows it (SSE, polling fallback). Don't wait on or poll a job from a tool.
- **The video agent is bounded like the designer** (`lib/videoAgent.ts`: 16 steps, 3 key-frame calls × 4 frames, script before create, a look at the latest version before finish) and cached (`VIDEO_AGENT_MODEL_TAG` — bump `vN` when its prompt or tools change). Model client, toolbox and cache are injected; `videoAgent.test.ts` uses fakes. Clips from the video importer are references/posters only.

### File storage

- Files on Railway volume at `/data/{uploads,thumbnails,pdfs,pdf-thumbs}/`
- Served via `GET /api/files/:id` streaming so we can add auth later
- **Never store binary data in Postgres.** Only file metadata.

### PDF processing

- Extraction (`unpdf`) and thumbnailing (`pdfjs-dist` headless) happen **server-side**, never on the main browser thread
- Preview modal lazy-loads `pdfjs-dist` (~600KB chunk)

### Theming (dark + light)

Two themes, same world. Neutrals tinted at the 285° hue in both, accent retuned per theme so it reads against the surface. Single source of truth: `apps/web/src/index.css`, with token blocks at `:root` (dark default) and `:root[data-theme="light"]`.

- **Bootstrap** — inline script in `index.html` reads `localStorage["moodboard:theme"]` (`'system' | 'light' | 'dark'`) and sets `data-theme` on `<html>` _before_ first paint. No FOUC.
- **Runtime** — `apps/web/src/lib/theme.ts` exposes `useTheme()` returning `{ pref, resolved, setPref }`. Hooks to `(prefers-color-scheme)` so `system` mode tracks the OS live.
- **Shadows are tokens.** Never hardcode `rgba(0,0,0,…)` in a component — read from `--shadow-card`, `--shadow-popover`, `--shadow-modal`, `--shadow-pill`, `--shadow-toast`, `--shadow-drawer`, `--shadow-small`, `--shadow-tight`. Filled discs (swatches, agent avatars) use `var(--shadow-small), var(--swatch-inset)`.
- **Konva can't read CSS vars.** The dot grid caches `--dot-rgb` (raw RGB triple) via `getComputedStyle`, re-reads on `data-theme` attribute change through a `MutationObserver`. Same pattern for any future Konva-rendered colour that should react to theme.

---

## Animation tokens (canonical)

```ts
// Default "snap with anticipation" curve — for group-form, drop-into-group, palette appear
export const SNAP_CURVE = [0.7, -0.05, 0.2, 1.05] as const
export const SNAP_SPRING = { type: 'spring', stiffness: 700, damping: 22, mass: 0.6 } as const

// Standard ease-out — for AI panel reveal, things that should land calmly
export const EASE_OUT_STANDARD = [0.2, 0.8, 0.2, 1] as const

// Quick interpolation — for group outline updates (not initial appear)
export const EASE_OUT_QUICK = [0.3, 0, 0.2, 1] as const
```

Durations: group outline appear 280ms, palette swatch 220ms (30ms stagger), AI panel 240ms, toolbar press 120ms, toast 180ms in / 200ms out, fit-all 350ms, Cmd+0 reset 250ms.

**Don'ts:**

- Don't use `ease-in-out` anywhere it matters. It's the smooth-floaty default that makes products feel cheap.
- Don't tween things that should feel instant (selection, hover, drag follow, wheel zoom).
- Don't anticipate every animation. Reserve full snap+anticipation for group-form, palette-appear, drop-into-group.

---

## Code standards

- **TypeScript:** strict mode on. No `any` without a comment explaining why.
- **Formatting:** Prettier only. No ESLint, no Biome — relying on `tsc` for correctness.
- **Shared types:** all types/Zod schemas in `packages/shared`. Never duplicate type definitions between `apps/web` and `apps/api`. Both apps import from `@moodboard/shared`.
- **No comments unless the _why_ is non-obvious.** Well-named identifiers do the rest.
- **No premature abstractions.** Three similar lines beats a clever generic.
- **No backwards-compat shims, no `_unused` placeholders, no removed-code comments.** Delete it.

---

## Testing (TypeScript strict + Vitest on the math)

The interaction layer is tested manually phase-by-phase. The deterministic logic is unit-tested. Aim to cover at minimum:

- `proximityGroups(objects, threshold = GROUP_PROXIMITY_PX)` — boundary cases: exactly at the threshold gap, overlap, single-item input, dragging an item across the threshold
- `aabbOverlap(rectA, rectB)` and `aabbDistance(rectA, rectB)` — touching edges, identical rects, far apart
- `worldToScreen(point, transform)` and `screenToWorld(point, transform)` — round-trip identity, edge zoom values (0.1×, 4×)
- `groupBoundingBox(objects, padding = 20)` — empty, single, many objects
- `analysisHash(group)` — stability across reorderings, sensitivity to content changes
- `paletteFromImages(urls)` — mock `node-vibrant`, assert top-5 selection logic

Run `pnpm test` before declaring a phase complete. New canonical math gets a unit test before it gets a caller.

---

## Phase discipline

The plan is phased deliberately. **Ship one phase, stop, wait for confirmation.** Each phase has a deliverable in [PLAN.md](PLAN.md); don't expand scope. Don't preemptively wire Phase N+1 features into Phase N code.

When a phase is done:

1. Run `pnpm test` and verify green
2. Confirm the phase deliverable works in the browser
3. Summarise what's done and **explicitly wait** for go-ahead on the next phase

---

## When to use which skill

- **`claude-api`** — Phase 5 and Phase 24+. Anthropic SDK setup, tool use, vision image blocks, prompt caching on system prompts and the image blocks for repeat groups, model selection between Sonnet and Haiku.
- **`design-motion-principles`** — Phase 3 once group outlines exist. Audit the snap-curve feel against Kowalski/Krehel/Tompkins heuristics.
- **`impeccable`** — Phase 7. UI polish pass before production.
- **`security-review`** — Phase 4 before merging auth + upload endpoints. File upload path traversal, allowlist on URL proxy, rate limits.
- **`simplify`** — End of any phase where multiple components were touched.

---

## Anti-patterns to avoid

- Konva.Text for editable content → DOM contentEditable overlay
- Binary data in Postgres → Railway volume
- Skipping the AI cache → burn rate goes nuclear
- Optimising overlap detection prematurely → only `rbush` if profiling shows hot
- `ease-in-out` for the group-form moment → use `SNAP_CURVE`
- Tweening selection/hover/drag-follow → must be 1:1 with input
- `pdfjs-dist` on the main thread → server or worker
- Type drift between web and api → both import from `packages/shared`
- Hardcoded `rgba(0,…)` shadows in a component → use a `--shadow-*` token so light mode adjusts
- Phase creep → finish current phase, ship, then start the next
