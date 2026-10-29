import { createCanvas } from '@napi-rs/canvas'
import { eq, inArray } from 'drizzle-orm'
import { mkdtempSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CaptionClient } from './assetCaption'

// Real image decoding + a fake vision client, against a migrated Postgres.
// Files go to a temp DATA_DIR so the repo's data folder stays clean.
const hasDb = Boolean(process.env.DATABASE_URL)
const dataDir = mkdtempSync(path.join(tmpdir(), 'mb-enrich-'))
process.env.DATA_DIR = dataDir

describe.skipIf(!hasDb)('asset enrichment', () => {
  let dbMod: typeof import('../db')
  let enrich: typeof import('./assetEnrich')
  let storage: typeof import('./storage')
  const ids: string[] = []

  const captionClient = (reply: string) => {
    const calls: unknown[] = []
    const client = {
      create: async (params: unknown) => {
        calls.push(params)
        return { content: [{ type: 'text', text: reply }] }
      },
    } as unknown as CaptionClient
    return { client, calls }
  }

  async function insertImage(bytes: Buffer | null) {
    const { db, schema } = dbMod
    const id = nanoid()
    const filename = `${nanoid(10)}.png`
    if (bytes) await writeFile(storage.uploadPath(filename), bytes)
    await db.insert(schema.asset).values({
      id,
      filename,
      mimeType: 'image/png',
      size: bytes?.length ?? 0,
      kind: 'upload',
      mediaKind: 'image',
    })
    ids.push(id)
    return id
  }

  async function row(id: string) {
    const { db, schema } = dbMod
    const [r] = await db.select().from(schema.asset).where(eq(schema.asset.id, id))
    return r!
  }

  function png(): Buffer {
    const canvas = createCanvas(120, 60)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#E63946'
    ctx.fillRect(0, 0, 80, 60)
    ctx.fillStyle = '#1D3557'
    ctx.fillRect(80, 0, 40, 60)
    return canvas.toBuffer('image/png')
  }

  beforeAll(async () => {
    dbMod = await import('../db')
    storage = await import('./storage')
    enrich = await import('./assetEnrich')
    await storage.ensureDataDirs()
  })

  afterAll(async () => {
    await dbMod.db.delete(dbMod.schema.asset).where(inArray(dbMod.schema.asset.id, ids))
    await dbMod.pgClient.end()
  })

  it('measures size and dominant colours, and captions when a client is given', async () => {
    const id = await insertImage(png())
    const { client, calls } = captionClient(
      '{"caption":"Red and navy blocks","tags":["Red","blocks"]}',
    )
    await enrich.enrichAsset(id, client)

    const r = await row(id)
    expect(r).toMatchObject({ width: 120, height: 60, caption: 'Red and navy blocks' })
    expect(r.tags).toEqual(['red', 'blocks'])
    expect(r.colors.slice(0, 2)).toEqual(['#E63946', '#1D3557'])
    expect(r.enrichedAt).not.toBeNull()
    expect(calls).toHaveLength(1)
    const sent = calls[0] as {
      messages: { content: { type: string; source?: { media_type: string } }[] }[]
    }
    expect(sent.messages[0]!.content[0]!.source!.media_type).toBe('image/jpeg')
  })

  it('skips the caption without a client but still records colours', async () => {
    const id = await insertImage(png())
    await enrich.enrichAsset(id, null)
    const r = await row(id)
    expect(r.caption).toBeNull()
    expect(r.colors).toHaveLength(2)
    expect(r.width).toBe(120)
  })

  it('runs once per asset', async () => {
    const id = await insertImage(png())
    const first = captionClient('{"caption":"first","tags":[]}')
    await enrich.enrichAsset(id, first.client)
    const second = captionClient('{"caption":"second","tags":[]}')
    await enrich.enrichAsset(id, second.client)
    expect(second.calls).toHaveLength(0)
    expect((await row(id)).caption).toBe('first')
  })

  it('keeps a caption failure from losing the colours', async () => {
    const id = await insertImage(png())
    const broken = {
      create: async () => {
        throw new Error('overloaded')
      },
    } as unknown as CaptionClient
    await enrich.enrichAsset(id, broken)
    const r = await row(id)
    expect(r.caption).toBeNull()
    expect(r.colors).toHaveLength(2)
  })

  it('marks an unreadable or missing file as done instead of retrying forever', async () => {
    const garbage = await insertImage(Buffer.from('definitely not a png'))
    const missing = await insertImage(null)
    await enrich.enrichAsset(garbage, null)
    await enrich.enrichAsset(missing, null)
    for (const id of [garbage, missing]) {
      const r = await row(id)
      expect(r.enrichedAt).not.toBeNull()
      expect(r.width).toBeNull()
    }
  })
})
