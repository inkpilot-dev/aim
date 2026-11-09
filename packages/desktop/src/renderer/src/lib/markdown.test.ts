import { describe, expect, it } from 'vitest';
import { inlineToText, parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('parses bold, italic, code and strikethrough', () => {
    const nodes = parseInline('a **bold** and *em* and `code` and ~~gone~~ _under_');
    expect(nodes.map((n) => n.type)).toEqual(['text', 'strong', 'text', 'em', 'text', 'code', 'text', 'del', 'text', 'em']);
    expect(inlineToText(nodes)).toBe('a bold and em and code and gone under');
  });

  it('does not treat intra-word underscores as emphasis', () => {
    const nodes = parseInline('snake_case_name here');
    expect(nodes).toEqual([{ type: 'text', text: 'snake_case_name here' }]);
  });

  it('parses links and rejects unsafe schemes', () => {
    const ok = parseInline('see [docs](https://example.com/a?b=1)');
    expect(ok[1]).toMatchObject({ type: 'link', href: 'https://example.com/a?b=1' });
    const bad = parseInline('[x](javascript:alert(1))');
    expect(bad.every((n) => n.type !== 'link')).toBe(true);
    expect(inlineToText(bad)).toBe('x');
  });

  it('autolinks bare URLs and trims trailing punctuation', () => {
    const nodes = parseInline('Go to https://example.com/path. Then <https://b.io>');
    const links = nodes.filter((n) => n.type === 'link') as { href: string }[];
    expect(links.map((l) => l.href)).toEqual(['https://example.com/path', 'https://b.io']);
  });

  it('handles escapes and unmatched delimiters', () => {
    expect(inlineToText(parseInline('\\*not bold\\* and 2 * 3 * 4'))).toBe('*not bold* and 2 * 3 * 4');
    expect(parseInline('`unclosed')).toEqual([{ type: 'text', text: '`unclosed' }]);
  });

  it('treats raw HTML as text', () => {
    const nodes = parseInline('<script>alert(1)</script>');
    expect(nodes).toEqual([{ type: 'text', text: '<script>alert(1)</script>' }]);
  });
});

describe('parseMarkdown', () => {
  it('parses headings, paragraphs and hr', () => {
    const blocks = parseMarkdown('# Title\n\nSome text\nmore text\n\n---\n\n## Sub');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'hr', 'heading']);
    expect(blocks[0]).toMatchObject({ level: 1 });
    expect(blocks[1].type === 'paragraph' ? inlineToText(blocks[1].children) : '').toBe('Some text more text');
  });

  it('parses fenced code blocks with language and keeps content verbatim', () => {
    const blocks = parseMarkdown('```ts\nconst a = 1;\n  indented **not bold**\n```\nafter');
    expect(blocks[0]).toEqual({ type: 'code', lang: 'ts', text: 'const a = 1;\n  indented **not bold**' });
    expect(blocks[1].type).toBe('paragraph');
  });

  it('handles an unterminated fence', () => {
    const blocks = parseMarkdown('```\nstill streaming');
    expect(blocks).toEqual([{ type: 'code', lang: '', text: 'still streaming' }]);
  });

  it('parses ordered and unordered lists with nesting', () => {
    const blocks = parseMarkdown('- one\n- two\n  - nested a\n  - nested b\n- three\n\n1. first\n2. second');
    expect(blocks).toHaveLength(2);
    const ul = blocks[0];
    expect(ul.type).toBe('list');
    if (ul.type === 'list') {
      expect(ul.ordered).toBe(false);
      expect(ul.items).toHaveLength(3);
      expect(ul.items[1].sub?.[0]).toMatchObject({ type: 'list', ordered: false });
      if (ul.items[1].sub?.[0].type === 'list') expect(ul.items[1].sub[0].items).toHaveLength(2);
    }
    const ol = blocks[1];
    expect(ol).toMatchObject({ type: 'list', ordered: true, start: 1 });
  });

  it('parses blockquotes', () => {
    const blocks = parseMarkdown('> quoted **text**\n> second line');
    expect(blocks[0].type).toBe('blockquote');
    if (blocks[0].type === 'blockquote') expect(blocks[0].children[0].type).toBe('paragraph');
  });

  it('parses tables with alignment', () => {
    const blocks = parseMarkdown('| A | B |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |');
    expect(blocks[0].type).toBe('table');
    if (blocks[0].type === 'table') {
      expect(blocks[0].header).toHaveLength(2);
      expect(blocks[0].rows).toHaveLength(2);
      expect(blocks[0].align).toEqual(['left', 'right']);
      expect(inlineToText(blocks[0].rows[1][1])).toBe('4');
    }
  });

  it('separates paragraphs from following block constructs', () => {
    const blocks = parseMarkdown('text\n- item\n# head');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list', 'heading']);
  });
});
