import { readFileSync } from 'node:fs'
import { kitFromFigma } from '@moodboard/shared'
import { describe, expect, it } from 'vitest'
import { figmaApi, type FetchLike, type FigmaNode, type FigmaVariables } from './figma'
import { readKitInput, scanStyles, variablesToInput } from './figmaStyles'

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/figma/${name}.json`, import.meta.url), 'utf8'))

const file = fixture('file') as { document: FigmaNode; styles: Record<string, never> }

function fakeFigma(
  options: { variables?: 'ok' | 'forbidden' | 'error'; styles?: 'ok' | 'forbidden' } = {},
) {
  const paths: string[] = []
  const impl = (async (url: string) => {
    const path = url.replace('https://api.figma.com', '')
    paths.push(decodeURIComponent(path))
    const ok = (json: unknown) =>
      new Response(JSON.stringify(json), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    const no = (status: number) => new Response(JSON.stringify({ status, err: 'nope' }), { status })
    if (path.includes('/variables/local')) {
      if (options.variables === 'forbidden') return no(403)
      if (options.variables === 'error') return no(500)
      return ok(fixture('variables'))
    }
    if (path.endsWith('/styles'))
      return options.styles === 'forbidden' ? no(403) : ok(fixture('published-styles'))
    if (path.includes('/nodes?')) return ok(fixture('nodes-styles'))
    if (path.startsWith('/v1/files/')) return ok(fixture('file'))
    return no(404)
  }) as unknown as FetchLike
  return { api: figmaApi('tok', impl, 'https://api.figma.com'), paths }
}

describe('scanStyles', () => {
  const scan = scanStyles(file.document, file.styles)

  it('reads local styles from the layers that use them', () => {
    expect(scan.resolved.get('1:100')).toMatchObject({
      styleType: 'FILL',
      name: 'Colors/Brand/Primary',
      uses: 1,
    })
    expect(scan.resolved.get('2:200')).toMatchObject({
      styleType: 'TEXT',
      family: 'Aktiv Grotesk',
      weight: 700,
      size: 64,
    })
    expect(scan.resolved.get('3:300')).toMatchObject({ styleType: 'EFFECT' })
    expect(scan.resolved.get('4:400')).toMatchObject({ styleType: 'GRID' })
  })

  it('lists declared styles nothing uses', () => {
    expect(scan.unresolved.sort()).toEqual(['1:105', '2:202'])
  })

  it('counts visible solid fills and text faces as observed', () => {
    expect(scan.observedFills.get('#FAF7F2')).toBe(1)
    expect(scan.observedFills.get('#111111')).toBe(2)
    expect(
      [...scan.observedText.values()].find((t) => t.family === 'Source Serif' && t.weight === 700),
    ).toMatchObject({ uses: 1 })
  })
})

describe('variablesToInput', () => {
  const vars = fixture('variables').meta as FigmaVariables
  const out = variablesToInput(vars)

  it('reads default-mode colours and follows aliases', () => {
    expect(out.colours.map((c) => [c.name, c.hex, c.alpha])).toEqual([
      ['color/brand/primary', '#1F2A44', 1],
      ['color/text/default', '#1F2A44', 1],
      ['color/surface/scrim', '#000000', 0.4],
    ])
  })

  it('takes font-family strings as type, and reports what it left', () => {
    expect(out.texts).toMatchObject([
      { name: 'font/display', family: 'Fraunces', source: 'variable' },
    ])
    expect(out.skipped.map((s) => s.label)).toEqual([
      'Number and boolean variables (1)',
      'Tokens modes: Dark',
    ])
  })
})

describe('readKitInput', () => {
  it('combines local, unused and published styles, and variables', async () => {
    const { api, paths } = fakeFigma()
    const input = await readKitInput(api, 'AbCdEfGhIjKlMnOpQrStUv')

    expect(input).toMatchObject({
      fileName: 'Acme Brand',
      lastModified: '2026-03-04T10:00:00Z',
      variables: 'used',
    })
    const names = input.colours.map((c) => `${c.source}:${c.name}`)
    expect(names.slice(0, 3)).toEqual([
      'variable:color/brand/primary',
      'variable:color/text/default',
      'variable:color/surface/scrim',
    ])
    expect(names).toEqual(
      expect.arrayContaining([
        'style:Colors/Brand/Primary',
        'style:Colors/Brand/Accent',
        'style:Neutral/Paper',
        'style:Neutral/Ink',
        'style:Colors/Support/Sage',
      ]),
    )
    expect(input.colours.find((c) => c.name === 'Colors/Support/Sage')!.hex).toBe('#90B496')
    expect(input.texts.map((t) => t.family)).toEqual(
      expect.arrayContaining(['Aktiv Grotesk', 'Source Serif', 'JetBrains Mono', 'Fraunces']),
    )
    expect(input.skipped.map((s) => s.label)).toEqual(
      expect.arrayContaining(['Gradients/Sunset', 'Effect styles (1)', 'Layout grid styles (1)']),
    )
    // unresolved ids are fetched once, in one batch
    expect(paths.filter((p) => p.includes('/nodes?'))).toEqual([
      '/v1/files/AbCdEfGhIjKlMnOpQrStUv/nodes?ids=1:105,2:202',
    ])
  })

  it('feeds the kit mapping end to end', async () => {
    const { tokens, report } = kitFromFigma(
      await readKitInput(fakeFigma().api, 'AbCdEfGhIjKlMnOpQrStUv'),
    )
    expect(tokens.palette.map((p) => p.role)).toEqual(
      expect.arrayContaining(['Brand Primary', 'Brand Accent', 'Neutral Paper', 'Neutral Ink']),
    )
    expect(tokens.fonts.display?.family).toBe('Aktiv Grotesk')
    expect(tokens.fonts.body?.family).toBe('Source Serif')
    expect(tokens.fonts.mono?.family).toBe('JetBrains Mono')
    expect(
      report.skipped.some(
        (s) => s.label === 'Colors/Brand/Primary' || s.reason.startsWith('Same colour'),
      ),
    ).toBe(true)
  })

  it('carries on when variables are refused (not Enterprise)', async () => {
    const input = await readKitInput(
      fakeFigma({ variables: 'forbidden' }).api,
      'AbCdEfGhIjKlMnOpQrStUv',
    )
    expect(input.variables).toBe('forbidden')
    expect(input.colours.every((c) => c.source !== 'variable')).toBe(true)
    const { report } = kitFromFigma(input)
    expect(report.skipped.find((s) => s.label === 'Variables')?.reason).toMatch(/Enterprise/)
  })

  it('carries on when variables or published styles fail otherwise', async () => {
    const down = await readKitInput(fakeFigma({ variables: 'error' }).api, 'AbCdEfGhIjKlMnOpQrStUv')
    expect(down.variables).toBe('unavailable')
    const noPublished = await readKitInput(
      fakeFigma({ styles: 'forbidden' }).api,
      'AbCdEfGhIjKlMnOpQrStUv',
    )
    expect(noPublished.colours.find((c) => c.name === 'Colors/Support/Sage')).toBeDefined()
  })

  it('falls back to what the file uses when it has no styles at all', async () => {
    const bare = {
      name: 'Bare',
      lastModified: '2026-01-01T00:00:00Z',
      document: {
        id: '0:0',
        type: 'DOCUMENT',
        children: [
          {
            id: '1:1',
            type: 'FRAME',
            fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
            children: [
              {
                id: '1:2',
                type: 'TEXT',
                characters: 'Hi',
                style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 16 },
              },
            ],
          },
        ],
      },
    }
    const impl = (async (url: string) =>
      url.includes('/variables/local') || url.endsWith('/styles')
        ? new Response('{}', { status: 403 })
        : new Response(JSON.stringify(bare), { status: 200 })) as unknown as FetchLike
    const input = await readKitInput(
      figmaApi('t', impl, 'https://api.figma.com'),
      'AbCdEfGhIjKlMnOpQrStUv',
    )
    expect(input.colours.map((c) => [c.hex, c.source])).toEqual([['#FF0000', 'observed']])
    const { tokens, report } = kitFromFigma(input)
    expect(tokens.palette).toHaveLength(1)
    expect(tokens.fonts.body?.family).toBe('Inter')
    expect(report.skipped[0]!.reason).toMatch(/most-used fills/)
  })
})
