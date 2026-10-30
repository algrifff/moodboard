import { figmaRgbToHex } from '@moodboard/shared'
import type { FigmaNode, FigmaPaint } from './figma'

// A compact, text-only description of a Figma frame for the design agents:
// what the layers are called, what the text says, how auto-layout arranges
// things, and the colours and type in use. It sits beside the frame's PNG so
// a designer can build HTML that matches without guessing sizes and spacing.
// Pure — it reads the node tree Figma returned and nothing else.

export const STRUCTURE_MAX_DEPTH = 5
export const STRUCTURE_MAX_LINES = 70
export const STRUCTURE_MAX_CHILDREN = 24
export const STRUCTURE_MAX_CHARS = 4000
const TEXT_CLIP = 80

export type FigmaStructure = {
  outline: string[]
  colours: string[]
  fonts: { family: string; weights: number[]; sizes: number[] }[]
  text: string[]
  layers: number
}

const TYPE_LABEL: Record<string, string> = {
  FRAME: 'Frame',
  GROUP: 'Group',
  SECTION: 'Section',
  COMPONENT: 'Component',
  COMPONENT_SET: 'Component set',
  INSTANCE: 'Instance',
  TEXT: 'Text',
  RECTANGLE: 'Rectangle',
  ELLIPSE: 'Ellipse',
  VECTOR: 'Vector',
  LINE: 'Line',
  STAR: 'Star',
  POLYGON: 'Polygon',
  BOOLEAN_OPERATION: 'Shape',
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const px = (n: number) => `${Math.round(n * 10) / 10}`

function solid(paints: FigmaPaint[] | undefined): { hex: string; alpha: number } | null {
  for (const p of paints ?? []) {
    if (p.visible === false || p.type !== 'SOLID' || !p.color) continue
    return { hex: figmaRgbToHex(p.color), alpha: (p.color.a ?? 1) * (p.opacity ?? 1) }
  }
  return null
}

function paintNote(paints: FigmaPaint[] | undefined, label: string): string | null {
  const visible = (paints ?? []).filter((p) => p.visible !== false)
  if (visible.length === 0) return null
  const s = solid(visible)
  if (s) return `${label} ${s.hex}${s.alpha < 0.99 ? ` @${Math.round(s.alpha * 100)}%` : ''}`
  if (visible.some((p) => p.type?.startsWith('GRADIENT'))) return `${label} gradient`
  if (visible.some((p) => p.type === 'IMAGE')) return `${label} image`
  return null
}

function padding(n: FigmaNode): string | null {
  const [t, r, b, l] = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(
    (v) => v ?? 0,
  ) as [number, number, number, number]
  if (t === 0 && r === 0 && b === 0 && l === 0) return null
  if (t === r && r === b && b === l) return `padding ${px(t)}`
  return `padding ${px(t)}/${px(r)}/${px(b)}/${px(l)} (top/right/bottom/left)`
}

const JUSTIFY: Record<string, string> = {
  CENTER: 'centred',
  MAX: 'end',
  SPACE_BETWEEN: 'space-between',
}

function layoutNote(n: FigmaNode): string[] {
  if (n.layoutMode !== 'HORIZONTAL' && n.layoutMode !== 'VERTICAL') return []
  const parts = [`${n.layoutMode === 'HORIZONTAL' ? 'horizontal' : 'vertical'} auto-layout`]
  if (n.layoutWrap === 'WRAP') parts.push('wraps')
  if (n.itemSpacing) parts.push(`gap ${px(n.itemSpacing)}`)
  const pad = padding(n)
  if (pad) parts.push(pad)
  const main = JUSTIFY[n.primaryAxisAlignItems ?? '']
  if (main) parts.push(`main axis ${main}`)
  const cross = JUSTIFY[n.counterAxisAlignItems ?? '']
  if (cross) parts.push(`cross axis ${cross}`)
  return parts
}

function size(n: FigmaNode): string | null {
  const box = n.absoluteBoundingBox
  return box && box.width > 0 && box.height > 0 ? `${px(box.width)}×${px(box.height)}` : null
}

function describe(n: FigmaNode): string {
  const type = TYPE_LABEL[n.type ?? ''] ?? (n.type ? n.type.toLowerCase() : 'Layer')
  if (n.type === 'TEXT') {
    const font = n.style
    const fill = solid(n.fills)
    const parts = [
      `Text “${clip(oneLine(n.characters ?? n.name ?? ''), TEXT_CLIP)}”`,
      font?.fontFamily
        ? [font.fontFamily, font.fontWeight, font.fontSize ? `${px(font.fontSize)}px` : null]
            .filter(Boolean)
            .join(' ')
        : null,
      font?.lineHeightPx ? `line ${px(font.lineHeightPx)}px` : null,
      font?.textAlignHorizontal && font.textAlignHorizontal !== 'LEFT'
        ? font.textAlignHorizontal.toLowerCase()
        : null,
      fill ? fill.hex : null,
    ]
    return parts.filter(Boolean).join(', ')
  }
  const effects = (n.effects ?? []).filter((e) => e.visible !== false)
  const parts = [
    `${type} “${clip(oneLine(n.name ?? ''), 60)}”`,
    size(n),
    ...layoutNote(n),
    paintNote(n.fills, 'fill'),
    paintNote(n.strokes, 'stroke'),
    n.cornerRadius ? `radius ${px(n.cornerRadius)}` : null,
    effects.some((e) => e.type?.includes('SHADOW')) ? 'shadow' : null,
    effects.some((e) => e.type?.includes('BLUR')) ? 'blur' : null,
  ]
  return parts.filter(Boolean).join(', ')
}

export function summariseFigmaNode(root: FigmaNode): FigmaStructure {
  const outline: string[] = []
  const colourUses = new Map<string, number>()
  const fonts = new Map<string, { weights: Set<number>; sizes: Set<number>; uses: number }>()
  const text: string[] = []
  let layers = 0

  const countColour = (paints: FigmaPaint[] | undefined) => {
    const s = solid(paints)
    if (s && s.alpha >= 0.5) colourUses.set(s.hex, (colourUses.get(s.hex) ?? 0) + 1)
  }

  const hiddenBelow = (n: FigmaNode): number => {
    let count = 0
    for (const c of n.children ?? []) if (c.visible !== false) count += 1 + hiddenBelow(c)
    return count
  }

  const walk = (n: FigmaNode, depth: number, shown: boolean) => {
    layers++
    countColour(n.fills)
    countColour(n.strokes)
    if (n.type === 'TEXT') {
      const chars = oneLine(n.characters ?? '')
      if (chars) text.push(clip(chars, TEXT_CLIP))
      if (n.style?.fontFamily) {
        const f = fonts.get(n.style.fontFamily) ?? { weights: new Set(), sizes: new Set(), uses: 0 }
        if (n.style.fontWeight) f.weights.add(n.style.fontWeight)
        if (n.style.fontSize) f.sizes.add(Math.round(n.style.fontSize))
        f.uses++
        fonts.set(n.style.fontFamily, f)
      }
    }

    const emit = shown && depth <= STRUCTURE_MAX_DEPTH && outline.length < STRUCTURE_MAX_LINES
    if (emit) outline.push(`${'  '.repeat(depth)}${describe(n)}`)

    const children = (n.children ?? []).filter((c) => c.visible !== false)
    const showKids = emit && depth < STRUCTURE_MAX_DEPTH
    children.forEach((c, i) => {
      walk(c, depth + 1, showKids && i < STRUCTURE_MAX_CHILDREN)
    })
    if (emit && children.length > 0) {
      const skipped = showKids
        ? Math.max(0, children.length - STRUCTURE_MAX_CHILDREN)
        : hiddenBelow(n)
      if (skipped > 0) {
        const label = showKids ? `${skipped} more layers here` : `${skipped} layers inside`
        outline.push(`${'  '.repeat(depth + 1)}… ${label}`)
      }
    }
  }
  walk(root, 0, true)

  return {
    outline,
    colours: [...colourUses.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([hex]) => hex),
    fonts: [...fonts.entries()]
      .sort((a, b) => b[1].uses - a[1].uses)
      .slice(0, 4)
      .map(([family, f]) => ({
        family,
        weights: [...f.weights].sort((a, b) => a - b),
        sizes: [...f.sizes].sort((a, b) => b - a),
      })),
    text: text.slice(0, 25),
    layers,
  }
}

/** The summary as the text stored on a card and handed to an agent. */
export function structureText(s: FigmaStructure, maxChars = STRUCTURE_MAX_CHARS): string {
  const tail = [
    s.colours.length > 0 ? `Colours: ${s.colours.join(', ')}` : null,
    s.fonts.length > 0
      ? `Fonts: ${s.fonts
          .map((f) =>
            `${f.family} ${f.weights.join('/') || ''} (${f.sizes.slice(0, 5).join(', ')}px)`.replace(
              / +/g,
              ' ',
            ),
          )
          .join('; ')}`
      : null,
    s.text.length > 0 ? `Text: ${s.text.map((t) => `“${t}”`).join(' · ')}` : null,
    `${s.layers} layer${s.layers === 1 ? '' : 's'} in total.`,
  ]
    .filter(Boolean)
    .join('\n')
  const budget = Math.max(0, maxChars - tail.length - 1)
  let head = s.outline.join('\n')
  if (head.length > budget) {
    const cut = head.slice(0, Math.max(0, budget - 2))
    head = `${cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : cut.length)}\n…`
  }
  return `${head}\n${tail}`.slice(0, maxChars)
}
