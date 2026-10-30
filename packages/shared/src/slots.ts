// Phase 23 — the `data-slot` contract, as pure string functions so the API
// (composition) and the web app (save-as-template editor) read templates the
// same way without a DOM.
//
// A slot is any element carrying `data-slot="name"`:
//   - on an <img>, the slot is an image: its value replaces `src`
//   - on anything else, the slot is text: its value replaces the element's
//     content, HTML-escaped, with newlines as <br>
// The markup between the tags is the slot's default; a slot with no value
// keeps it. The same name may appear more than once (a brand name on every
// slide) — every occurrence gets the value. Slot values are never markup:
// structure belongs to the template/output HTML, which agents edit directly.

export const SLOT_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/

export type SlotKind = 'text' | 'image'

export type SlotMarker = {
  name: string
  kind: SlotKind
  // `data-slot-label` when the template gives one.
  label: string | null
  // The template's own content: visible text for a text slot, `src` for an
  // image slot.
  defaultValue: string
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])

type Attr = { name: string; value: string | null; start: number; end: number }

type Tag = {
  name: string
  start: number
  end: number
  closing: boolean
  selfClosing: boolean
  attrs: Attr[]
  // Where a new attribute goes: after the last one, or after the name.
  attrsEnd: number
}

function parseAttrs(src: string, from: number, to: number): Attr[] {
  const attrs: Attr[] = []
  let i = from
  while (i < to) {
    while (i < to && /[\s/]/.test(src[i]!)) i++
    if (i >= to) break
    const start = i
    while (i < to && !/[\s/>=]/.test(src[i]!)) i++
    const name = src.slice(start, i).toLowerCase()
    while (i < to && /\s/.test(src[i]!)) i++
    let value: string | null = null
    if (src[i] === '=') {
      i++
      while (i < to && /\s/.test(src[i]!)) i++
      const q = src[i]
      if (q === '"' || q === "'") {
        const close = src.indexOf(q, i + 1)
        const stop = close === -1 || close > to ? to : close
        value = src.slice(i + 1, stop)
        i = stop + 1
      } else {
        const vStart = i
        while (i < to && !/[\s>]/.test(src[i]!)) i++
        value = src.slice(vStart, i)
      }
    }
    if (name) attrs.push({ name, value, start, end: Math.min(i, to) })
  }
  return attrs
}

// Every start/end tag in document order, skipping comments, doctypes and the
// contents of raw-text elements (a "<div>" inside a <script> is not a tag).
function scanTags(html: string): Tag[] {
  const tags: Tag[] = []
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4)
      i = close === -1 ? html.length : close + 3
      continue
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const close = html.indexOf('>', lt)
      i = close === -1 ? html.length : close + 1
      continue
    }
    const closing = html[lt + 1] === '/'
    const nameStart = lt + (closing ? 2 : 1)
    const m = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(html.slice(nameStart, nameStart + 64))
    if (!m) {
      i = lt + 1
      continue
    }
    const name = m[0].toLowerCase()
    let j = nameStart + m[0].length
    let quote: string | null = null
    while (j < html.length) {
      const ch = html[j]!
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
      j++
    }
    const end = Math.min(j + 1, html.length)
    const selfClosing = !closing && html[j - 1] === '/'
    const attrs = closing ? [] : parseAttrs(html, nameStart + m[0].length, j)
    const attrsEnd = attrs.at(-1)?.end ?? nameStart + m[0].length
    tags.push({ name, start: lt, end, closing, selfClosing, attrs, attrsEnd })
    i = end
    if (!closing && RAW_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, end)
      i = close === -1 ? html.length : close
    }
  }
  return tags
}

const attr = (tag: Tag, name: string) => tag.attrs.find((a) => a.name === name)

type SlotSite = {
  name: string
  kind: SlotKind
  tag: Tag
  // Content range for text slots: [contentStart, contentEnd).
  contentStart: number
  contentEnd: number
}

