# moodboard.ai

Infinite-canvas mood board. Drop images, sticky notes, text, and PDFs on a canvas — when two or more items come within 24 px of each other in world space they auto-group, a coloured outline draws around them, a palette widget extracts the colours, and Claude reads the group as a brand brief.

The "feel" of items snapping into a group is the whole product.

---

## Stack

| Layer            | Choice                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Frontend         | Vite + React 19 + TypeScript                                                                                                |
| Canvas           | Konva.js + react-konva (images, group outlines, pan/zoom); DOM overlays (sticky notes, editable text, widgets, AI panels)   |
| UI               | Tailwind + shadcn/ui (dark, flat OKLCH theme)                                                                               |
| Animation        | Framer Motion (DOM) + Konva tween (canvas)                                                                                  |
| State            | Zustand                                                                                                                     |
| Backend          | Hono on Node.js                                                                                                             |
| ORM              | Drizzle                                                                                                                     |
| DB               | Postgres (Railway in prod, docker-compose locally)                                                                          |
| Auth             | better-auth                                                                                                                 |
| AI               | Anthropic Claude — `claude-sonnet-4-6` for depth, `claude-haiku-4-5` for fast passes                                        |
| File storage     | Railway volume mounted at `/data` (uploads, thumbnails, PDFs). Never binary in Postgres.                                    |
| Package manager  | pnpm. Always pnpm.                                                                                                          |

These are locked decisions. See `CLAUDE.md` for why.

---

## Repo layout

```
moodboard/
├── apps/
│   ├── web/                     # Vite + React frontend
│   └── api/                     # Hono backend
├── packages/
│   └── shared/                  # Shared types + Zod schemas — both apps import from here
├── CLAUDE.md                    # Operational rules (read this before changing canvas / AI code)
├── PLAN.md                      # Phased build plan
└── pnpm-workspace.yaml
```

Monorepo via pnpm workspaces. **Types and Zod schemas live in `packages/shared` only.** Both `apps/web` and `apps/api` import from `@moodboard/shared`. Never duplicate a type between them.

---

## Getting started

### Prerequisites

- Node ≥ 20
- pnpm ≥ 9
- Postgres (or Docker for the bundled docker-compose setup)
- An Anthropic API key (for AI analysis — the app boots without it, but `/analyze` returns 503)

### Install

```bash
pnpm install
```

### Environment

Copy the example env files and fill in the real values:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env   # currently empty — no client-side envvars
```

`apps/api/.env` needs:

| Key                  | What it is                                                                              |
| -------------------- | --------------------------------------------------------------------------------------- |
| `PORT`               | API port (default 3001).                                                                |
| `NODE_ENV`           | `development` locally.                                                                  |
| `DATABASE_URL`       | Postgres connection string. The example points at docker-compose's local Postgres.      |
| `AUTH_SECRET`        | Random 32+ char string for better-auth session signing. Generate with `openssl rand -hex 32`. |
| `BETTER_AUTH_URL`    | Base URL for auth callbacks (e.g. `http://localhost:3001`).                             |
| `ANTHROPIC_API_KEY`  | `sk-ant-api03-…` — required for AI analysis only. The rest of the app works without it. |

**Never commit `.env`.** It's in `.gitignore`; verify with `git check-ignore -v apps/api/.env` before any commit. The `.env.example` files document every key with placeholder values only.

### Database

Run Drizzle migrations:

```bash
pnpm --filter @moodboard/api db:push    # if defined; otherwise: pnpm --filter @moodboard/api exec drizzle-kit push
```

### Dev

```bash
pnpm dev
```

This runs `apps/web` (Vite dev server) and `apps/api` (Hono with hot reload) in parallel.

- Web: `http://localhost:5173`
- API: `http://localhost:3001`

---

## Available commands

