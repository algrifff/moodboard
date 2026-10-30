import { describe, expect, it } from 'vitest'
import { applyTextEdits, documentProblems } from './docEdits'

describe('applyTextEdits', () => {
  const html = '<section class="slide">A</section>\n<section class="slide">B</section>'

  it('applies edits in order, each on the result of the last', () => {
    const result = applyTextEdits(html, [
      { find: '>A<', replace: '>One<' },
      {
        find: '>One</section>',
        replace: '>One</section>\n<section class="slide">One again</section>',
      },
    ])
    expect(result).toEqual({
      ok: true,
      text: '<section class="slide">One</section>\n<section class="slide">One again</section>\n<section class="slide">B</section>',
    })
  })

  it('refuses an ambiguous or missing find unless all is set', () => {
    expect(applyTextEdits(html, [{ find: 'class="slide"', replace: 'x' }])).toEqual({
      ok: false,
      error: expect.stringMatching(/appears 2 times/),
    })
    expect(applyTextEdits(html, [{ find: 'nope', replace: 'x' }])).toEqual({
      ok: false,
      error: expect.stringMatching(/isn’t in the document/),
    })
    expect(
      applyTextEdits(html, [{ find: 'class="slide"', replace: 'class="s"', all: true }]),
    ).toEqual({ ok: true, text: html.replaceAll('class="slide"', 'class="s"') })
  })
})

describe('documentProblems', () => {
  it('accepts plain markup, inline SVG and data URIs', () => {
    expect(
      documentProblems(
        '<h1 data-slot="t">Hi</h1><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg><img src="/api/files/a.png">',
        '.x { background: url(data:image/png;base64,AA) } @keyframes rise { to { opacity: 1 } }',
      ),
    ).toEqual([])
  })

  it('rejects scripts, handlers, network and document-level tags', () => {
    expect(documentProblems('<script>alert(1)</script>', '')).toHaveLength(1)
    expect(documentProblems('<img src="/api/files/a.png" onerror="x()">', '')).toEqual([
      'No on* event handler attributes',
    ])
    expect(documentProblems('<a href="javascript:x()">x</a>', '')).toContain('No javascript: URLs')
    expect(documentProblems('<img src="https://cdn.test/a.png">', '')[0]).toMatch(/external URLs/)
    expect(documentProblems('', '.a{background:url(//cdn.test/a.png)}')[0]).toMatch(/external/)
    expect(documentProblems('', '@import "x.css";')).toEqual(['No @import in the CSS'])
    expect(documentProblems('<style>p{}</style>', '')[0]).toMatch(/put CSS in the CSS/)
    expect(documentProblems('<link rel="stylesheet" href="x.css">', '')[0]).toMatch(/No <link>/)
  })
})

describe('documentProblems for videos', () => {
  const video = (duration: string) => `<main data-duration="${duration}"><h1>Hi</h1></main>`
  const keyframes = '.a{animation:rise 600ms 200ms both}@keyframes rise{from{opacity:0}}'

  it('accepts a retimed video inside the limits', () => {
    expect(documentProblems(video('20000'), keyframes)).toEqual([])
  })

  it('keeps the duration valid and inside the limits', () => {
    expect(documentProblems(video('soon'), keyframes)[0]).toMatch(/positive number/)
    expect(documentProblems(video('120000'), keyframes)[0]).toMatch(/at most 60s/)
    expect(documentProblems(video('50'), keyframes)[0]).toMatch(/at least/)
  })

  it('keeps the motion seekable', () => {
    expect(documentProblems(video('5000'), '.a{transition:opacity .3s}')[0]).toMatch(/seekable/)
    expect(documentProblems(video('5000'), '.a{animation-play-state:paused}')[0]).toMatch(
      /seekable/,
    )
    // Not a video: transitions are the page's own business.
    expect(documentProblems('<main>x</main>', '.a{transition:opacity .3s}')).toEqual([])
  })
})
