# CLAUDE.md — moodboard.ai

Operational rules for working on this codebase. The product brief and phased plan live in [PLAN.md](PLAN.md). Read both before making non-trivial changes.

---

## What this app is

Infinite-canvas mood board. Users drop images, sticky notes, text, and PDFs onto a canvas. When two or more items come within 24px of each other in world space they auto-group; a coloured outline appears, a palette widget extracts colours, and Claude analyses the group's mood/tone/themes. The "feel" of the grouping moment is the whole product.

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

### Grouping rule (24px world-space proximity)

- Two items belong to the same group when their bounding boxes are within **24px in world space** — overlapping, touching edges, or with a gap ≤ 24px all count.
- Group computation: build a proximity graph (nodes = items, edges = pairs within 24px), then connected components = groups.
- A group requires **≥ 2 items**. Isolated items are not groups.
- Live during drag: recompute throttled to ~30Hz. Show preview outline immediately when proximity is entered.
- Item drops below 24px to all other group members → leaves the group. Group drops below 2 items → dissolves.

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

- `proximityGroups(objects, threshold = 24)` — boundary cases: exactly 24px gap, overlap, single-item input, dragging an item across the threshold
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

- **`claude-api`** — Phase 5. Anthropic SDK setup, prompt caching on system prompts and the image blocks for repeat groups, model selection between Sonnet and Haiku.
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
