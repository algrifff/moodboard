import { describe, expect, it } from 'vitest'
import {
  figmaCardSize,
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
