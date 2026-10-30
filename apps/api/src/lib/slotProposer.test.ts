import type Anthropic from '@anthropic-ai/sdk'
import { findSlots, fillSlots } from '@moodboard/shared'
import { describe, expect, it } from 'vitest'
import type { ModelClient } from './orchestrator'
import { mergeProposals, modelSlotProposer } from './slotProposer'
import { applySlotEdits, existingMarkers } from './slotProposer'

const html = `<main>
  <h1 data-slot="title" data-slot-label="Title">Spring launch</h1>
  <p class="sub">Out on the 12th</p>
  <a class="cta" href="#">Pre-order</a>
  <img class="hero" src="/api/files/hero.png" alt="Rocket">
</main>`

function fakeClient(answer: unknown): {
  client: ModelClient
  calls: Anthropic.MessageStreamParams[]
} {
  const calls: Anthropic.MessageStreamParams[] = []
  return {
    calls,
    client: {
      async streamTurn(params) {
        calls.push(params)
        if (answer instanceof Error) throw answer
        return {
          content: [{ type: 'tool_use', id: 'tu', name: 'propose_slots', input: answer }],
          stop_reason: 'tool_use',
        } as unknown as Anthropic.Message
      },
    },
  }
}

describe('modelSlotProposer', () => {
  it('renames existing markers and marks new candidates on a FAST_MODEL call', async () => {
    const { client, calls } = fakeClient({
      slots: [
        { from: 'title', name: 'headline', label: 'Headline' },
        { from: '@0', name: 'subhead', label: 'Launch date line' },
        { from: '@1', name: 'cta', label: 'Button' },
        { from: '@2', name: 'hero', label: 'Hero image' },
      ],
    })
    const slots = await modelSlotProposer(client)({ html, css: '' })
    expect(calls[0]).toMatchObject({
      model: 'claude-haiku-4-5',
      tool_choice: { type: 'tool', name: 'propose_slots' },
    })
    expect(calls[0]!.messages[0]!.content).toContain('@1 <a> text: “Pre-order”')
    expect(slots.map((s) => [s.from, s.name, s.kind, s.label])).toEqual([
      ['title', 'headline', 'text', 'Headline'],
      ['@0', 'subhead', 'text', 'Launch date line'],
      ['@1', 'cta', 'text', 'Button'],
      ['@2', 'hero', 'image', 'Hero image'],
    ])

    // What the save-as-template editor sends back marks the same elements.
    const saved = applySlotEdits(
      html,
      slots.map((s) => ({ from: s.from, to: s.name, label: s.label })),
    )
    expect(findSlots(saved).map((s) => [s.name, s.kind, s.label])).toEqual([
      ['headline', 'text', 'Headline'],
      ['subhead', 'text', 'Launch date line'],
      ['cta', 'text', 'Button'],
      ['hero', 'image', 'Hero image'],
    ])
    expect(fillSlots(saved, { cta: 'Buy now' })).toContain('>Buy now</a>')
  })

  it('falls back to the existing markers on a bad answer or an error', async () => {
    const fallback = await existingMarkers({ html, css: '' })
    expect(await modelSlotProposer(fakeClient({ nope: 1 }).client)({ html, css: '' })).toEqual(
      fallback,
    )
    expect(
      await modelSlotProposer(fakeClient(new Error('boom')).client)({ html, css: '' }),
    ).toEqual(fallback)
  })

  it('serves a repeat document from the cache', async () => {
    const store = new Map<string, unknown>()
    const cache = {
      get: async (k: string) => (store.get(k) as never) ?? null,
      put: async (k: string, v: unknown) => void store.set(k, v),
    }
    const first = fakeClient({ slots: [{ from: '@1', name: 'cta' }] })
    await modelSlotProposer(first.client, cache)({ html, css: '' })
    const second = fakeClient({ slots: [] })
    const again = await modelSlotProposer(second.client, cache)({ html, css: '' })
    expect(second.calls).toHaveLength(0)
    expect(again.map((s) => s.name)).toEqual(['title', 'cta'])
  })
})

describe('mergeProposals', () => {
  it('drops invalid and clashing names, keeping what was there', async () => {
    const existing = await existingMarkers({
      html: '<h1 data-slot="a">A</h1><p data-slot="b">B</p><p>C</p>',
      css: '',
    })
    const merged = mergeProposals(
      existing,
      [{ ref: '@0', kind: 'text', tag: 'p', text: 'C' }],
      [
        { from: 'a', name: 'Bad Name' },
        { from: 'b', name: 'a' },
        { from: '@0', name: 'b' },
        { from: '@9', name: 'ghost' },
      ],
    )
    expect(merged.map((s) => [s.from, s.name])).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ])
  })
})
