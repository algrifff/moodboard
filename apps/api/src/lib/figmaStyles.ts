import {
  figmaRgbToHex,
  type FigmaColourInput,
  type FigmaKitInput,
  type FigmaTextInput,
} from '@moodboard/shared'
import {
  FigmaApiError,
  parseColourValue,
  type FigmaApi,
  type FigmaNode,
  type FigmaPaint,
  type FigmaPublishedStyle,
  type FigmaStyleMeta,
  type FigmaVariables,
} from './figma'

// Reading a Figma file's styles and variables into the plain shape the kit
// mapping takes (FigmaKitInput in packages/shared). Local styles are found by
// the layers that use them; published styles, and local ones nothing uses,
// are fetched by node id. Variables come from their own endpoint, which only
// some plans can read. Everything except readKitInput is pure.

export type ResolvedStyle =
  | { styleType: 'FILL'; name: string; paints: FigmaPaint[]; uses: number }
  | {
      styleType: 'TEXT'
      name: string
      family: string
      weight: number
      size: number
      uses: number
    }
  | { styleType: 'EFFECT' | 'GRID'; name: string; uses: number }

export type StyleScan = {
  resolved: Map<string, ResolvedStyle>
  // Style ids the file declares that no layer used, so there was nothing to read the value from.
  unresolved: string[]
  observedFills: Map<string, number>
  observedText: Map<string, { family: string; weight: number; size: number; uses: number }>
}

const STYLE_SLOT_TYPE: Record<string, ResolvedStyle['styleType']> = {
  fill: 'FILL',
  fills: 'FILL',
  stroke: 'FILL',
  strokes: 'FILL',
  text: 'TEXT',
  effect: 'EFFECT',
  grid: 'GRID',
}

const OPAQUE = 0.99

function visiblePaints(paints: FigmaPaint[] | undefined): FigmaPaint[] {
  return (paints ?? []).filter((p) => p.visible !== false)
}

function textFields(
  style: FigmaNode['style'],
): { family: string; weight: number; size: number } | null {
  if (!style?.fontFamily) return null
  return {
    family: style.fontFamily,
    weight: style.fontWeight ?? 400,
    size: style.fontSize ?? 0,
  }
}

export function scanStyles(
  root: FigmaNode,
  styles: Record<string, FigmaStyleMeta> = {},
): StyleScan {
  const resolved = new Map<string, ResolvedStyle>()
  const observedFills = new Map<string, number>()
  const observedText = new Map<
    string,
    { family: string; weight: number; size: number; uses: number }
  >()

  const use = (id: string, slot: string, node: FigmaNode) => {
    const meta = styles[id]
    const styleType = STYLE_SLOT_TYPE[slot]
    if (!styleType) return
    const existing = resolved.get(id)
    if (existing) {
      existing.uses++
      return
    }
    const name = meta?.name ?? id
    if (styleType === 'FILL') {
      const paints = slot.startsWith('stroke') ? node.strokes : node.fills
      resolved.set(id, { styleType, name, paints: paints ?? [], uses: 1 })
    } else if (styleType === 'TEXT') {
      const t = textFields(node.style)
      if (t) resolved.set(id, { styleType, name, ...t, uses: 1 })
    } else {
      resolved.set(id, { styleType, name, uses: 1 })
    }
  }

  const walk = (n: FigmaNode) => {
    for (const [slot, id] of Object.entries(n.styles ?? {})) use(id, slot, n)
    if (n.visible !== false) {
      const paints = visiblePaints(n.fills)
      const top = paints[paints.length - 1]
      if (top?.type === 'SOLID' && top.color && (top.color.a ?? 1) * (top.opacity ?? 1) >= OPAQUE) {
        const hex = figmaRgbToHex(top.color)
        observedFills.set(hex, (observedFills.get(hex) ?? 0) + 1)
      }
      if (n.type === 'TEXT') {
        const t = textFields(n.style)
        if (t) {
          const key = `${t.family}|${t.weight}|${t.size}`
          const seen = observedText.get(key)
          if (seen) seen.uses++
          else observedText.set(key, { ...t, uses: 1 })
        }
      }
    }
    for (const c of n.children ?? []) walk(c)
  }
  walk(root)

  return {
    resolved,
    unresolved: Object.keys(styles).filter((id) => !resolved.has(id)),
    observedFills,
    observedText,
  }
}

