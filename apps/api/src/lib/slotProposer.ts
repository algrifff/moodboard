import type Anthropic from '@anthropic-ai/sdk'
import {
  findSlots,
  humanizeSlotName,
  labelSlot,
  markCandidates,
  removeSlot,
  renameSlot,
  SLOT_CANDIDATE_RE,
  SLOT_NAME_RE,
  slotCandidates,
  type ProposedSlot,
  type SlotCandidate,
  type TemplateSlotEdit,
} from '@moodboard/shared'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FAST_MODEL } from './modelTags'
import type { ModelClient } from './orchestrator'

// Save as template: which markers the new template gets, and applying the
// person's edits to them.

// Save as template: applies the editor's marker edits to the output's HTML.
// Candidate refs (`@3`, see slotCandidates) become new markers first, on the
// HTML the proposer saw; then labels, renames and removals by name. Unknown
// names are ignored; a rename onto an existing name merges the two.
export function applySlotEdits(html: string, edits: TemplateSlotEdit[]): string {
  const isCandidate = (e: TemplateSlotEdit) => SLOT_CANDIDATE_RE.test(e.from)
  let out = markCandidates(
    html,
    edits.flatMap((e) =>
      isCandidate(e) && e.to !== null ? [{ ref: e.from, name: e.to, label: e.label }] : [],
    ),
  )
  const named = edits.filter((e) => !isCandidate(e))
  // Labels first, under the old names, then renames/removals.
  for (const e of named) {
    if (e.to !== null && e.label) out = labelSlot(out, e.from, e.label)
  }
  for (const e of named) {
    if (e.to === null) out = removeSlot(out, e.from)
    else if (e.to !== e.from) out = renameSlot(out, e.from, e.to)
  }
  return out
}

// Proposes slot markers for save-as-template, given the document as it will
// be saved (slot values filled in). Without a model it is deterministic —
// the markers the document already has; lib/slotProposer.ts adds a
// FAST_MODEL pass that names them better and marks new candidates.
export type SlotProposer = (doc: { html: string; css: string }) => Promise<ProposedSlot[]>

export const existingMarkers: SlotProposer = async ({ html }) =>
  findSlots(html).map((m) => ({
    from: m.name,
    name: m.name,
    kind: m.kind,
    label: m.label ?? humanizeSlotName(m.name),
    sample: m.defaultValue.slice(0, 200),
  }))

// The proposer with a model: one FAST_MODEL call reads
// the document's existing markers and its unmarked candidate elements and
// proposes names and labels — renaming markers by role, marking copy and
// images that should change per use. Validated and merged over the
// deterministic proposal, so a bad answer degrades to the existing markers.
// Cached by document (design_cache, see designRuns.ts).

export const SLOT_PROPOSER_TAG = `slot-proposer@${FAST_MODEL}@v1`
const MAX_CANDIDATES = 80

const proposalSchema = z.object({
  slots: z
    .array(
      z.object({
        from: z.string(),
        name: z.string(),
        label: z.string().max(60).optional(),
      }),
    )
    .max(200),
})
type Proposal = z.infer<typeof proposalSchema>['slots'][number]

const PROPOSE_TOOL: Anthropic.Tool = {
  name: 'propose_slots',
  description: 'The slots this template should have.',
  input_schema: {
    type: 'object',
    properties: {
      slots: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: {
              type: 'string',
              description: 'An existing marker name, or a candidate ref like @3.',
            },
            name: { type: 'string', description: 'Slot name: lowercase letters, digits, dashes.' },
            label: { type: 'string', description: 'Two to four words for the fill-in form.' },
          },
          required: ['from', 'name'],
        },
      },
    },
    required: ['slots'],
  },
}

const SYSTEM = `You turn a finished HTML design into a reusable template by choosing its slots — the parts someone changes each time they use it: headlines, body copy, names, dates, numbers, calls to action, contact lines, images. Fixed decoration and structural chrome that never changes are not slots.

You get the document's existing slot markers and its unmarked candidate elements. Call propose_slots once with:
- every existing marker, with a clear role-based name (headline, subhead, body, cta, hero, stat-1, stat-1-caption…) and a short label;
- the candidates that should become slots, by their ref (@0, @1…), with a name and label.
Names: lowercase letters, digits and dashes, starting with a letter, unique, at most 40 characters. Labels: two to four words a person filling the form understands.`

