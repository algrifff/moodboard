import { describe, expect, it } from 'vitest'
import {
  decodeEntities,
  fileRefs,
  fillSlots,
  findSlots,
  isSlotImageValue,
  labelSlot,
  markCandidates,
  removeSlot,
  renameSlot,
  slotCandidates,
  slotTextToHtml,
} from './slots'

const doc = `
<header>
  <img class="logo" data-slot="logo" src="/api/files/logo_1.png" alt="">
  <h1 data-slot="headline" data-slot-label="Main headline">Ship <em>faster</em> &amp; better</h1>
</header>
<!-- <p data-slot="ghost">not a slot</p> -->
<p data-slot="body">First line<br>second   line</p>
<div data-slot="brand">Acme</div><footer><span data-slot="brand">Acme</span></footer>
<script>const s = '<p data-slot="fake">x</p>'</script>
`

describe('findSlots', () => {
  it('reads text and image slots with defaults, first occurrence wins', () => {
    expect(findSlots(doc)).toEqual([
      { name: 'logo', kind: 'image', label: null, defaultValue: '/api/files/logo_1.png' },
      {
        name: 'headline',
        kind: 'text',
        label: 'Main headline',
        defaultValue: 'Ship faster & better',
      },
      { name: 'body', kind: 'text', label: null, defaultValue: 'First line\nsecond line' },
      { name: 'brand', kind: 'text', label: null, defaultValue: 'Acme' },
    ])
  })

  it('ignores comments, scripts, invalid names and void non-image elements', () => {
    const html = `<!-- <b data-slot="a">x</b> --><br data-slot="b"><i data-slot="Bad Name">x</i><b data-slot="ok">y</b>`
    expect(findSlots(html).map((s) => s.name)).toEqual(['ok'])
  })

  it('matches the right closing tag through nesting', () => {
    const html = `<div data-slot="outer"><div>inner</div> tail</div><div>after</div>`
    expect(findSlots(html)[0]!.defaultValue).toBe('inner tail')
  })

  it('collapses source line wraps — only <br> is a line break', () => {
    const html = `<p data-slot="p">
      One wrapped
      sentence.<br>Second line
    </p>`
    expect(findSlots(html)[0]!.defaultValue).toBe('One wrapped sentence.\nSecond line')
  })

  it('copes with > inside quoted attributes', () => {
    const html = `<p title="a > b" data-slot="t">hi</p>`
    expect(findSlots(html)).toEqual([{ name: 't', kind: 'text', label: null, defaultValue: 'hi' }])
  })
})

describe('fillSlots', () => {
  it('escapes text values and turns newlines into <br>', () => {
    const out = fillSlots(doc, { headline: '<script>alert(1)</script> & "q"\nline 2' })
    expect(out).toContain(
      '<h1 data-slot="headline" data-slot-label="Main headline">&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;<br>line 2</h1>',
    )
    expect(out).not.toContain('<script>alert')
  })

  it('fills every occurrence of a repeated slot', () => {
    const out = fillSlots(doc, { brand: 'Globex' })
    expect(out).toContain('<div data-slot="brand">Globex</div>')
    expect(out).toContain('<span data-slot="brand">Globex</span>')
  })

  it('sets the src of image slots, escaping the attribute', () => {
    const out = fillSlots(doc, { logo: '/api/files/new_2.png' })
    expect(out).toContain('src="/api/files/new_2.png"')
    expect(fillSlots('<img data-slot="x">', { x: 'a"b' })).toBe(
      '<img data-slot="x" src="a&quot;b">',
    )
    expect(fillSlots('<img data-slot="x" />', { x: 'p' })).toBe('<img data-slot="x" src="p" />')
  })

  it('leaves slots without a value at their template default', () => {
    const out = fillSlots(doc, { body: 'New body' })
    expect(out).toContain('Ship <em>faster</em> &amp; better')
    expect(out).toContain('<p data-slot="body">New body</p>')
    expect(fillSlots(doc, {})).toBe(doc)
  })

  it('a slot nested in a replaced slot goes with its parent', () => {
    const html = `<div data-slot="card"><h2 data-slot="title">T</h2></div><p data-slot="tail">x</p>`
    expect(fillSlots(html, { card: 'C', title: 'ignored', tail: 'y' })).toBe(
      `<div data-slot="card">C</div><p data-slot="tail">y</p>`,
    )
  })

  it('keeps the markers so the result can be filled again', () => {
    const once = fillSlots(doc, { headline: 'One' })
    expect(findSlots(once).find((s) => s.name === 'headline')!.defaultValue).toBe('One')
    expect(fillSlots(once, { headline: 'Two' })).toContain('>Two</h1>')
  })
})

