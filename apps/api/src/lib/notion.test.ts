import { describe, expect, it } from 'vitest'
import { blocksToMarkdown, renderRichText, type NotionBlock, type NotionRichText } from './notion'

// Helper to build a rich-text span with optional annotations.
const span = (
  text: string,
  opts: {
    bold?: boolean
    italic?: boolean
    code?: boolean
    strikethrough?: boolean
    href?: string
  } = {},
): NotionRichText => ({
  type: 'text',
  plain_text: text,
  href: opts.href ?? null,
  annotations: {
    bold: opts.bold,
    italic: opts.italic,
    code: opts.code,
    strikethrough: opts.strikethrough,
  },
})

// Helper to build a block with rich_text payload.
const block = (
  type: string,
  rich_text: NotionRichText[] = [],
  extra: Record<string, unknown> = {},
): NotionBlock => ({
  id: `b-${Math.random()}`,
  type,
  has_children: false,
  [type]: { rich_text, ...extra },
})

describe('renderRichText', () => {
  it('emits plain text when no annotations', () => {
    expect(renderRichText([span('hello world')])).toBe('hello world')
  })
  it('wraps bold', () => {
    expect(renderRichText([span('bold', { bold: true })])).toBe('**bold**')
  })
  it('wraps italic', () => {
    expect(renderRichText([span('it', { italic: true })])).toBe('*it*')
  })
  it('wraps code innermost', () => {
    expect(renderRichText([span('x', { bold: true, code: true })])).toBe('**`x`**')
  })
  it('wraps strikethrough', () => {
    expect(renderRichText([span('gone', { strikethrough: true })])).toBe('~~gone~~')
  })
  it('emits a markdown link when href is present', () => {
    expect(renderRichText([span('site', { href: 'https://x.com' })])).toBe('[site](https://x.com)')
  })
  it('concatenates a mixed span sequence', () => {
    const out = renderRichText([
      span('Hello '),
      span('bold', { bold: true }),
      span(' and '),
      span('linked', { href: 'https://x' }),
      span('.'),
    ])
    expect(out).toBe('Hello **bold** and [linked](https://x).')
  })
})

