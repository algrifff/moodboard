import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseRange, serveFile } from './serveFile'

describe('parseRange', () => {
  it('reads closed, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('serves the whole file when there is no (usable) range', () => {
    expect(parseRange(undefined, 1000)).toBeNull()
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
  })

  it('rejects ranges outside the file', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid')
    expect(parseRange('bytes=9-3', 1000)).toBe('invalid')
    expect(parseRange('bytes=-0', 1000)).toBe('invalid')
  })
})

describe('serveFile', () => {
  let dir: string
  let file: string
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mb-serve-'))
    file = path.join(dir, 'a.bin')
    await writeFile(file, Buffer.from('0123456789'))
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('streams the whole file with Accept-Ranges', async () => {
    const res = (await serveFile(file, { contentType: 'video/mp4' }))!
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('10')
    expect(await res.text()).toBe('0123456789')
  })

  it('answers a range with 206 and just those bytes', async () => {
    const res = (await serveFile(file, { contentType: 'video/mp4', rangeHeader: 'bytes=2-5' }))!
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await res.text()).toBe('2345')
  })

  it('416s an unsatisfiable range and returns null for a missing file', async () => {
    const res = (await serveFile(file, { contentType: 'video/mp4', rangeHeader: 'bytes=50-' }))!
    expect(res.status).toBe(416)
    expect(await serveFile(path.join(dir, 'nope'), { contentType: 'video/mp4' })).toBeNull()
  })
})