// A style's value from the style's own node (published styles and local
// styles no layer uses are fetched this way).
export function resolveStyleNode(
  styleType: string,
  name: string,
  node: FigmaNode,
): ResolvedStyle | null {
  if (styleType === 'FILL') return { styleType, name, paints: node.fills ?? [], uses: 0 }
  if (styleType === 'TEXT') {
    const t = textFields(node.style)
    return t ? { styleType, name, ...t, uses: 0 } : null
  }
  if (styleType === 'EFFECT' || styleType === 'GRID') return { styleType, name, uses: 0 }
  return null
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

const FONT_VARIABLE_RE = /font|typeface|family/i

function modeValue(
  vars: FigmaVariables,
  variableId: string,
  hops = 0,
): { value: unknown; resolvedType: string } | null {
  const v = vars.variables[variableId]
  if (!v || hops > 4) return null
  const collection = vars.variableCollections[v.variableCollectionId]
  const raw = v.valuesByMode[collection?.defaultModeId ?? ''] ?? Object.values(v.valuesByMode)[0]
  if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'VARIABLE_ALIAS') {
    const target = (raw as { id?: unknown }).id
    return typeof target === 'string' ? modeValue(vars, target, hops + 1) : null
  }
  return { value: raw, resolvedType: v.resolvedType }
}

export function variablesToInput(vars: FigmaVariables): {
  colours: FigmaColourInput[]
  texts: FigmaTextInput[]
  skipped: { label: string; reason: string }[]
} {
  const colours: FigmaColourInput[] = []
  const texts: FigmaTextInput[] = []
  const skipped: { label: string; reason: string }[] = []
  let numeric = 0
  for (const v of Object.values(vars.variables)) {
    const resolved = modeValue(vars, v.id)
    if (!resolved) continue
    if (v.resolvedType === 'COLOR') {
      const c = parseColourValue(resolved.value)
      if (c) colours.push({ name: v.name, hex: figmaRgbToHex(c), alpha: c.a, source: 'variable' })
    } else if (
      v.resolvedType === 'STRING' &&
      FONT_VARIABLE_RE.test(v.name) &&
      typeof resolved.value === 'string' &&
      resolved.value.length > 0 &&
      resolved.value.length <= 100
    ) {
      texts.push({
        name: v.name,
        family: resolved.value,
        weight: 400,
        size: 0,
        uses: 0,
        source: 'variable',
      })
    } else if (v.resolvedType === 'FLOAT' || v.resolvedType === 'BOOLEAN') {
      numeric++
    }
  }
  if (numeric > 0) {
    skipped.push({
      label: `Number and boolean variables (${numeric})`,
      reason: 'Spacing, radii and flags aren’t kit tokens.',
    })
  }
  for (const c of Object.values(vars.variableCollections)) {
    const others = (c.modes ?? []).filter((m) => m.modeId !== c.defaultModeId)
    if (others.length > 0) {
      skipped.push({
        label: `${c.name} modes: ${others.map((m) => m.name).join(', ')}`,
        reason: 'Only each collection’s default mode is read.',
      })
    }
  }
  return { colours, texts, skipped }
}

// ---------------------------------------------------------------------------
// Assembling the input
// ---------------------------------------------------------------------------

const OBSERVED_COLOURS = 12
const OBSERVED_TEXTS = 6

function fillInput(
  s: Extract<ResolvedStyle, { styleType: 'FILL' }>,
  skipped: { label: string; reason: string }[],
): FigmaColourInput | null {
  const paints = visiblePaints(s.paints)
  const top = paints[paints.length - 1]
  if (!top) {
    skipped.push({ label: s.name, reason: 'No visible fill.' })
    return null
  }
  if (top.type === 'SOLID' && top.color) {
    return {
      name: s.name,
      hex: figmaRgbToHex(top.color),
      alpha: (top.color.a ?? 1) * (top.opacity ?? 1),
      source: 'style',
    }
  }
  skipped.push({
    label: s.name,
    reason: top.type === 'IMAGE' ? 'Image fill.' : 'Gradient fill.',
  })
  return null
}