describe('blocksToMarkdown — block types', () => {
  it('renders a paragraph', () => {
    expect(blocksToMarkdown([block('paragraph', [span('Hi there')])])).toBe('Hi there')
  })

  it('renders headings at three levels', () => {
    const md = blocksToMarkdown([
      block('heading_1', [span('Title')]),
      block('heading_2', [span('Sub')]),
      block('heading_3', [span('Subsub')]),
    ])
    expect(md).toBe('# Title\n\n## Sub\n\n### Subsub')
  })

  it('renders a bulleted list with dashes', () => {
    const md = blocksToMarkdown([
      block('bulleted_list_item', [span('first')]),
      block('bulleted_list_item', [span('second')]),
    ])
    expect(md).toBe('- first\n\n- second')
  })

  it('numbers consecutive numbered_list_item blocks 1, 2, 3', () => {
    const md = blocksToMarkdown([
      block('numbered_list_item', [span('first')]),
      block('numbered_list_item', [span('second')]),
      block('numbered_list_item', [span('third')]),
    ])
    expect(md).toBe('1. first\n\n2. second\n\n3. third')
  })

  it('resets numbering when a non-numbered block interrupts', () => {
    const md = blocksToMarkdown([
      block('numbered_list_item', [span('first')]),
      block('paragraph', [span('break')]),
      block('numbered_list_item', [span('first again')]),
    ])
    expect(md).toBe('1. first\n\nbreak\n\n1. first again')
  })

  it('renders to-do with x or space depending on checked state', () => {
    const md = blocksToMarkdown([
      block('to_do', [span('done')], { checked: true }),
      block('to_do', [span('todo')], { checked: false }),
    ])
    expect(md).toBe('- [x] done\n\n- [ ] todo')
  })

  it('renders quote with > prefix', () => {
    expect(blocksToMarkdown([block('quote', [span('be water')])])).toBe('> be water')
  })

  it('renders callout with the page icon + > prefix', () => {
    const md = blocksToMarkdown([
      block('callout', [span('careful')], { icon: { type: 'emoji', emoji: '⚠️' } }),
    ])
    expect(md).toBe('> ⚠️ careful')
  })

  it('falls back to 💡 when callout icon is missing', () => {
    expect(blocksToMarkdown([block('callout', [span('huh')])])).toBe('> 💡 huh')
  })

  it('renders code block with language fence', () => {
    const md = blocksToMarkdown([
      block('code', [span('console.log(1)')], { language: 'javascript' }),
    ])
    expect(md).toBe('```javascript\nconsole.log(1)\n```')
  })

  it('renders divider', () => {
    expect(blocksToMarkdown([block('divider')])).toBe('---')
  })

  it('renders image with caption alt + url', () => {
    const md = blocksToMarkdown([
      block('image', [], {
        type: 'external',
        external: { url: 'https://img.example/x.png' },
        caption: [span('hero shot')],
      }),
    ])
    expect(md).toBe('![hero shot](https://img.example/x.png)')
  })

  it('renders bookmark as a link', () => {
    expect(blocksToMarkdown([block('bookmark', [], { url: 'https://x.com' })])).toBe(
      '[https://x.com](https://x.com)',
    )
  })

  it('emits an HTML comment for genuinely unsupported block types', () => {
    // unsupported is a real Notion block type returned for things like
    // private API blocks. We expect a breadcrumb, not a render.
    expect(blocksToMarkdown([block('unsupported')])).toBe(
      '<!-- unsupported notion block: unsupported -->',
    )
  })

  it('indents nested children of a bulleted list item', () => {
    const parent: NotionBlock = {
      id: 'p',
      type: 'bulleted_list_item',
      has_children: true,
      bulleted_list_item: { rich_text: [span('parent')] },
      children: [
        block('bulleted_list_item', [span('child')]),
        block('paragraph', [span('also child')]),
      ],
    }
    const md = blocksToMarkdown([parent])
    expect(md).toBe('- parent\n  - child\n\n  also child')
  })

  it('renders a toggle as a paragraph followed by indented children', () => {
    const toggle: NotionBlock = {
      id: 't',
      type: 'toggle',
      has_children: true,
      toggle: { rich_text: [span('Details')] },
      children: [block('paragraph', [span('inside')])],
    }
    expect(blocksToMarkdown([toggle])).toBe('Details\n  inside')
  })

  it('preserves inline formatting inside list items', () => {
    const md = blocksToMarkdown([
      block('bulleted_list_item', [span('say '), span('this', { bold: true })]),
    ])
    expect(md).toBe('- say **this**')
  })

  // ------------------------------------------------------------------------
  // Layout containers — column_list / column / synced_block. Notion uses
  // these as structural wrappers; their children carry the content. We
  // inline them at the same depth so the surrounding markdown is unaffected.
  // ------------------------------------------------------------------------

  it('inlines column_list children at the same depth', () => {
    const columnList: NotionBlock = {
      id: 'cl',
      type: 'column_list',
      has_children: true,
      column_list: {},
      children: [
        {
          id: 'c1',
          type: 'column',
          has_children: true,
          column: {},
          children: [block('paragraph', [span('left')])],
        },
        {
          id: 'c2',
          type: 'column',
          has_children: true,
          column: {},
          children: [block('paragraph', [span('right')])],
        },
      ],
    }
    expect(blocksToMarkdown([columnList])).toBe('left\n\nright')
  })

  it('inlines synced_block children', () => {
    const sb: NotionBlock = {
      id: 's',
      type: 'synced_block',
      has_children: true,
      synced_block: {},
      children: [block('paragraph', [span('synced')])],
    }
    expect(blocksToMarkdown([sb])).toBe('synced')
  })

  // ------------------------------------------------------------------------
  // Resilience — a single malformed block must not halt the rest of the page.
  // ------------------------------------------------------------------------

  it('isolates a render error so subsequent blocks still render', () => {
    // child_database is supported but emitting a `payload?.title` access
    // shouldn't break. Force a throw by stashing a getter that explodes.
    const exploding: NotionBlock = {
      id: 'x',
      type: 'paragraph',
      has_children: false,
      get paragraph(): never {
        throw new Error('boom')
      },
    } as NotionBlock
    const md = blocksToMarkdown([
      block('paragraph', [span('first')]),
      exploding,
      block('paragraph', [span('third')]),
    ])
    expect(md).toContain('first')
    expect(md).toContain('third')
    expect(md).toMatch(/<!-- notion block render error \(paragraph\): boom -->/)
  })

  // ------------------------------------------------------------------------
  // Media + cross-page links — should not get lost.
  // ------------------------------------------------------------------------

  it('renders child_page as a sub-page breadcrumb', () => {
    expect(blocksToMarkdown([block('child_page', [], { title: 'Research notes' })])).toBe(
      '- 📄 Research notes (sub-page)',
    )
  })

  it('renders embed as a labelled link', () => {
    expect(
      blocksToMarkdown([block('embed', [], { type: 'external', url: 'https://figma.com/x' })]),
    ).toBe('[Embed](https://figma.com/x)')
  })

  it('renders pdf media as a labelled link', () => {
    expect(
      blocksToMarkdown([
        block('pdf', [], { type: 'external', external: { url: 'https://x.com/a.pdf' } }),
      ]),
    ).toBe('[Pdf](https://x.com/a.pdf)')
  })

  it('flattens a table into a markdown pipe table', () => {
    const table: NotionBlock = {
      id: 't',
      type: 'table',
      has_children: true,
      table: { table_width: 2, has_column_header: true, has_row_header: false },
      children: [
        {
          id: 'r1',
          type: 'table_row',
          has_children: false,
          table_row: { cells: [[span('Name')], [span('Role')]] },
        },
        {
          id: 'r2',
          type: 'table_row',
          has_children: false,
          table_row: { cells: [[span('Ada')], [span('Engineer')]] },
        },
      ],
    }
    const md = blocksToMarkdown([table])
    expect(md).toContain('| Name | Role     |')
    expect(md).toContain('| Ada  | Engineer |')
    expect(md.split('\n')[1]).toMatch(/^\| -+ \| -+ \|$/)
  })

  it('renders equation as inline code', () => {
    expect(blocksToMarkdown([block('equation', [], { expression: 'E = mc^2' })])).toBe('`E = mc^2`')
  })
})