describe('labelSlot / removeSlot', () => {
  it('labels every occurrence, replacing an existing label', () => {
    const out = labelSlot(doc, 'headline', 'Big "title"')
    expect(findSlots(out).find((s) => s.name === 'headline')!.label).toBe('Big "title"')
    expect(out).toContain('data-slot-label="Big &quot;title&quot;"')
    expect(labelSlot(doc, 'brand', 'Brand').match(/data-slot-label="Brand"/g)).toHaveLength(2)
  })

  it('removes the marker but keeps the element and its content', () => {
    const out = removeSlot(doc, 'headline')
    expect(out).toContain('<h1>Ship <em>faster</em> &amp; better</h1>')
    expect(findSlots(out).map((s) => s.name)).toEqual(['logo', 'body', 'brand'])
  })
})

describe('renameSlot', () => {
  it('renames every marker of that name and nothing else', () => {
    const out = renameSlot(doc, 'brand', 'company')
    expect(findSlots(out).map((s) => s.name)).toEqual(['logo', 'headline', 'body', 'company'])
    expect(out.match(/data-slot="company"/g)).toHaveLength(2)
  })
})

describe('helpers', () => {
  it('slotTextToHtml escapes and breaks lines', () => {
    expect(slotTextToHtml("a<b\r\nc'")).toBe('a&lt;b<br>c&#39;')
  })

  it('decodes named and numeric entities', () => {
    expect(decodeEntities('&lt;&#65;&#x42;&nbsp;&bogus;')).toBe('<AB &bogus;')
  })

  it('fileRefs collects unique /api/files references across texts', () => {
    expect(
      fileRefs(
        '<img src="/api/files/a_1.png"><img src="/api/files/a_1.png">',
        'url("/api/files/f-2.woff2")',
        '/api/files/../etc/passwd',
      ),
    ).toEqual(['a_1.png', 'f-2.woff2'])
  })

  it('isSlotImageValue only accepts library file URLs', () => {
    expect(isSlotImageValue('/api/files/abc.png')).toBe(true)
    expect(isSlotImageValue('https://evil.test/a.png')).toBe(false)
    expect(isSlotImageValue('/api/files/a.png" onerror="x')).toBe(false)
    expect(isSlotImageValue('data:image/png;base64,AAAA')).toBe(false)
  })
})

describe('slot candidates', () => {
  const page = `
<section class="hero">
  <h1 data-slot="title">Already a slot <span>inside</span></h1>
  <p class="kicker">Spring <br>launch</p>
  <div class="cta"><a href="#">Book a call</a><span></span></div>
  <p>Mixed <strong>markup</strong> here</p>
  <img class="photo" src="/api/files/a_1.png" alt="Team at work">
  <img data-slot="logo" src="/api/files/l.png" alt="">
</section>`

  it('lists unmarked leaf text elements and images outside every slot', () => {
    expect(slotCandidates(page)).toEqual([
      { ref: '@0', kind: 'text', tag: 'p', text: 'Spring\nlaunch' },
      { ref: '@1', kind: 'text', tag: 'a', text: 'Book a call' },
      { ref: '@2', kind: 'text', tag: 'strong', text: 'markup' },
      { ref: '@3', kind: 'image', tag: 'img', text: 'Team at work' },
    ])
  })

  it('marks candidates by ref, leaving everything else as it was', () => {
    const marked = markCandidates(page, [
      { ref: '@3', name: 'photo', label: 'Team "photo"' },
      { ref: '@1', name: 'cta' },
      { ref: '@9', name: 'nothing' },
    ])
    expect(findSlots(marked).map((s) => [s.name, s.kind, s.label])).toEqual([
      ['title', 'text', null],
      ['cta', 'text', null],
      ['photo', 'image', 'Team "photo"'],
      ['logo', 'image', null],
    ])
    expect(marked).toContain('<a href="#" data-slot="cta">Book a call</a>')
    expect(slotCandidates(marked).map((c) => c.text)).toEqual(['Spring\nlaunch', 'markup'])
  })
})