function slotSites(html: string): SlotSite[] {
  const tags = scanTags(html)
  const sites: SlotSite[] = []
  tags.forEach((tag, index) => {
    if (tag.closing) return
    const name = attr(tag, 'data-slot')?.value?.trim().toLowerCase()
    if (!name || !SLOT_NAME_RE.test(name)) return
    if (tag.name === 'img') {
      sites.push({ name, kind: 'image', tag, contentStart: tag.end, contentEnd: tag.end })
      return
    }
    if (VOID.has(tag.name) || tag.selfClosing) return
    let depth = 0
    for (let k = index + 1; k < tags.length; k++) {
      const t = tags[k]!
      if (t.name !== tag.name) continue
      if (!t.closing && !t.selfClosing) depth++
      else if (t.closing) {
        if (depth === 0) {
          sites.push({ name, kind: 'text', tag, contentStart: tag.end, contentEnd: t.start })
          return
        }
        depth--
      }
    }
  })
  return sites
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1))
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Visible text of a fragment, as the page renders it: source whitespace
// (indentation, line wraps) collapses, <br> is a newline, tags drop.
function textOf(fragment: string): string {
  const withBreaks = fragment.replace(/\s+/g, ' ').replace(/<br\s*\/?>/gi, '\n')
  let out = ''
  let i = 0
  for (const tag of scanTags(withBreaks)) {
    out += withBreaks.slice(i, tag.start)
    i = tag.end
  }
  out += withBreaks.slice(i)
  return decodeEntities(out)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim()
}

// The slots a document declares, first occurrence of each name.
export function findSlots(html: string): SlotMarker[] {
  const seen = new Map<string, SlotMarker>()
  for (const site of slotSites(html)) {
    if (seen.has(site.name)) continue
    const label = decodeEntities(attr(site.tag, 'data-slot-label')?.value ?? '').trim() || null
    const defaultValue =
      site.kind === 'image'
        ? decodeEntities(attr(site.tag, 'src')?.value ?? '')
        : textOf(html.slice(site.contentStart, site.contentEnd))
    seen.set(site.name, { name: site.name, kind: site.kind, label, defaultValue })
  }
  return [...seen.values()]
}

export function slotTextToHtml(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => escapeHtml(line))
    .join('<br>')
}

function setAttr(html: string, tag: Tag, name: string, value: string): string {
  const existing = attr(tag, name)
  const rendered = `${name}="${escapeHtml(value)}"`
  if (existing) return html.slice(0, existing.start) + rendered + html.slice(existing.end)
  return `${html.slice(0, tag.attrsEnd)} ${rendered}${html.slice(tag.attrsEnd)}`
}

// Fills slots by name. A name missing from `values` keeps the template's
// default; image values must already be validated by the caller.
export function fillSlots(html: string, values: Record<string, string>): string {
  const sites = slotSites(html).filter((s) => Object.prototype.hasOwnProperty.call(values, s.name))
  // A slot nested inside a text slot that is being replaced goes with its
  // parent. What's left doesn't overlap, so right-to-left edits keep every
  // earlier offset valid.
  const replaced = sites.filter((s) => s.kind === 'text')
  const top = sites.filter(
    (s) => !replaced.some((r) => s.tag.start >= r.contentStart && s.tag.end <= r.contentEnd),
  )
  let out = html
  for (const site of top.sort((a, b) => b.tag.start - a.tag.start)) {
    const value = values[site.name]!
    out =
      site.kind === 'image'
        ? setAttr(out, site.tag, 'src', value)
        : out.slice(0, site.contentStart) + slotTextToHtml(value) + out.slice(site.contentEnd)
  }
  return out
}

function removeAttrs(html: string, tag: Tag, names: string[]): string {
  const doomed = tag.attrs.filter((a) => names.includes(a.name)).sort((a, b) => b.start - a.start)
  let out = html
  for (const a of doomed) {
    let from = a.start
    while (from > tag.start && /\s/.test(out[from - 1]!)) from--
    out = out.slice(0, from) + out.slice(a.end)
  }
  return out
}

// Rewrites every marker named `name`, right to left so offsets hold.
function editMarkers(html: string, name: string, edit: (html: string, tag: Tag) => string) {
  const sites = slotSites(html)
    .filter((s) => s.name === name)
    .sort((a, b) => b.tag.start - a.tag.start)
  let out = html
  for (const site of sites) out = edit(out, site.tag)
  return out
}

// Save-as-template's marker edits: rename a slot, label it, or drop the
// marker (the element and its content stay; it just isn't a slot).
export function renameSlot(html: string, from: string, to: string): string {
  return editMarkers(html, from, (out, tag) => setAttr(out, tag, 'data-slot', to))
}

