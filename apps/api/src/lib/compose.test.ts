import { kitToCss, kitTokensSchema } from '@moodboard/shared'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  composeDocument,
  documentCsp,
  EDITOR_SCRIPT,
  renderHeaders,
  type ComposeInput,
} from './compose'

const kit = kitTokensSchema.parse({
  palette: [
    { role: 'background', hex: '#101010' },
    { role: 'primary', hex: '#FF0066' },
  ],
  fonts: {
    display: { family: 'Brand Display', category: 'serif', url: '/api/files/font_1.woff2' },
  },
  logos: [{ name: 'Logo', url: '/api/files/logo_1.png' }],
})

const base: ComposeInput = {
  title: 'Spring <launch>',
  format: 'thumbnail',
  viewport: { kind: 'fixed', width: 1280, height: 720 },
  html: `<h1 data-slot="headline">Default headline</h1>
<p data-slot="body">Default body</p>
<img data-slot="hero" src="/api/files/default_1.jpg">`,
  css: `.hero { background: url("/api/files/texture_1.png") } h1 { color: var(--kit-color-primary) }`,
  js: '',
  kitCss: kitToCss(kit),
  kitHasLogo: true,
  values: {},
  assets: new Map([
    ['font_1.woff2', 'data:font/woff2;base64,AAAA'],
    ['logo_1.png', 'data:image/png;base64,TE9HTw=='],
    ['default_1.jpg', 'data:image/jpeg;base64,REVG'],
    ['texture_1.png', 'data:image/png;base64,VEVY'],
    ['photo_1.png', 'data:image/png;base64,UEhP'],
  ]),
}

const hash = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`

describe('composeDocument', () => {
  it('produces one standalone document: kit CSS, then template CSS, then the body', () => {
    const { html } = composeDocument(base)
    expect(html.startsWith('<!doctype html>\n<html lang="en"')).toBe(true)
    const kitAt = html.indexOf('<style data-kit>')
    const tplAt = html.indexOf('<style data-template>')
    const bodyAt = html.indexOf('<body>')
    expect(kitAt).toBeGreaterThan(0)
    expect(tplAt).toBeGreaterThan(kitAt)
    expect(bodyAt).toBeGreaterThan(tplAt)
    expect(html).toContain('--kit-color-primary: #FF0066;')
    expect(html).toContain('<title>Spring &lt;launch&gt;</title>')
  })

  it('keeps template defaults for slots without a value', () => {
    const { html } = composeDocument(base)
    expect(html).toContain('<h1 data-slot="headline">Default headline</h1>')
    expect(html).toContain('<p data-slot="body">Default body</p>')
  })

  it('escapes text slot values — slot text can never become markup', () => {
    const { html } = composeDocument({
      ...base,
      values: {
        headline: '<img src=x onerror=alert(1)>',
        body: 'Line one\n</p><script>x()</script>',
      },
    })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('Line one<br>&lt;/p&gt;&lt;script&gt;x()&lt;/script&gt;')
    expect(html).not.toMatch(/<script>x\(\)/)
  })

  it('inlines every /api/files reference — html, template css, kit css, image slots', () => {
    const { html, missingAssets } = composeDocument({
      ...base,
      values: { hero: '/api/files/photo_1.png' },
    })
    expect(missingAssets).toEqual([])
    expect(html).not.toContain('/api/files/')
    expect(html).toContain('src="data:image/png;base64,UEhP"')
    expect(html).toContain('url("data:image/png;base64,VEVY")')
    expect(html).toContain('src: url("data:font/woff2;base64,AAAA")')
    expect(html).toContain('--kit-logo: url("data:image/png;base64,TE9HTw==")')
  })

  it('reports references it could not inline and renders a blank in their place', () => {
    const { html, missingAssets } = composeDocument({ ...base, assets: new Map() })
    expect(missingAssets.sort()).toEqual(
      ['default_1.jpg', 'font_1.woff2', 'logo_1.png', 'texture_1.png'].sort(),
    )
    expect(html).not.toContain('/api/files/')
    expect(html).toContain('data:image/gif;base64,')
  })

  it('locks the document down with a CSP meta: no network, no scripts unless composed in', () => {
    const { html, csp } = composeDocument(base)
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('img-src data:')
    expect(csp).toContain('font-src data:')
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("script-src 'none'")
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<style'))
    expect(html).not.toContain('<script')
  })

  it('allows exactly the template script, by hash', () => {
    const js = "document.addEventListener('keydown', () => {})"
    const { html, csp } = composeDocument({ ...base, js })
    expect(csp).toContain(`script-src ${hash(js)}`)
    expect(html).toContain(`<script>${js}</script>`)
  })

  it('adds the inline editor (and its hash) only when asked', () => {
    expect(composeDocument(base).html).not.toContain('contenteditable')
    const { html, csp } = composeDocument({ ...base, editable: true })
    expect(html).toContain(`<script>${EDITOR_SCRIPT}</script>`)
    expect(csp).toContain(hash(EDITOR_SCRIPT))
  })

  it("can't be broken out of through </style> or </script> in agent-written text", () => {
    const { html } = composeDocument({
      ...base,
      css: 'h1{} </style><script>alert(1)</script><style>',
      js: 'const s = "</script><img src=x>"',
    })
    // Inside <style> only </style ends the element; the rest stays CSS text.
    expect(html).toContain('h1{} <\\/style><script>alert(1)</script><style>')
    expect(html.match(/<\/style>/g)).toHaveLength(2)
    expect(html).toContain('const s = "<\\/script><img src=x>"')
  })

  it('marks whether the kit has a logo and sets the viewport', () => {
    expect(composeDocument(base).html).toContain('data-kit-logo="present"')
    expect(composeDocument(base).html).toContain('<meta name="viewport" content="width=1280">')
    const responsive = composeDocument({
      ...base,
      kitHasLogo: false,
      viewport: { kind: 'responsive' },
    }).html
    expect(responsive).toContain('data-kit-logo="none"')
    expect(responsive).toContain('content="width=device-width, initial-scale=1"')
  })

  it('is deterministic', () => {
    expect(composeDocument(base).html).toBe(composeDocument(base).html)
  })
})

describe('render headers', () => {
  it('serve the document policy plus framing, sandbox and nosniff', () => {
    const csp = documentCsp([])
    const headers = renderHeaders(csp)
    expect(headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['Content-Security-Policy']).toBe(
      `${csp}; frame-ancestors 'self'; sandbox allow-scripts`,
    )
    expect(headers['Content-Security-Policy']).not.toContain('allow-same-origin')
  })
})

describe('the inline editor script', () => {
  it('is valid JavaScript with its regexes intact', () => {
    expect(() => new Function(EDITOR_SCRIPT)).not.toThrow()
    expect(EDITOR_SCRIPT).toContain('replace(/\\s+/g')
    expect(EDITOR_SCRIPT).toContain('replace(/\\n+$/')
  })
})
