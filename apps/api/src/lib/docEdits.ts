import { DOC_CSS_MAX, DOC_HTML_MAX, videoDurationProblem } from '@moodboard/shared'

// Plain-text edits to an output's HTML / CSS — how agents change structure
// (duplicate a deck section, swap a layout) — and the rules every edited
// document must still meet. Composition enforces the same things with its
// CSP; checking here gives the agent a clear error instead of a document
// that silently renders without them.

export type TextEdit = { find: string; replace: string; all?: boolean }

const clip = (s: string) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat
}

// Each `find` must match exactly once (or `all`), in order, on the result
// of the edits before it.
export function applyTextEdits(
  text: string,
  edits: TextEdit[],
): { ok: true; text: string } | { ok: false; error: string } {
  let out = text
  for (const [i, edit] of edits.entries()) {
    const where = `Edit ${i + 1}`
    if (!edit.find) return { ok: false, error: `${where}: find is empty` }
    const count = out.split(edit.find).length - 1
    if (count === 0) {
      return { ok: false, error: `${where}: “${clip(edit.find)}” isn’t in the document` }
    }
    if (count > 1 && !edit.all) {
      return {
        ok: false,
        error: `${where}: “${clip(edit.find)}” appears ${count} times — include more surrounding text, or set all:true`,
      }
    }
    out = out.split(edit.find).join(edit.replace)
  }
  return { ok: true, text: out }
}

// SVG and XML namespace identifiers are URLs nobody fetches.
const NAMESPACE_URL = /https?:\/\/www\.w3\.org\/[\w/.#-]*/gi

export function documentProblems(html: string, css: string): string[] {
  const problems: string[] = []
  if (html.length > DOC_HTML_MAX) problems.push(`HTML is over ${DOC_HTML_MAX} characters`)
  if (css.length > DOC_CSS_MAX) problems.push(`CSS is over ${DOC_CSS_MAX} characters`)
  const tag =
    /<\s*(script|iframe|object|embed|frame|frameset|base|meta|link|form|html|head|body|style)\b/i.exec(
      html,
    )
  if (tag) {
    problems.push(
      tag[1]!.toLowerCase() === 'style'
        ? 'No <style> in the HTML — put CSS in the CSS'
        : `No <${tag[1]!.toLowerCase()}> — the HTML is the body content of a standalone document`,
    )
  }
  if (/\son[a-z]+\s*=/i.test(html)) problems.push('No on* event handler attributes')
  if (/javascript:/i.test(html) || /javascript:/i.test(css)) problems.push('No javascript: URLs')
  if (/https?:\/\/|url\(\s*["']?\/\//i.test(`${html}\n${css}`.replace(NAMESPACE_URL, ''))) {
    problems.push(
      'No external URLs — images come from the library (/api/files/…), anything else inline',
    )
  }
  if (/@import/i.test(css)) problems.push('No @import in the CSS')
  // A video's timeline has to stay renderable: data-duration valid and
  // inside the limits, and its motion seekable (keyframes, not transitions).
  const duration = videoDurationProblem(html)
  if (duration) problems.push(duration)
  if (/data-duration\s*=/i.test(html) && /\btransition\s*:|animation-play-state/i.test(css)) {
    problems.push(
      'Video motion must be seekable: CSS @keyframes with explicit delays — no transitions or animation-play-state',
    )
  }
  return problems
}