| Command              | What it does                                                       |
| -------------------- | ------------------------------------------------------------------ |
| `pnpm dev`           | Run web + api in parallel with hot reload.                         |
| `pnpm build`         | Build both apps for production.                                    |
| `pnpm typecheck`     | Strict `tsc --noEmit` across every workspace package.              |
| `pnpm test`          | Vitest across every workspace package.                             |
| `pnpm format`        | Auto-fix all formatting with Prettier.                             |
| `pnpm format:check`  | Verify formatting without changing files (used in CI).             |

There is no ESLint or Biome. **Prettier is the lint; `tsc --strict` is the correctness checker.** Style is enforced by formatter, not by linter rules.

---

## How it works — load-bearing decisions

### Hybrid Konva + DOM rendering

- **Konva renders:** images, PDF thumbnails, group outlines, pan/zoom transform, hit detection.
- **DOM overlays render:** sticky notes, editable text, palette widget, AI analysis panel, toolbar.
- Overlays are absolutely positioned and tracked to the canvas via `worldToScreen({x, y}, {scale, offsetX, offsetY})` driven by a Zustand slice that subscribes to Stage `dragmove` / `wheel`.

Why: Konva.Text is read-only-grade. Real `contentEditable` gives IME, spellcheck, paste, autocomplete for free. We never use Konva.Text for anything editable.

### Auto-grouping — the 24-px world-space rule

Two items belong to the same group when their bounding boxes are within **24 px in world space** — overlapping, touching, or with a gap ≤ 24 px all count.

- Group computation: build a proximity graph (nodes = items, edges = pairs within 24 px), then connected components = groups.
- A group requires **≥ 2 items**. Isolated items are not groups.
- Live during drag: recompute throttled to ~30 Hz. Preview outline appears the moment proximity is entered.
- An item dropping below 24 px to all other members leaves the group; a group dropping below 2 items dissolves.

### Group outline visuals (canonical)

20 px world-space padding, 12 px corner radius, 1.5 px solid stroke in the accent colour, faint tinted background fill. Rendered on a layer behind the items.

### Analysis cache (mandatory — burns money otherwise)

- Cache key = stable hash of `(sorted object IDs + per-object content hash + model version tag)`.
- Stored in Postgres.
- Claude is only called when the hash misses or the user explicitly clicks re-run (the play button after a result).
- Each agent caches under its own `modelTag(agentId, depth)`.
- The synthesizer caches under `synthesisModelTag(sortedAgentIds, depth)` so different agent combinations get distinct cache buckets. Cache version is bumped (`v1` → `v2` → …) whenever the output shape changes.

### File storage

- Files live on the Railway volume at `/data/{uploads,thumbnails,pdfs,pdf-thumbs}/`.
- Served via `GET /api/files/:id` streaming so auth can be added later without a URL migration.
- **Never store binary data in Postgres.** Metadata only.

### PDF processing

- Extraction (`unpdf`) and thumbnailing (`pdfjs-dist` headless) happen **server-side**, never on the main browser thread.
- Preview modal lazy-loads `pdfjs-dist` (~600 KB chunk) only on demand.

---

## The agents

Five specialist agents read the moodboard, each with a hand-tuned prompt + JSON schema:

| Agent              | Output                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Art Director       | Headline, summary, mood, tone, palette (hex), adjectives, typographic voice, references, tensions, risks, hooks/statements/tropes from the text content. |
| Business Analyst   | Business model, brand, niche, target audience, industry — five sectioned paragraphs.            |
| Audience Profiler  | Three audience segments with demographic, psychographic, and behavioural specificity.           |
| Channel Strategist | 4–6 channels (named specifically — "Substack newsletter", not "social media") with rationale + success metric. |
| Copywriter         | Taglines, hero headlines, body copy paragraph, CTAs — written in the implied brand voice.       |

A **Synthesizer** takes any 2+ agent outputs and produces a structured brief — palette swatches with role and note, typography samples at scale, audience cards, channel plays, hooks as pull-quotes, tensions, watch-fors. The brief renders as a presentation, not a memo. See `apps/api/src/lib/agents.ts` for prompts; see `apps/web/src/components/canvas/AIAnalysisPanel.tsx` for the renderer.

### Adding a new agent

Five-edit path for a basic agent (uses sectioned paragraphs):

