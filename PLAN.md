# moodboard.ai — Build Plan

An infinite-canvas mood board app with auto-grouping and AI-powered analysis of grouped content (images, sticky notes, text, PDFs).

---

## Tech Stack (locked)

| Layer | Choice |
|---|---|
| Frontend | Vite + React 19 + TypeScript |
| Canvas | Konva.js + react-konva |
| UI | Tailwind + shadcn/ui |
| Animations | Framer Motion (DOM) + Konva Tween (canvas) |
| State | Zustand |
| Backend | Hono on Node.js |
| ORM | Drizzle |
| DB | Postgres (Railway) |
| Auth | better-auth (Phase 4+) |
| AI | Anthropic Claude (Sonnet for depth, Haiku for fast passes) |
| File storage | Railway volume |
| Hosting | Railway (web static service + api service + Postgres + volume) |

**Critical architectural decision:** Hybrid Konva + DOM. Konva renders images, PDF thumbnails, group outlines, pan/zoom. DOM overlays (positioned via canvas transform) handle sticky notes, editable text, widgets, AI panels. This mirrors how Figma works under the hood and avoids fighting Konva.Text for real text editing.

---

## Repo Structure

```
moodboard-ai/
├── apps/
│   ├── web/                 # Vite + React frontend
│   └── api/                 # Hono backend
├── packages/
│   └── shared/              # Shared types + Zod schemas
├── package.json
├── pnpm-workspace.yaml
└── railway.toml
```

Monorepo with pnpm workspaces. Shared types package keeps frontend/backend contracts tight.

---

## Core Data Model

```ts
// packages/shared/src/types.ts

export type CanvasObject = {
  id: string
  type: 'image' | 'sticky' | 'text' | 'pdf'
  position: { x: number; y: number }
  size: { width: number; height: number }
  rotation: number
  zIndex: number
  data: ImageData | StickyData | TextData | PDFData
}

export type ImageData = { url: string; thumbnailUrl?: string }
export type StickyData = { text: string; color: string }
export type TextData = { text: string; font: string; fontSize: number }
export type PDFData = { url: string; thumbnailUrl: string; extractedText: string }

export type Group = {
  id: string
  objectIds: string[]
  boundingBox: { x: number; y: number; w: number; h: number }
  analysis?: AIAnalysis
  analysisHash?: string   // for cache invalidation
}

export type AIAnalysis = {
  mood: string
  tone: string
  palette: string[]       // hex colors
  adjectives: string[]
  themes: string[]
  summary: string
}

export type Board = {
  id: string
  userId: string | null   // null until Phase 4
  name: string
  objects: CanvasObject[]
  groups: Group[]
  createdAt: string
  updatedAt: string
}
```

---

## User Interaction Spec (MVP)

This is the behavioural backbone. The grouping rules and visual feedback here are what make the app *feel* right — get this layer correct before anything else.

### Canvas Interactions

**Pan**
- Hold `Space` + drag with left mouse
- Or two-finger trackpad pan
- Or middle-mouse drag

**Zoom**
- Scroll wheel zooms focused on the cursor position (not centre)
- Clamped 0.1× – 4×
- `Cmd/Ctrl + 0` resets to 100%

**Selection**
- Click an item → selects it; resize handles appear
- Click empty canvas → deselects
- `Shift + click` → multi-select
- `Escape` → deselect all
- Groups are **not directly selectable** — they're derived from item positions. You select items; groups follow.

**Object manipulation**
- Drag to move (works selected or not)
- Drag corner handles to resize (aspect locked for images & PDFs, free for stickies)
- `Delete` / `Backspace` removes selected items
- No rotation in MVP — keep it tight

### Object Creation

- **Drag** image files from desktop → uploaded, placed at drop point
- **Paste** image from clipboard → placed at last cursor position
- **Toolbar buttons** (`+ Image`, `+ Sticky`, `+ Text`) → placed at canvas centre of current view

---

### Grouping Rules — The Core Mechanic