export function buildKitInput(args: {
  fileKey: string
  fileName: string
  lastModified: string
  styles: Iterable<ResolvedStyle>
  scan: Pick<StyleScan, 'observedFills' | 'observedText'>
  variables: FigmaVariables | 'forbidden' | 'unavailable'
}): FigmaKitInput {
  const skipped: { label: string; reason: string }[] = []
  const ordered = [...args.styles].sort((a, b) => {
    const au = 'uses' in a ? a.uses : 0
    const bu = 'uses' in b ? b.uses : 0
    return bu - au || a.name.localeCompare(b.name)
  })

  const fromVariables = typeof args.variables === 'string' ? null : variablesToInput(args.variables)
  const colours: FigmaColourInput[] = [...(fromVariables?.colours ?? [])]
  const texts: FigmaTextInput[] = []
  let effects = 0
  let grids = 0
  for (const s of ordered) {
    if (s.styleType === 'FILL') {
      const c = fillInput(s, skipped)
      if (c) colours.push(c)
    } else if (s.styleType === 'TEXT') {
      texts.push({
        name: s.name,
        family: s.family,
        weight: s.weight,
        size: s.size,
        uses: s.uses,
        source: 'style',
      })
    } else if (s.styleType === 'EFFECT') effects++
    else grids++
  }
  texts.push(...(fromVariables?.texts ?? []))
  if (effects > 0) {
    skipped.push({
      label: `Effect styles (${effects})`,
      reason: 'Shadows and blurs aren’t kit tokens.',
    })
  }
  if (grids > 0) {
    skipped.push({ label: `Layout grid styles (${grids})`, reason: 'Grids aren’t kit tokens.' })
  }
  skipped.push(...(fromVariables?.skipped ?? []))

  const topFills = [...args.scan.observedFills.entries()].sort((a, b) => b[1] - a[1])
  for (const [hex] of topFills.slice(0, OBSERVED_COLOURS)) {
    colours.push({ name: `Fill ${hex}`, hex, alpha: 1, source: 'observed' })
  }
  for (const t of [...args.scan.observedText.values()]
    .sort((a, b) => b.uses - a.uses)
    .slice(0, OBSERVED_TEXTS)) {
    texts.push({
      name: `${t.family} ${t.weight}`,
      family: t.family,
      weight: t.weight,
      size: t.size,
      uses: t.uses,
      source: 'observed',
    })
  }

  return {
    fileKey: args.fileKey,
    fileName: args.fileName,
    lastModified: args.lastModified,
    colours,
    texts,
    skipped,
    variables: typeof args.variables === 'string' ? args.variables : 'used',
  }
}

// ---------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------

const NODE_BATCH = 40

/**
 * Read a file's local and published styles, and its variables if the token
 * can, into the kit mapping's input. A missing styles list or a variables
 * refusal degrades the result; it never fails the import.
 */
export async function readKitInput(api: FigmaApi, fileKey: string): Promise<FigmaKitInput> {
  const file = await api.file(fileKey, { whole: true })
  const meta = file.styles ?? {}
  const scan = scanStyles(file.document, meta)
  const resolved = new Map(scan.resolved)

  let published: FigmaPublishedStyle[] = []
  try {
    published = await api.publishedStyles(fileKey)
  } catch (e) {
    if (!(e instanceof FigmaApiError)) throw e
  }

  const wanted = new Map<string, { styleType: string; name: string }>()
  for (const id of scan.unresolved) {
    const m = meta[id]
    if (m) wanted.set(id, { styleType: m.styleType, name: m.name })
  }
  for (const p of published) {
    if (!resolved.has(p.node_id) && !wanted.has(p.node_id)) {
      wanted.set(p.node_id, { styleType: p.style_type, name: p.name })
    }
  }
  const ids = [...wanted.keys()]
  for (let i = 0; i < ids.length; i += NODE_BATCH) {
    try {
      const batch = await api.nodes(fileKey, ids.slice(i, i + NODE_BATCH))
      for (const [id, entry] of Object.entries(batch.nodes)) {
        const want = wanted.get(id)
        if (!entry || !want) continue
        const style = resolveStyleNode(want.styleType, want.name, entry.document)
        if (style) resolved.set(id, style)
      }
    } catch (e) {
      if (!(e instanceof FigmaApiError)) throw e
    }
  }

  let variables: FigmaVariables | 'forbidden' | 'unavailable'
  try {
    variables = await api.localVariables(fileKey)
  } catch (e) {
    if (!(e instanceof FigmaApiError)) throw e
    variables = e.status === 403 || e.status === 401 ? 'forbidden' : 'unavailable'
  }

  return buildKitInput({
    fileKey,
    fileName: file.name,
    lastModified: file.lastModified,
    styles: resolved.values(),
    scan,
    variables,
  })
}