1. `packages/shared/src/types.ts` — add the ID to `AgentId`.
2. `packages/shared/src/schemas.ts` — add it to `agentIdSchema`.
3. `apps/api/src/lib/agents.ts` — register in `AGENTS` with id, label, jsonSchema, outputSchema, maxTokens, systemPrompt.
4. `apps/web/src/components/canvas/AgentRow.tsx` — add to `AGENT_META` (label + Phosphor icon) and `AGENT_ORDER`.
5. `apps/web/src/components/canvas/GroupsLayer.tsx` — add to `EMPTY_SLOTS`.

If the agent should also contribute a dedicated block to the synthesis brief, additionally:

6. Extend `SynthesisBrief` in `packages/shared/src/types.ts` (and the **contributor map comment** at the top — single source of truth for who owns what).
7. Extend `synthesisBriefSchema` in `packages/shared/src/schemas.ts`.
8. Extend `SYNTHESIS_JSON_SCHEMA` and the SYNTHESIZER prompt in `apps/api/src/lib/agents.ts`.
9. Bump `synthesisModelTag` version in `apps/api/src/lib/analyze.ts` (forces a fresh synth — old cache entries served the old shape).
10. Add a render block in `apps/web/src/components/canvas/AIAnalysisPanel.tsx` and slot it into `BriefReadout` in the order you want.

---

## Animation tokens (canonical)

```ts
// "Snap with anticipation" — group-form, drop-into-group, palette appear
export const SNAP_CURVE = [0.7, -0.05, 0.2, 1.05] as const
export const SNAP_SPRING = { type: 'spring', stiffness: 700, damping: 22, mass: 0.6 } as const

// Standard ease-out — AI panel reveal, anything that should land calmly
export const EASE_OUT_STANDARD = [0.2, 0.8, 0.2, 1] as const

// Quick — group outline updates after the first appear
export const EASE_OUT_QUICK = [0.3, 0, 0.2, 1] as const
```

**Don'ts:**

- No `ease-in-out` anywhere it matters. That's the smooth-floaty default that makes products feel cheap.
- No tweening on selection, hover, drag-follow, wheel zoom — those must be 1:1 with input.
- Don't anticipate every animation. Full snap+anticipation is reserved for group-form, palette-appear, drop-into-group.

---

## Code conventions

- **TypeScript strict.** No `any` without a comment explaining why.
- **Shared types lives in `packages/shared` only.** Never duplicate between web and api.
- **No comments unless the _why_ is non-obvious.** Identifiers do the rest.
- **No premature abstractions.** Three similar lines beats a clever generic.
- **No backwards-compat shims, no `_unused` placeholders, no removed-code comments.** Delete it.

See `CLAUDE.md` for the full set.

---

## Testing

Vitest covers the deterministic logic — the interaction layer is tested manually phase by phase. Covered at minimum:

- `proximityGroups(objects, threshold = 24)` — including boundary cases (exactly 24 px, overlap, single-item input, crossing the threshold during drag)
- `aabbOverlap`, `aabbDistance` — touching edges, identical rects, far apart
- `worldToScreen` / `screenToWorld` — round-trip identity, edge zoom values (0.1×, 4×)
- `groupBoundingBox` — empty, single, many
- `analysisHash` — stability across reorderings, sensitivity to content changes

Run `pnpm test` before declaring a change complete. Add a unit test before adding a new caller to any canonical math function.

---

## Security notes

- **`.env` is gitignored.** Never commit. Run `git check-ignore -v apps/api/.env` to confirm before any commit if you're worried.
- **`data/` is gitignored** — the Railway volume mount with user-uploaded files.
- Uploads go through allowlist + size validation (`apps/api/src/lib/upload-validation.ts`) and are stored with sanitised filenames (`isSafeFilename`).
- File-serving route streams from disk via lookup-by-id, not user-supplied paths.
- Per-IP rate limits on the analyze route (`apps/api/src/lib/rateLimit.ts`) — Claude calls cost real money.

---

## License

Private. All rights reserved.