**When are two items in the same group?**

→ Two items belong to the same group when their bounding boxes are **within 24px of each other in world space**.

That is:
- Overlapping → grouped
- Edges touching → grouped
- Within 24px gap → grouped
- More than 24px apart → not grouped (with each other)

**Group computation:**
- Build a proximity graph: nodes = items, edges = pairs within 24px
- Connected components in that graph = groups
- A group requires **2+ items**; isolated items are not groups

**Live during drag:**
- As an item is dragged, recompute grouping continuously (throttled ~30Hz)
- When the dragged item enters proximity of another item / existing group:
  - Both target items / the group outline get a subtle accent glow
  - Preview group outline fades in immediately (so the user sees what's about to happen)
- On drop: outline commits its final shape with a small settle animation (scale 0.97 → 1, 180ms)

**Leaving / dissolving a group:**
- Drag an item out → if it now falls beyond 24px from every other group member, it leaves the group
- If a group drops below 2 items, the group dissolves (outline fades out, palette + AI panel disappear)

---

### What Gets Outlined

**One padded bounding rectangle around all items in a group.** Not individual outlines on each item.

- Padding: **20px in world space** (hugs but doesn't crowd)
- Border: 1.5px solid in accent colour (`#7B5CFF` placeholder, theme later)
- Background fill: `rgba(123, 92, 255, 0.03)` — barely-there tint
- Corner radius: 12px
- Drawn on a layer **behind** items so items sit visually inside the group
- Animates smoothly as items move (interpolated bounding box, not snapped per frame)

**Entry animation:** opacity 0 → 1 + scale 0.97 → 1, 200ms ease-out
**Exit animation:** opacity 1 → 0, 150ms ease-in

---

### Colour Palette Widget

- **Appears immediately on group formation** — no API call, client-side via `node-vibrant`
- **Position:** top-right corner of group bounding box, offset 8px outside
- **Layout:** 5 swatches in a horizontal row, each 28×28px, 6px corner radius
- **Interaction:** click a swatch → copy hex to clipboard, toast confirms `Copied #XXXXXX`
- **Updates within 100ms** when group composition changes (item added/removed)
- For groups with no images (stickies/text only): palette derived from sticky note colours

---

### AI Analysis Panel

- **Trigger:** 800ms after group "settles" (no dragend events within that window)
- **Position:** below group bounding box, centred, 16px gap
- **Width:** matches group bounding box width, capped at 480px
- **States:**
  - **Loading** — skeleton with placeholder bars for mood / tone / adjectives
  - **Loaded** — mood (1 line), tone (1 line), adjectives (chips), themes (chips), summary (2-3 sentence paragraph)
  - **Error** — inline message with retry button
- **Re-analyze button** (bottom-right of panel) → forces cache miss
- **Auto-dismiss:** if group dissolves, panel fades out

---

### Per-Object Behaviour

| Object | Default size | Resize | Edit | Notes |
|---|---|---|---|---|
| **Image** | 400px longest side | Corner handles, aspect locked | n/a | Min 80px, max 1200px |
| **Sticky** | 200×200 | Corner handles, free aspect | Click → contentEditable | 6 colour presets |
| **Text** | Auto-sizes to content | Width handle only | Click → contentEditable | Sizes: 12/16/18/24/32/48 |
| **PDF** | 240×320 (A4 ratio) | Corner handles, aspect locked | Click → modal preview | PDF badge bottom-left |

---

### Chrome / Fixed UI

**Top-center floating toolbar:**
- `+ Image` (opens file picker)
- `+ Sticky`
- `+ Text`
- `+ PDF` (Phase 6)

**Bottom-right zoom cluster:**
- Zoom out `−`
- Current zoom % (click → reset to 100%)
- Zoom in `+`
- Fit-all icon

**Top-left:** Board name (inline-editable) + breadcrumb to dashboard (Phase 4+)

---

### Empty State

When a board has no objects:
- Subtle dotted background grid (8px grid, very low opacity)
- Centred hint text: *"Drop images here, paste from clipboard, or use the toolbar to add"*
- Toolbar visible with a soft pulse on the `+ Image` button

---

### Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Pan canvas | Hold `Space` + drag |
| Zoom in/out | Scroll, or `Cmd +` / `Cmd −` |
| Reset zoom | `Cmd 0` |
| Fit all to view | `Cmd 1` |
| Delete | `Delete` / `Backspace` |
| Multi-select | `Shift + click` |
| Deselect all | `Escape` |
| Undo / Redo | `Cmd Z` / `Cmd Shift Z` |
| Copy / Paste | `Cmd C` / `Cmd V` |

---

### Component Inventory

**Konva (canvas layer):**
- `<MoodBoardCanvas>` — Stage wrapper, owns pan/zoom + event routing
- `<ImageNode>` — Konva.Image + Transformer
- `<PDFNode>` — Konva.Image showing thumbnail + badge (Phase 6)
- `<GroupOutline>` — Konva.Rect on a layer beneath items

**DOM overlay layer (positioned via canvas transform):**
- `<CanvasOverlayLayer>` — container that tracks `{ scale, x, y }`
- `<StickyNote>` — contentEditable + colour picker
- `<TextObject>` — contentEditable + size picker
- `<ColorPaletteWidget>` — pinned to group, top-right
- `<AIAnalysisPanel>` — pinned to group, below

**Fixed chrome:**
- `<Toolbar>` — top-center
- `<ZoomControls>` — bottom-right
- `<BoardHeader>` — top-left (board name + breadcrumb)

---

## Animation & Motion

The whole product should feel **snappy and physical** — like things have weight and respond to forces. Not smooth, not floaty. *Snap.*

### The Snap Curve

Default easing for major interactions is a **snap with anticipation**:
- Slight pull-back at the start (0 → −0.05) — builds tension
- Slow buildup through the first 40-50% of duration
- Sharp acceleration through 50-90%
- Small overshoot (1.0 → 1.04) → settle to 1.0

It mimics how a magnet pulls a fridge magnet across the last half-inch of distance — slow approach, *thunk*, slight rebound, set.

```ts
// CSS / Framer Motion cubic-bezier
export const SNAP_CURVE = [0.7, -0.05, 0.2, 1.05]

// Framer Motion spring (more physical, recommended)
export const SNAP_SPRING = {
  type: 'spring',
  stiffness: 700,
  damping: 22,
  mass: 0.6,
}
```

---

### Specific Animations

**Group outline appears** — the money moment
- Total duration: ~280ms
- Phase 1 (0–60ms): scale 1.0 → 0.97, opacity 0 → 0.2 — *anticipation, outline pulls in*
- Phase 2 (60–200ms): scale 0.97 → 1.03, opacity 0.2 → 1 — *snap*
- Phase 3 (200–280ms): scale 1.03 → 1.0 — *settle*
- Feels like: two pieces clicking together magnetically

**Group outline updates** (items added/removed, reshape)
- Bounding box position + size interpolate over 200ms with `cubic-bezier(0.3, 0, 0.2, 1)` — quicker, no anticipation
- Don't anticipate every update; only the initial appearance gets the full snap

**Group outline dissolves**
- Duration: 180ms
- scale 1.0 → 0.96 (shrink), opacity 1 → 0
- Linear-to-ease-in, no overshoot — it's leaving, not arriving

**Colour palette widget appears**
- Starts 50ms after group outline begins
- Each of the 5 swatches staggered by 30ms (full stagger = 120ms)
- Per swatch: scale 0.6 → 1.05 → 1.0, opacity 0 → 1, 220ms with snap curve
- Feels like: palette unfolding sideways out of the group

**Object drop into group**
- The dropped item itself: scale 1.0 → 0.96 (compress) → 1.02 (rebound) → 1.0, 200ms
- Synced with the group outline appearance so the whole event reads as one beat
- Feels like: a click, a satisfying *thunk*

**Proximity hint** (while dragging near another item)
- Target items pulse: scale 1.0 → 1.015 → 1.0, looping every 1200ms, ease-in-out
- Soft glow appears via `box-shadow` or Konva blur, 0 → 4px over 200ms, stays while in range
- Feels like: gravity pulling, magnets recognising each other

**AI panel reveal** — restrained, informational, not snappy
- Slide up + fade: `y: 12px → 0`, opacity 0 → 1
- Duration: 240ms, `cubic-bezier(0.2, 0.8, 0.2, 1)` (standard ease-out)
- Inner chips/summary staggered 40ms apart
- Feels like: a card sliding into place, not a thunk

**Toolbar button press**
- Scale 1.0 → 0.94 → 1.0, 120ms
- Tactile micro-feedback

**Toast confirm** ("Copied #7B5CFF")
- Slide down + fade in (top of viewport): `y: -8px → 0`, opacity 0 → 1, 180ms
- Holds 1.5s
- Slide up + fade out, 200ms

**Zoom**
- Wheel zoom: instant, no transition (input feedback must be 1:1)
- Cmd+0 reset: 250ms, `cubic-bezier(0.4, 0, 0.2, 1)` standard
- Fit-all: 350ms, snap curve (deliberate gesture)

---

### Implementation Notes

**Framer Motion** for DOM overlays:
```tsx
<motion.div
  initial={{ scale: 0.97, opacity: 0 }}
  animate={{ scale: 1, opacity: 1 }}
  transition={SNAP_SPRING}
/>
```

**Konva tweens** for canvas-side animations (the group outline rect):
Konva's built-in easings don't include anticipation. Two options:

1. Custom easing function:
```ts
const snapWithAnticipation = (t: number, b: number, c: number, d: number) => {
  const x = t / d
  if (x < 0.2) return b + c * (-0.25 * x)              // pull back
  const x2 = (x - 0.2) / 0.8
  return b - 0.05 * c + c * (1.05 - Math.pow(1 - x2, 4)) // snap + overshoot
}
```

2. **Recommended:** render the group outline as a `<motion.div>` positioned over the Konva canvas using `worldToScreen`, and let Framer handle the animation. Konva.Rect stays for hit detection / z-ordering. Often simpler than wrestling with Konva tweens.

---

### Don'ts

- **Don't use `ease-in-out` anywhere it matters.** It's the smooth-floaty default that makes products feel cheap.
- **Don't tween things that should feel instant** — selection state, hover highlights, drag follow.
- **Don't anticipate every animation.** Overuse kills the punch. Reserve full snap+anticipation for: group form, palette appear, drop-into-group. Everything else is gentler or instant.
- **Don't sync everything to the same duration.** Variation (120ms button press, 180ms toast, 280ms group form) gives the interface rhythm.

---

## Phased Build Plan

### Phase 0 — Scaffold (½ day)

**Goal:** Working dev environment.

- [ ] `pnpm init` monorepo with workspaces
- [ ] `apps/web`: Vite + React + TS + Tailwind + shadcn/ui + Framer Motion
- [ ] `apps/api`: Hono + tsx + Zod
- [ ] `packages/shared`: types package, both apps consume it
- [ ] `railway.toml` with two services
- [ ] `.env.example` for each app
- [ ] Health check on api (`GET /health`)
- [ ] Frontend talks to api in dev via Vite proxy

---

### Phase 1 — Canvas Foundation (~2 days)

**Goal:** Drop images on an infinite canvas. Pan, zoom, persist.

- [ ] Konva + react-konva installed
- [ ] `<MoodBoardCanvas>` with Stage + Layer
- [ ] Pan: space-held drag or middle-mouse
- [ ] Zoom: scroll-wheel, clamp 0.1×–4×
- [ ] Image drop: drag-drop files → `POST /api/upload` (multipart) → server saves to `/data/uploads/{uuid}.{ext}` → returns URL
- [ ] Paste from clipboard: `navigator.clipboard.read()` for image blobs
- [ ] Cross-origin URL paste: backend `GET /api/proxy?url=` fetches + streams (with allowlist + size limit)
- [ ] Image served via `GET /api/files/:id` streaming from volume
- [ ] Zustand store for canvas state
- [ ] localStorage persistence, debounced 500ms

**Deliverable:** Drop images on a canvas, pan/zoom, refresh and they're still there.

---

### Phase 2 — DOM Overlays + Sticky Notes + Text (~3 days)

**Goal:** The hybrid system. Sticky notes and text that snap into the world.

- [ ] `worldToScreen({x, y}, stageScale, stageOffset)` and `screenToWorld()` utilities
- [ ] `<CanvasOverlayLayer>`: absolutely positioned div container that tracks Stage transform
- [ ] Zustand slice for `{ scale, offset }`, updated on Stage `dragmove` / `wheel`
- [ ] `<StickyNote>`: contentEditable div, color picker, drag handle, registers as a CanvasObject
- [ ] `<TextObject>`: contentEditable, font + size controls
- [ ] Both types appear in the same overlap detection in later phases
- [ ] Toolbar (top-left or floating): add sticky, add text, clear board

**Deliverable:** Drop images, add sticky notes, add text. All draggable. All persistent.

---

### Phase 3 — Overlap Detection → Groups → Color Palette (~3 days)

**Goal:** The "wow" feature. Drag objects together → group forms → palette appears.

- [ ] AABB overlap math (rotation: expand to rotated AABB, or full SAT if rotation is heavy)
- [ ] On `dragend` of any object: run pairwise overlap check (naive O(n²) is fine <100 objects)
- [ ] Union-find to merge overlapping pairs into groups
- [ ] Group state in Zustand, separate from objects; objects reference groupId
- [ ] Group outline: Konva.Rect on a top layer, dashed stroke, Framer-Motion-style ease-in
- [ ] `node-vibrant` client-side: extract top 5 colors from grouped images
- [ ] `<ColorPaletteWidget>`: DOM overlay pinned to group bounding box top-right, animates in
- [ ] Click a swatch → copy hex to clipboard
- [ ] Removing an object from a group → recompute, possibly dissolve group

**Deliverable:** The magic moment. Drag two images together and watch it happen.

---

### Phase 4 — Backend Persistence + Auth + Multi-board Dashboard (~4 days)

**Goal:** Real accounts, real persistence, board management.

- [ ] Postgres on Railway
- [ ] Drizzle schema: `users`, `boards`, `assets` (file metadata)
- [ ] better-auth integration. Start with Google OAuth (lowest friction) + email magic link
- [ ] Migrate Zustand persistence from localStorage to backend autosave (debounced 2s, optimistic writes)
- [ ] REST API:
  - `GET /api/boards` — list user's boards
  - `POST /api/boards` — create
  - `GET /api/boards/:id` — load
  - `PATCH /api/boards/:id` — save (full state or JSON Patch)
  - `DELETE /api/boards/:id`
- [ ] Routes: `/` = dashboard grid, `/board/:id` = canvas
- [ ] Dashboard: thumbnails (first-image or generated snapshot), name, last-edited, "new board" CTA
- [ ] Migrate any localStorage-only board on first login (one-time prompt)

**Deliverable:** Sign in. See your boards. Open one. Edit. It autosaves.

---

### Phase 5 — Claude AI Analysis (~2 days)

**Goal:** Real intelligence on grouped content.

- [ ] Endpoint: `POST /api/boards/:id/groups/:groupId/analyze`
- [ ] Server pulls the group's objects, builds a multi-modal Claude message:
  - Image blocks for images + PDF thumbnails
  - Text blocks for sticky text + text objects + extracted PDF text
- [ ] System prompt asks for strict JSON: `{ mood, tone, palette, adjectives, themes, summary }`
- [ ] Validate with Zod; retry once on parse failure
- [ ] Cache: hash the group's content (object IDs + their text/image URLs) → store result; skip API call if hash unchanged
- [ ] Debounce 800ms after the group settles before firing
- [ ] `<AIAnalysisPanel>`: floating card pinned to group, animated reveal
- [ ] Loading skeleton during request
- [ ] Manual "re-analyze" button overrides cache

**Deliverable:** Group some images and stickies → panel appears with mood, adjectives, themes, summary.

---

### Phase 6 — PDF Support (~2 days)

**Goal:** Drop PDFs onto the board, AI reads them.

- [ ] Upload endpoint accepts `application/pdf`
- [ ] Server-side text extraction with `unpdf` (lighter than pdf-parse, modern API)
- [ ] Server-side first-page thumbnail with `pdfjs-dist` (headless) → PNG saved to volume
- [ ] Return `{ pdfUrl, thumbnailUrl, extractedText }`
- [ ] PDF object on canvas = Konva.Image showing thumbnail with a small PDF badge
- [ ] Click PDF → modal preview using `pdfjs-dist` (lazy-loaded, ~600KB chunk)
- [ ] AI analysis automatically includes `extractedText` for PDFs in a group

**Deliverable:** Drop a PDF. See it. Group it with images. AI synthesizes everything.

---

### Phase 7 — Polish + Production (~3 days)

- [ ] Animations: image-drop scale-from-cursor + opacity (200ms ease-out); group outline fade-in; widget reveal stagger
- [ ] Keyboard shortcuts: delete, cmd-z/cmd-shift-z (history stack), cmd-c/cmd-v, escape to deselect, space to pan
- [ ] Undo/redo with a bounded history stack in Zustand
- [ ] Empty state on dashboard
- [ ] Error boundaries
- [ ] Loading states everywhere
- [ ] Rate limit AI endpoint (per user, per minute)
- [ ] Image size + format validation (max 10MB, jpg/png/webp/gif)
- [ ] PDF size limit (max 20MB, 50 pages)
- [ ] Sentry for errors
- [ ] PostHog for analytics
- [ ] Meta tags + OG image on landing

**Deliverable:** Production-ready.

---

## Implementation Notes

### Canvas transform tracking

Subscribe to Konva Stage's `dragmove` and `wheel` events. Push `{ scale, x, y }` to a Zustand slice. DOM overlay components read this slice and apply `transform: translate(...) scale(...)` to track the canvas. Updates are cheap because Zustand selectors are granular.

### Overlap detection performance

For <100 objects, naive O(n²) pairwise on `dragend` is fine. If users build huge boards, drop in `rbush` spatial index. Don't optimize prematurely.

### AI cost control

Hash the group's content (sorted object IDs + content hashes + a model version tag) and cache results in Postgres. Re-analyze only when the hash changes or the user explicitly clicks re-analyze. Consider Haiku for live updates and Sonnet for a "deep analyze" button.

### Image storage on Railway volume

```
/data/uploads/{uuid}.{ext}
/data/thumbnails/{uuid}.webp
/data/pdfs/{uuid}.pdf
/data/pdf-thumbs/{uuid}.png
```

Volume mounted at `/data` on the api service. Served via streaming `GET /api/files/:id` so you can add auth checks later. **Caveat:** Railway volumes don't replicate. Migrate to object storage if/when you scale horizontally — not a now-problem.

### Editable text on canvas

Always DOM overlays positioned via canvas transform. Konva.Text is read-only-grade for interactive editing. Real contentEditable gives you IME, spellcheck, paste, autocomplete for free.

### Don't

- Don't store binary data in Postgres
- Don't use Konva.Text for editable content
- Don't run pdf.js on the main thread for extraction (server-side or web worker)
- Don't skip the cache on AI calls (you will burn money fast)
- Don't fight the canvas library for custom widgets — use React Portals in screen space

---

## Phase-by-Phase Working Agreement

Ship one phase, play with it, then start the next. Resist running ahead — the magic is in feeling each layer before adding the next. After each phase, stop and wait for explicit confirmation before moving on.