const clip = (text: string, n: number) =>
  text.replace(/\s+/g, ' ').trim().slice(0, n) + (text.length > n ? '…' : '')

export function proposerPrompt(existing: ProposedSlot[], candidates: SlotCandidate[]): string {
  return [
    'Existing markers:',
    existing.length > 0
      ? existing
          .map((s) => `- ${s.from} (${s.kind}, “${s.label}”): “${clip(s.sample, 100)}”`)
          .join('\n')
      : '(none)',
    '',
    'Unmarked candidates:',
    candidates.length > 0
      ? candidates.map((c) => `- ${c.ref} <${c.tag}> ${c.kind}: “${clip(c.text, 100)}”`).join('\n')
      : '(none)',
  ].join('\n')
}

// The model's answer over the deterministic proposal. Existing markers stay
// (renamed and relabelled when the proposal is valid); candidates the model
// picked are added; any name that isn't valid or is already taken is
// dropped in favour of what was there.
export function mergeProposals(
  existing: ProposedSlot[],
  candidates: SlotCandidate[],
  proposals: Proposal[],
): ProposedSlot[] {
  const byFrom = new Map<string, Proposal>()
  for (const p of proposals) if (!byFrom.has(p.from)) byFrom.set(p.from, p)
  const used = new Set<string>()
  const label = (p: Proposal | undefined, fallback: string) => p?.label?.trim() || fallback

  const kept = existing.map((m) => {
    const p = byFrom.get(m.from)
    const wanted = p?.name.trim().toLowerCase()
    const name =
      wanted &&
      SLOT_NAME_RE.test(wanted) &&
      !used.has(wanted) &&
      !existing.some((o) => o.from === wanted && o.from !== m.from)
        ? wanted
        : m.name
    used.add(name)
    return { ...m, name, label: label(p, m.label) }
  })

  const byRef = new Map(candidates.map((c) => [c.ref, c]))
  const added: ProposedSlot[] = []
  for (const p of proposals) {
    const c = byRef.get(p.from)
    const name = p.name.trim().toLowerCase()
    if (!c || !SLOT_NAME_RE.test(name) || used.has(name)) continue
    used.add(name)
    byRef.delete(p.from)
    added.push({
      from: c.ref,
      name,
      kind: c.kind,
      label: label(p, name),
      sample: c.text.slice(0, 200),
    })
  }
  return [...kept, ...added]
}

export type ProposalCache = {
  get(key: string): Promise<ProposedSlot[] | null>
  put(key: string, slots: ProposedSlot[]): Promise<void>
}

export function modelSlotProposer(client: ModelClient, cache?: ProposalCache): SlotProposer {
  return async (doc) => {
    const existing = await existingMarkers(doc)
    const candidates = slotCandidates(doc.html).slice(0, MAX_CANDIDATES)
    if (existing.length === 0 && candidates.length === 0) return existing
    const key = createHash('sha256').update(`${SLOT_PROPOSER_TAG}\n${doc.html}`).digest('hex')
    const hit = await cache?.get(key)
    if (hit) return hit
    try {
      const response = await client.streamTurn(
        {
          model: FAST_MODEL,
          max_tokens: 4000,
          system: SYSTEM,
          tools: [PROPOSE_TOOL],
          tool_choice: { type: 'tool', name: PROPOSE_TOOL.name },
          messages: [{ role: 'user', content: proposerPrompt(existing, candidates) }],
        },
        { onText: () => undefined },
      )
      const use = response.content.find((b) => b.type === 'tool_use')
      const parsed = proposalSchema.safeParse(use?.type === 'tool_use' ? use.input : null)
      if (!parsed.success) return existing
      const merged = mergeProposals(existing, candidates, parsed.data.slots)
      await cache?.put(key, merged)
      return merged
    } catch (e) {
      console.warn(
        '[slots] proposer failed, using existing markers',
        e instanceof Error ? e.message : e,
      )
      return existing
    }
  }
}
