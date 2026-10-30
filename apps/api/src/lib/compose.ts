import {
  FILE_REF_RE,
  escapeHtml,
  fillSlots,
  parseVideoDoc,
  SLOT_EDIT_MESSAGE,
  SLOT_FOCUS_MESSAGE,
  type TemplateViewport,
} from '@moodboard/shared'
import { createHash } from 'node:crypto'
import { TIMELINE_SCRIPT } from './videoTimeline'

// Composes one standalone HTML document from an output (or a template
// preview): the HTML with slot values filled, the kit's --kit-* stylesheet,
// the template CSS, and every /api/files asset inlined as a data: URI. The
// result needs no session and no network — the same bytes serve the
// preview iframe, the share link, the download and (Phase 25) the frame
// renderer.
//
// The document carries its own CSP <meta> (no network at all; inline
// styles; only the scripts composition put there, by hash), so it stays
// locked down as a downloaded file too. Routes add the same policy as a
// header, plus frame-ancestors and sandbox, which a <meta> can't express.

export type ComposeInput = {
  title: string
  format: string
  viewport: TemplateViewport
  html: string
  css: string
  // App-authored only (starter templates, copied forward). Never from a
  // request body: it is the one script the CSP lets run.
  js: string
  kitCss: string
  kitHasLogo: boolean
  values: Record<string, string>
  // filename → data: URI, for every file the document references.
  assets: ReadonlyMap<string, string>
  // The output view's inline editor; only on authenticated preview renders.
  editable?: boolean
}

export type Composed = {
  html: string
  // The policy the document enforces, for the response header.
  csp: string
  missingAssets: string[]
}

// A 1×1 transparent GIF stands in for a reference that couldn't be inlined,
// so the slot keeps its layout instead of showing a broken-image glyph.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function sha256(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`
}

// Text inside <style>/<script> ends at the first matching close tag, so a
// stray one in agent-written CSS can't break out into markup.
const guard = (text: string, tag: 'style' | 'script') =>
  text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1')

export const EDITOR_SCRIPT = `(() => {
  const EDIT = ${JSON.stringify(SLOT_EDIT_MESSAGE)}
  const FOCUS = ${JSON.stringify(SLOT_FOCUS_MESSAGE)}
  const post = (msg) => window.parent.postMessage(msg, '*')
  const style = document.createElement('style')
  style.textContent = '[data-slot]{cursor:text;outline-offset:4px;transition:outline-color 120ms}[data-slot]:hover{outline:1.5px dashed rgba(123,92,255,.7)}[data-slot]:focus{outline:2px solid #7B5CFF}img[data-slot]{cursor:pointer}'
  document.head.appendChild(style)
  for (const el of document.querySelectorAll('[data-slot]')) {
    const name = el.getAttribute('data-slot')
    if (el.tagName === 'IMG') {
      el.addEventListener('click', (e) => { e.preventDefault(); post({ type: FOCUS, name }) })
      continue
    }
    if (el.parentElement && el.parentElement.closest('[data-slot]')) continue
    // Editable text keeps source whitespace visible; collapse it as the
    // page already renders it.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) n.textContent = n.textContent.replace(/\\s+/g, ' ')
    if (el.firstChild && el.firstChild.nodeType === 3) el.firstChild.textContent = el.firstChild.textContent.replace(/^ /, '')
    if (el.lastChild && el.lastChild.nodeType === 3) el.lastChild.textContent = el.lastChild.textContent.replace(/ $/, '')
    el.setAttribute('contenteditable', 'plaintext-only')
    let before = el.innerText
    const twins = () => [...document.querySelectorAll('[data-slot]')].filter((o) => o !== el && o.getAttribute('data-slot') === name)
    el.addEventListener('focus', () => { before = el.innerText; post({ type: FOCUS, name }) })
    el.addEventListener('input', () => { for (const o of twins()) o.innerText = el.innerText })
    el.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') { el.innerText = before; for (const o of twins()) o.innerText = before; el.blur() }
    })
    el.addEventListener('blur', () => {
      const value = el.innerText.replace(/\\n+$/, '')
      if (value !== before) post({ type: EDIT, name, value })
    })
  }
})()`

export function documentCsp(scripts: string[]): string {
  return [
    "default-src 'none'",
    'img-src data:',
    'font-src data:',
    'media-src data:',
    "style-src 'unsafe-inline'",
    `script-src ${scripts.length > 0 ? scripts.map(sha256).join(' ') : "'none'"}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

// What the render routes send alongside the document.
export function renderHeaders(csp: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `${csp}; frame-ancestors 'self'; sandbox allow-scripts`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  }
}

export function composeDocument(input: ComposeInput): Composed {
  const missing = new Set<string>()
  const inline = (text: string) =>
    text.replace(FILE_REF_RE, (_whole, filename: string) => {
      const uri = input.assets.get(filename)
      if (uri) return uri
      missing.add(filename)
      return BLANK
    })

  const body = inline(fillSlots(input.html, input.values))
  const kitCss = guard(inline(input.kitCss), 'style')
  const css = guard(inline(input.css), 'style')
  const scripts = [
    input.js.trim(),
    parseVideoDoc(body) ? TIMELINE_SCRIPT : '',
    input.editable ? EDITOR_SCRIPT : '',
  ]
    .filter(Boolean)
    .map((s) => guard(s, 'script'))
  const csp = documentCsp(scripts)
  const viewport =
    input.viewport.kind === 'fixed'
      ? `width=${input.viewport.width}`
      : 'width=device-width, initial-scale=1'

  const html = [
    '<!doctype html>',
    `<html lang="en" data-format="${escapeHtml(input.format)}" data-kit-logo="${input.kitHasLogo ? 'present' : 'none'}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    `<meta name="viewport" content="${viewport}">`,
    `<title>${escapeHtml(input.title)}</title>`,
    `<style data-kit>\n${kitCss}</style>`,
    `<style data-template>\n${css}\n</style>`,
    '</head>',
    '<body>',
    body.trim(),
    ...scripts.map((s) => `<script>${s}</script>`),
    '</body>',
    '</html>',
    '',
  ].join('\n')

  return { html, csp, missingAssets: [...missing] }
}