export function labelSlot(html: string, name: string, label: string): string {
  return editMarkers(html, name, (out, tag) => setAttr(out, tag, 'data-slot-label', label))
}

export function removeSlot(html: string, name: string): string {
  return editMarkers(html, name, (out, tag) =>
    removeAttrs(out, tag, ['data-slot', 'data-slot-label']),
  )
}

// ---------------------------------------------------------------------------
// Slot candidates — what save-as-template's proposer may turn into slots
// ---------------------------------------------------------------------------

const CANDIDATE_TEXT_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'span',
  'li',
  'a',
  'button',
  'figcaption',
  'blockquote',
  'small',
  'strong',
  'em',
  'b',
  'label',
  'dt',
  'dd',
  'td',
  'th',
  'cite',
])

// A candidate is referred to as `@<index>` (document order) wherever a slot
// name would go, e.g. in a save-as-template edit's `from`.
export const SLOT_CANDIDATE_RE = /^@(\d{1,4})$/

export type SlotCandidate = { ref: string; kind: SlotKind; tag: string; text: string }

type CandidateSite = { kind: SlotKind; tag: Tag; text: string }

// Elements that could be slots but aren't marked: images, and leaf text
// elements (nothing inside but text and <br>), outside every existing slot.
function candidateSites(html: string): CandidateSite[] {
  const tags = scanTags(html)
  const taken = slotSites(html).map((s) => ({
    start: s.tag.start,
    end: Math.max(s.tag.end, s.contentEnd),
  }))
  const inSlot = (t: Tag) => taken.some((r) => t.start >= r.start && t.start < r.end)
  const out: CandidateSite[] = []
  tags.forEach((tag, index) => {
    if (tag.closing || attr(tag, 'data-slot') || inSlot(tag)) return
    if (tag.name === 'img') {
      out.push({ kind: 'image', tag, text: decodeEntities(attr(tag, 'alt')?.value ?? '') })
      return
    }
    if (!CANDIDATE_TEXT_TAGS.has(tag.name) || tag.selfClosing) return
    for (let k = index + 1; k < tags.length; k++) {
      const t = tags[k]!
      if (t.closing && t.name === tag.name) {
        const text = textOf(html.slice(tag.end, t.start))
        if (text) out.push({ kind: 'text', tag, text })
        return
      }
      if (t.name !== 'br') return
    }
  })
  return out
}

export function slotCandidates(html: string): SlotCandidate[] {
  return candidateSites(html).map((c, i) => ({
    ref: `@${i}`,
    kind: c.kind,
    tag: c.tag.name,
    text: c.text,
  }))
}

// Marks candidates (by `@<index>` on this same html) as slots.
export function markCandidates(
  html: string,
  marks: { ref: string; name: string; label?: string }[],
): string {
  const sites = candidateSites(html)
  const picked = marks.flatMap((m) => {
    const index = SLOT_CANDIDATE_RE.exec(m.ref)?.[1]
    const site = index === undefined ? undefined : sites[Number(index)]
    return site ? [{ ...m, tag: site.tag }] : []
  })
  let out = html
  for (const m of picked.sort((a, b) => b.tag.start - a.tag.start)) {
    const labelled = m.label ? ` data-slot-label="${escapeHtml(m.label)}"` : ''
    out = `${out.slice(0, m.tag.attrsEnd)} data-slot="${escapeHtml(m.name)}"${labelled}${out.slice(m.tag.attrsEnd)}`
  }
  return out
}

// `/api/files/<name>` references anywhere in a document's text. These are
// the assets composition inlines.
export const FILE_REF_RE = /\/api\/files\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)/g

export function fileRefs(...texts: string[]): string[] {
  const out = new Set<string>()
  for (const text of texts) for (const m of text.matchAll(FILE_REF_RE)) out.add(m[1]!)
  return [...out]
}

export function isSlotImageValue(value: string): boolean {
  return /^\/api\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(value)
}

// The slot schema a template declares: one entry per name, labelled.
export function slotSchema(html: string): { name: string; kind: SlotKind; label: string }[] {
  return findSlots(html).map((m) => ({
    name: m.name,
    kind: m.kind,
    label: m.label ?? humanizeSlotName(m.name),
  }))
}

export function humanizeSlotName(name: string): string {
  const words = name.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
