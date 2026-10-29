import { describe, expect, it } from 'vitest'
import { captionImage, parseCaptionResponse, type CaptionClient } from './assetCaption'

describe('parseCaptionResponse', () => {
  it('reads plain JSON', () => {
    expect(
      parseCaptionResponse('{"caption":"A blue logo on white.","tags":["logo","blue","minimal"]}'),
    ).toEqual({ caption: 'A blue logo on white.', tags: ['logo', 'blue', 'minimal'] })
  })

  it('finds JSON inside a code fence or surrounding prose', () => {
    const text = 'Here you go:\n```json\n{"caption": "Studio portrait", "tags": ["portrait"]}\n```'
    expect(parseCaptionResponse(text)).toEqual({ caption: 'Studio portrait', tags: ['portrait'] })
  })

  it('normalises, dedupes and caps tags, dropping invalid ones', () => {
    const tags = ['Logo', 'logo', '  Blue  ', '!!', '', 'a', 'b', 'c', 'd', 'e']
    const parsed = parseCaptionResponse(JSON.stringify({ caption: 'x', tags }))
    expect(parsed?.tags).toEqual(['logo', 'blue', 'a', 'b', 'c', 'd'])
  })

  it('returns null when there is no usable caption', () => {
    expect(parseCaptionResponse('no json here')).toBeNull()
    expect(parseCaptionResponse('{"caption":"  ","tags":[]}')).toBeNull()
    expect(parseCaptionResponse('{"tags":["x"]}')).toBeNull()
    expect(parseCaptionResponse('{broken')).toBeNull()
  })

  it('collapses whitespace and bounds the caption length', () => {
    const parsed = parseCaptionResponse(JSON.stringify({ caption: `a\n\n b ${'x'.repeat(400)}` }))
    expect(parsed?.caption.startsWith('a b x')).toBe(true)
    expect(parsed!.caption.length).toBeLessThanOrEqual(200)
  })
})

describe('captionImage', () => {
  it('sends the image to the fast model and parses the reply', async () => {
    let seen: unknown
    const client = {
      create: async (params: unknown) => {
        seen = params
        return { content: [{ type: 'text', text: '{"caption":"A red chair","tags":["chair"]}' }] }
      },
    } as unknown as CaptionClient
    const result = await captionImage(client, { base64: 'AAAA', mediaType: 'image/jpeg' })
    expect(result).toEqual({ caption: 'A red chair', tags: ['chair'] })
    const params = seen as { model: string; messages: { content: { type: string }[] }[] }
    expect(params.model).toBe('claude-haiku-4-5')
    expect(params.messages[0]!.content.map((b) => b.type)).toEqual(['image', 'text'])
  })
})
