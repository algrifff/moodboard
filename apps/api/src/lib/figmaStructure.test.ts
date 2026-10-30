import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { FigmaNode } from './figma'
import {
  STRUCTURE_MAX_CHARS,
  STRUCTURE_MAX_DEPTH,
  STRUCTURE_MAX_LINES,
  structureText,
  summariseFigmaNode,
} from './figmaStructure'

const hero = (
  JSON.parse(
    readFileSync(new URL('./fixtures/figma/nodes-hero.json', import.meta.url), 'utf8'),
  ) as { nodes: Record<string, { document: FigmaNode }> }
).nodes['12:34']!.document

describe('summariseFigmaNode', () => {
  const s = summariseFigmaNode(hero)

  it('outlines layers with sizes, auto-layout and fills', () => {
    expect(s.outline[0]).toBe(
      'Frame “Hero”, 1440×900, vertical auto-layout, gap 24, padding 64/80/64/80 (top/right/bottom/left), main axis centred, fill #FAF7F2, shadow',
    )
    expect(s.outline).toContain(
      '  Text “Launch day, the quiet way.”, Aktiv Grotesk 700 64px, line 70px, #1F2A44',
    )
    expect(s.outline).toContain('  Frame “CTA row”, 400×56, horizontal auto-layout, gap 12')
    expect(s.outline).toContain('    Instance “Primary button”, 180×56, fill #F2C14E, radius 28')
    expect(s.outline).toContain('      Text “Get started”, Source Serif 700 16px, #111111')
  })

  it('skips hidden layers but counts the visible ones', () => {
    expect(s.outline.join('\n')).not.toContain('Hidden helper')
    expect(s.layers).toBe(6)
  })

  it('collects colours, fonts and text', () => {
    expect(s.colours).toEqual(expect.arrayContaining(['#FAF7F2', '#1F2A44', '#F2C14E', '#111111']))
    expect(s.fonts).toEqual([
      { family: 'Source Serif', weights: [400, 700], sizes: [20, 16] },
      { family: 'Aktiv Grotesk', weights: [700], sizes: [64] },
    ])
    expect(s.text).toEqual([
      'Launch day, the quiet way.',
      'Software for people who ship.',
      'Get started',
    ])
  })
})

describe('structureText', () => {
  it('writes the outline followed by colours, fonts and text', () => {
    const text = structureText(summariseFigmaNode(hero))
    expect(text).toContain('Colours: ')
    expect(text).toContain('Fonts: Source Serif 400/700 (20, 16px); Aktiv Grotesk 700 (64px)')
    expect(text).toContain(
      'Text: “Launch day, the quiet way.” · “Software for people who ship.” · “Get started”',
    )
    expect(text.endsWith('6 layers in total.')).toBe(true)
  })

  it('is bounded however big the frame is', () => {
    const wide: FigmaNode = {
      id: '1:1',
      name: 'Wide',
      type: 'FRAME',
      children: Array.from({ length: 200 }, (_, i) => ({
        id: `2:${i}`,
        name: `Row ${i} with a rather long layer name to eat the budget quickly`,
        type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
        children: [
          {
            id: `3:${i}`,
            name: 't',
            type: 'TEXT',
            characters: 'x'.repeat(300),
            style: { fontFamily: 'Inter', fontSize: 12 },
          },
        ],
      })),
    }
    const s = summariseFigmaNode(wide)
    expect(s.outline.length).toBeLessThanOrEqual(STRUCTURE_MAX_LINES + 2)
    expect(s.outline.some((l) => l.includes('more layers here'))).toBe(true)
    expect(s.layers).toBe(401)
    const text = structureText(s)
    expect(text.length).toBeLessThanOrEqual(STRUCTURE_MAX_CHARS)
    expect(text).toContain('401 layers in total.')
  })

  it('stops outlining below the depth cap and says what it hid', () => {
    let node: FigmaNode = { id: '9:9', name: 'leaf', type: 'RECTANGLE' }
    for (let i = 0; i < 10; i++)
      node = { id: `9:${i}`, name: `L${i}`, type: 'FRAME', children: [node] }
    const s = summariseFigmaNode(node)
    expect(s.outline.filter((l) => !l.includes('…'))).toHaveLength(STRUCTURE_MAX_DEPTH + 1)
    expect(s.outline[s.outline.length - 1]).toMatch(/… \d+ layers inside/)
  })

  it('copes with a bare node', () => {
    const s = summariseFigmaNode({ id: '1:1' })
    expect(s.outline).toEqual(['Layer “”'])
    expect(structureText(s)).toContain('1 layer in total.')
  })
})
