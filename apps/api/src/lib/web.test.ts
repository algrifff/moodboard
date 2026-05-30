import { describe, expect, it } from 'vitest'
import { extractFonts, extractReadable, isPrivateHost, parseMeta } from './web'

describe('isPrivateHost', () => {
  it('blocks loopback + private IPv4 ranges', () => {
    expect(isPrivateHost('localhost')).toBe(true)
    expect(isPrivateHost('127.0.0.1')).toBe(true)
    expect(isPrivateHost('10.0.0.1')).toBe(true)
    expect(isPrivateHost('192.168.1.1')).toBe(true)
    expect(isPrivateHost('172.16.0.1')).toBe(true)
    expect(isPrivateHost('169.254.169.254')).toBe(true) // cloud metadata
  })

  it('blocks IPv6 loopback + link-local', () => {
    expect(isPrivateHost('::1')).toBe(true)
    expect(isPrivateHost('fe80::1')).toBe(true)
    expect(isPrivateHost('fc00::1')).toBe(true)
  })

  it('blocks .local / .internal / .localhost', () => {
    expect(isPrivateHost('foo.localhost')).toBe(true)
    expect(isPrivateHost('redis.internal')).toBe(true)
    expect(isPrivateHost('printer.local')).toBe(true)
  })

  it('allows public hosts', () => {
    expect(isPrivateHost('stripe.com')).toBe(false)
    expect(isPrivateHost('www.acme.com')).toBe(false)
    expect(isPrivateHost('8.8.8.8')).toBe(false)
    expect(isPrivateHost('172.15.0.1')).toBe(false) // just outside 172.16-31
  })
})

describe('parseMeta', () => {
  const base = new URL('https://acme.com')

  it('prefers OG title over <title>', () => {
    const html =
      '<head><title>Old title</title><meta property="og:title" content="Brand Name"></head>'
    expect(parseMeta(html, base).title).toBe('Brand Name')
  })

  it('falls back to <title> when no OG', () => {
    const html = '<head><title>Just the title</title></head>'
    expect(parseMeta(html, base).title).toBe('Just the title')
  })

  it('falls back to the host when no title at all', () => {
    expect(parseMeta('<head></head>', base).title).toBe('acme.com')
  })

  it('extracts description (OG first, then meta description)', () => {
    expect(
      parseMeta('<head><meta property="og:description" content="OG desc"></head>', base)
        .description,
    ).toBe('OG desc')
    expect(
      parseMeta('<head><meta name="description" content="Plain desc"></head>', base).description,
    ).toBe('Plain desc')
  })

  it('decodes HTML entities in title and description', () => {
    const html = '<head><title>Acme &amp; Co</title></head>'
    expect(parseMeta(html, base).title).toBe('Acme & Co')
  })

  it('resolves favicon to absolute URL', () => {
    const html = '<head><link rel="icon" href="/favicon.ico" sizes="32x32"></head>'
    expect(parseMeta(html, base).faviconUrl).toBe('https://acme.com/favicon.ico')
  })

  it('prefers the largest icon when multiple are declared', () => {
    const html =
      '<head>' +
      '<link rel="icon" href="/small.png" sizes="16x16">' +
      '<link rel="icon" href="/big.png" sizes="192x192">' +
      '</head>'
    expect(parseMeta(html, base).faviconUrl).toBe('https://acme.com/big.png')
  })

  it('treats sizes="any" (SVG) as the highest priority icon', () => {
    const html =
      '<head>' +
      '<link rel="icon" href="/png.png" sizes="192x192">' +
      '<link rel="icon" type="image/svg+xml" href="/vector.svg" sizes="any">' +
      '</head>'
    expect(parseMeta(html, base).faviconUrl).toBe('https://acme.com/vector.svg')
  })

  it('resolves OG image to absolute URL', () => {
    const html = '<head><meta property="og:image" content="hero.png"></head>'
    expect(parseMeta(html, base).ogImageUrl).toBe('https://acme.com/hero.png')
  })
})

describe('extractReadable', () => {
  it('strips scripts and styles', () => {
    const html = '<body><script>alert(1)</script>Hello<style>.a{}</style> world</body>'
    expect(extractReadable(html)).toBe('Hello world')
  })

  it('drops nav, header, footer, aside', () => {
    const html = '<body><header>Logo</header><main>Real content</main><footer>©</footer></body>'
    expect(extractReadable(html)).toContain('Real content')
    expect(extractReadable(html)).not.toContain('Logo')
    expect(extractReadable(html)).not.toContain('©')
  })

  it('converts block boundaries into paragraph breaks', () => {
    const html = '<body><p>One</p><p>Two</p><p>Three</p></body>'
    expect(extractReadable(html)).toBe('One\nTwo\nThree')
  })

  it('decodes HTML entities', () => {
    const html = '<body><p>Pay &amp; build</p></body>'
    expect(extractReadable(html)).toBe('Pay & build')
  })

  it('caps at the 4000-char excerpt budget', () => {
    const long = 'x'.repeat(5000)
    const out = extractReadable(`<body><p>${long}</p></body>`)
    expect(out.length).toBeLessThanOrEqual(4001) // 4000 + ellipsis
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('extractFonts', () => {
  it('parses Google Fonts URL parameters', () => {
    const html =
      '<head><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Newsreader&display=swap" rel="stylesheet"></head>'
    const fonts = extractFonts(html)
    expect(fonts.map((f) => f.family)).toContain('Inter')
    expect(fonts.map((f) => f.family)).toContain('Newsreader')
  })

  it('handles Google Fonts URL with multiple ?family= params', () => {
    const html =
      '<head><link href="https://fonts.googleapis.com/css?family=Roboto&family=Open+Sans" rel="stylesheet"></head>'
    const fonts = extractFonts(html)
    expect(fonts.map((f) => f.family)).toContain('Roboto')
    expect(fonts.map((f) => f.family)).toContain('Open Sans')
  })

  it('picks up @font-face declarations in inline <style>', () => {
    const html =
      '<head><style>@font-face { font-family: "Untitled Sans"; src: url(/fonts/x.woff2); }</style></head>'
    expect(extractFonts(html).map((f) => f.family)).toContain('Untitled Sans')
  })

  it('reads the body { font-family } heuristic', () => {
    const html =
      '<head><style>body { font-family: "GT America", system-ui, sans-serif; }</style></head>'
    expect(extractFonts(html).map((f) => f.family)).toContain('GT America')
  })

  it('assigns display role to the first family and body to the rest', () => {
    const html =
      '<head><link href="https://fonts.googleapis.com/css?family=Display&family=Body" rel="stylesheet"></head>'
    const fonts = extractFonts(html)
    expect(fonts[0]?.role).toBe('display')
    if (fonts[1]) expect(fonts[1].role).toBe('body')
  })

  it('returns an empty array when no fonts are declared', () => {
    expect(extractFonts('<head></head>')).toEqual([])
  })
})
