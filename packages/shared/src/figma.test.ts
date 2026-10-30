import { describe, expect, it } from 'vitest'
import {
  FIGMA_ROW_CLEARANCE,
  FIGMA_ROW_GAP,
  figmaCardSize,
  layoutFigmaRow,
  figmaNodeUrl,
  figmaRenderScale,
  isFigmaNodeId,
  normaliseFigmaNodeId,
  parseFigmaUrl,
} from './figma'

const KEY = 'AbCdEfGhIjKlMnOpQrStUv'

describe('parseFigmaUrl', () => {
  it('reads a frame link: file key and node id', () => {
    expect(
      parseFigmaUrl(`https://www.figma.com/design/${KEY}/Acme-Brand-Kit?node-id=12-34&t=abc-1`),
    ).toEqual({ fileKey: KEY, nodeId: '12:34', kind: 'design', fileName: 'Acme Brand Kit' })
  })

  it('reads a file link as a file with no node', () => {
    const ref = parseFigmaUrl(`https://figma.com/design/${KEY}/Launch`)
    expect(ref).toMatchObject({ fileKey: KEY, nodeId: null, kind: 'design' })
  })

  it('accepts the older /file/ and /proto/ forms and FigJam boards', () => {
    expect(parseFigmaUrl(`https://www.figma.com/file/${KEY}/Old?node-id=1%3A2`)).toMatchObject({
      kind: 'file',
      nodeId: '1:2',
    })
    expect(parseFigmaUrl(`https://www.figma.com/proto/${KEY}/P?node-id=5-6`)).toMatchObject({
      kind: 'proto',
      nodeId: '5:6',
    })
    expect(parseFigmaUrl(`https://www.figma.com/board/${KEY}/Jam?node-id=0-1`)).toMatchObject({
      kind: 'board',
      nodeId: '0:1',
    })
  })

  it('uses the branch key for branch links', () => {
    const branch = 'ZyXwVuTsRqPoNmLkJiHgFe'
    expect(
      parseFigmaUrl(`https://www.figma.com/design/${KEY}/branch/${branch}/Name?node-id=3-4`),
    ).toMatchObject({ fileKey: branch, nodeId: '3:4' })
  })

  it('keeps instance node ids intact', () => {
    expect(
      parseFigmaUrl(`https://www.figma.com/design/${KEY}/N?node-id=I5666-180910%3B1-10515`)?.nodeId,
    ).toBe('I5666:180910;1:10515')
  })

  it('unwraps an embed link', () => {
    const inner = encodeURIComponent(`https://www.figma.com/design/${KEY}/N?node-id=7-8`)
    expect(
      parseFigmaUrl(`https://www.figma.com/embed?embed_host=share&url=${inner}`),
    ).toMatchObject({ fileKey: KEY, nodeId: '7:8' })
  })

  it('drops a node id it cannot trust', () => {
    expect(parseFigmaUrl(`https://www.figma.com/design/${KEY}/N?node-id=abc`)?.nodeId).toBeNull()
    expect(parseFigmaUrl(`https://www.figma.com/design/${KEY}/N?node-id=`)?.nodeId).toBeNull()
  })

  it('recognises Make links so they can be refused clearly', () => {
    expect(parseFigmaUrl(`https://www.figma.com/make/${KEY}/App`)?.kind).toBe('make')
  })

  it('rejects everything else', () => {
    expect(parseFigmaUrl('https://example.com/design/abc')).toBeNull()
    expect(parseFigmaUrl('https://notfigma.com/design/' + KEY)).toBeNull()
    expect(parseFigmaUrl('https://www.figma.com/')).toBeNull()
    expect(parseFigmaUrl('https://www.figma.com/community/file/123')).toBeNull()
    expect(parseFigmaUrl('https://www.figma.com/design/short/Name')).toBeNull()
    expect(parseFigmaUrl('ftp://www.figma.com/design/' + KEY)).toBeNull()
    expect(parseFigmaUrl('hello')).toBeNull()
    expect(parseFigmaUrl('')).toBeNull()
  })

  it('round-trips through figmaNodeUrl', () => {
    const url = figmaNodeUrl(KEY, '12:34', 'Acme Brand: Kit!')
    expect(url).toBe(`https://www.figma.com/design/${KEY}/Acme-Brand-Kit?node-id=12-34`)
    expect(parseFigmaUrl(url)).toMatchObject({ fileKey: KEY, nodeId: '12:34' })
    expect(figmaNodeUrl(KEY, null)).toBe(`https://www.figma.com/design/${KEY}/file`)
  })
})

describe('node ids', () => {
  it('normalises hyphen, colon and encoded forms', () => {
    expect(normaliseFigmaNodeId('1-2')).toBe('1:2')
    expect(normaliseFigmaNodeId('1:2')).toBe('1:2')
    expect(normaliseFigmaNodeId('1%3A2')).toBe('1:2')
    expect(normaliseFigmaNodeId('nope')).toBeNull()
    expect(normaliseFigmaNodeId('1;2')).toBeNull()
  })

  it('validates ids passed straight to the API', () => {
    expect(isFigmaNodeId('12:34')).toBe(true)
    expect(isFigmaNodeId('I1:2;3:4')).toBe(true)
    expect(isFigmaNodeId('12-34')).toBe(false)
    expect(isFigmaNodeId('1:2,3:4')).toBe(false)
    expect(isFigmaNodeId('')).toBe(false)
  })
})

describe('sizes', () => {
  it('renders small frames at 2x and caps the long edge of big ones', () => {
    expect(figmaRenderScale(400, 300)).toBe(2)
    expect(figmaRenderScale(1440, 900)).toBe(1.42)
    expect(figmaRenderScale(1440, 9000)).toBe(0.23)
    expect(figmaRenderScale(0, 0)).toBe(1)
  })

  it('fits a board card to the box, keeping aspect', () => {
    expect(figmaCardSize(1440, 900)).toEqual({ width: 420, height: 297 })
    expect(figmaCardSize(375, 812)).toEqual({ width: 194, height: 454 })
    expect(figmaCardSize(0, 10)).toEqual({ width: 320, height: 274 })
  })

  it('never makes a sliver unclickable', () => {
    expect(figmaCardSize(2000, 20).height).toBeGreaterThanOrEqual(120 + 34)
  })
})

describe('layoutFigmaRow', () => {
  const card = { width: 400, height: 300 }

  it('centres one card on the point', () => {
    expect(layoutFigmaRow([card], { x: 1000, y: 500 }, [])).toEqual({
      positions: [{ x: 800, y: 350 }],
      moved: false,
    })
  })

  it('lays several side by side past the grouping distance, centred as a row', () => {
    const { positions } = layoutFigmaRow([card, card], { x: 0, y: 0 }, [])
    expect(positions[1]!.x - (positions[0]!.x + card.width)).toBe(FIGMA_ROW_GAP)
    expect(FIGMA_ROW_GAP).toBeGreaterThan(48)
    expect(positions[0]!.x + (positions[1]!.x + card.width)).toBe(0)
  })

  it('aligns cards of different heights on their middles', () => {
    const { positions } = layoutFigmaRow([card, { width: 200, height: 600 }], { x: 0, y: 0 }, [])
    expect(positions.map((p) => p.y)).toEqual([-150, -300])
  })

  it('leaves a clear spot where it is, even right next to other things', () => {
    const near = { left: 200 + FIGMA_ROW_CLEARANCE + 1, top: 0, right: 900, bottom: 100 }
    expect(layoutFigmaRow([card], { x: 0, y: 0 }, [near]).moved).toBe(false)
  })

  it('moves a row that would crowd the board to the right of everything', () => {
    const existing = [
      { left: -200, top: -150, right: 200, bottom: 150 },
      { left: 1000, top: -400, right: 1400, bottom: -100 },
    ]
    const { positions, moved } = layoutFigmaRow([card, card], { x: 0, y: 0 }, existing)
    expect(moved).toBe(true)
    expect(positions[0]!.x).toBe(1400 + FIGMA_ROW_CLEARANCE * 1.5)
    expect(positions[0]!.y).toBe(-150)
    expect(positions[1]!.x).toBe(positions[0]!.x + card.width + FIGMA_ROW_GAP)
  })

  it('handles nothing to place', () => {
    expect(layoutFigmaRow([], { x: 0, y: 0 }, [])).toEqual({ positions: [], moved: false })
  })
})
