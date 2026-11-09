/**
 * A small, safe Markdown parser producing a plain AST. No HTML passthrough: raw HTML is treated as text.
 * Supported: headings, paragraphs, bold/italic/strikethrough, inline code, fenced code blocks,
 * ordered/unordered lists (one nesting level via indentation), blockquotes, links, autolinks, tables, hr.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
  children: Inline[];
  sub?: Block[];
}

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'blockquote'; children: Block[] }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][]; align: Align[] }
  | { type: 'hr' };

const RE_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function isSafeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href.trim());
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  return parseBlocks(lines);
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    // fenced code
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] ?? '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence (or EOF)
      blocks.push({ type: 'code', lang, text: buf.join('\n') });
      continue;
    }
    const heading = RE_HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) });
      i++;
      continue;
    }
    if (RE_HR.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    if (RE_QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        buf.push(RE_QUOTE.exec(lines[i])![1]);
        i++;
      }
      blocks.push({ type: 'blockquote', children: parseBlocks(buf) });
      continue;
    }
    // table: header row + separator row
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitRow(line).map(parseInline);
      const align: Align[] = splitRow(lines[i + 1]).map((c) => {
        const t = c.trim();
        const l = t.startsWith(':');
        const r = t.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ type: 'table', header, rows, align });
      continue;
    }
    const list = RE_LIST.exec(line);
    if (list) {
      const baseIndent = list[1].length;
      const ordered = /\d/.test(list[2]);
      const start = ordered ? parseInt(list[2], 10) : 1;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = RE_LIST.exec(lines[i]);
        if (m && m[1].length <= baseIndent) {
          if (m[1].length < baseIndent || /\d/.test(m[2]) !== ordered) break;
          const textParts = [m[3]];
          i++;
          const subLines: string[] = [];
          // continuation / nested lines
          while (i < lines.length && lines[i].trim() !== '') {
            const sub = RE_LIST.exec(lines[i]);
            if (sub && sub[1].length <= baseIndent) break;
            if (sub || /^\s+/.test(lines[i])) {
              if (sub) {
                subLines.push(lines[i]);
              } else if (subLines.length) {
                subLines.push(lines[i]);
              } else {
                textParts.push(lines[i].trim());
              }
              i++;
            } else {
              break;
            }
          }
          const item: ListItem = { children: parseInline(textParts.join(' ')) };
          if (subLines.length) {
            const minIndent = Math.min(...subLines.map((l) => /^\s*/.exec(l)![0].length));
            item.sub = parseBlocks(subLines.map((l) => l.slice(minIndent)));
          }
          items.push(item);
          // allow one blank line between items of the same list
          if (i < lines.length && lines[i].trim() === '' && i + 1 < lines.length) {
            const next = RE_LIST.exec(lines[i + 1]);
            if (next && next[1].length === baseIndent && /\d/.test(next[2]) === ordered) {
              i++;
              continue;
            }
          }
        } else {
          break;
        }
      }
      blocks.push({ type: 'list', ordered, start: Number.isFinite(start) ? start : 1, items });
      continue;
    }
    // paragraph
    const buf: string[] = [line];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '' || RE_FENCE.test(l) || RE_HEADING.test(l) || RE_HR.test(l) || RE_QUOTE.test(l) || RE_LIST.test(l)) break;
      buf.push(l);
      i++;
    }
    blocks.push({ type: 'paragraph', children: parseParagraph(buf) });
  }
  return blocks;
}

function parseParagraph(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((l, idx) => {
    const hardBreak = /\s{2,}$/.test(l) || /\\$/.test(l);
    const text = l.replace(/\s+$/, '').replace(/\\$/, '');
    out.push(...parseInline(idx === 0 ? text : text.replace(/^\s+/, '')));
    if (idx < lines.length - 1) out.push(hardBreak ? { type: 'br' } : { type: 'text', text: ' ' });
  });
  return mergeText(out);
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const PUNCT = '\\`*_{}[]()#+-.!~|<>';

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push({ type: 'text', text: buf });
      buf = '';
    }
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    // escapes
    if (ch === '\\' && i + 1 < n && PUNCT.includes(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    // inline code
    if (ch === '`') {
      let run = 0;
      while (src[i + run] === '`') run++;
      const ticks = '`'.repeat(run);
      const close = src.indexOf(ticks, i + run);
      if (close !== -1) {
        let code = src.slice(i + run, close);
        if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        flush();
        out.push({ type: 'code', text: code });
        i = close + run;
        continue;
      }
      buf += ticks;
      i += run;
      continue;
    }
    // strong / em
    if (ch === '*' || ch === '_') {
      const dbl = src.startsWith(ch + ch, i);
      if (dbl) {
        const close = findClose(src, ch + ch, i + 2);
        if (close !== -1) {
          flush();
          out.push({ type: 'strong', children: parseInline(src.slice(i + 2, close)) });
          i = close + 2;
          continue;
        }
      } else {
        const prev = i > 0 ? src[i - 1] : ' ';
        const wordBoundary = ch === '*' || !/[\w]/.test(prev);
        if (wordBoundary && i + 1 < n && !/\s/.test(src[i + 1])) {
          const close = findClose(src, ch, i + 1);
          if (close !== -1 && !/\s/.test(src[close - 1]) && (ch === '*' || !/[\w]/.test(src[close + 1] ?? ' '))) {
            flush();
            out.push({ type: 'em', children: parseInline(src.slice(i + 1, close)) });
            i = close + 1;
            continue;
          }
        }
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === '~' && src.startsWith('~~', i)) {
      const close = src.indexOf('~~', i + 2);
      if (close !== -1 && close > i + 2) {
        flush();
        out.push({ type: 'del', children: parseInline(src.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    // links [text](href)
    if (ch === '[') {
      const closeBracket = matchBracket(src, i);
      if (closeBracket !== -1 && src[closeBracket + 1] === '(') {
        const closeParen = matchParen(src, closeBracket + 1);
        if (closeParen !== -1) {
          const rawHref = src.slice(closeBracket + 2, closeParen).trim().split(/\s+/)[0] ?? '';
          const text = src.slice(i + 1, closeBracket);
          flush();
          if (isSafeHref(rawHref)) out.push({ type: 'link', href: rawHref, children: parseInline(text) });
          else out.push(...parseInline(text));
          i = closeParen + 1;
          continue;
        }
      }
    }
    // autolink <https://...>
    if (ch === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/i.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ type: 'link', href: m[1], children: [{ type: 'text', text: m[1] }] });
        i += m[0].length;
        continue;
      }
    }
    // bare URL
    if (ch === 'h' && /^https?:\/\//i.test(src.slice(i, i + 8))) {
      const m = /^https?:\/\/[^\s<]+/i.exec(src.slice(i))!;
      let url = m[0];
      // trim trailing punctuation
      while (/[.,;:!?)\]'"]$/.test(url)) {
        if (url.endsWith(')') && (url.match(/\(/g) ?? []).length >= (url.match(/\)/g) ?? []).length) break;
        url = url.slice(0, -1);
      }
      flush();
      out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
      i += url.length;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return mergeText(out);
}

function findClose(src: string, delim: string, from: number): number {
  let idx = src.indexOf(delim, from);
  while (idx !== -1) {
    if (idx > from) return idx;
    idx = src.indexOf(delim, idx + 1);
  }
  return -1;
}

function matchBracket(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '\\') {
      i++;
      continue;
    }
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '\\') {
      i++;
      continue;
    }
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function mergeText(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === 'text' && last && last.type === 'text') last.text += n.text;
    else out.push(n.type === 'text' ? { ...n } : n);
  }
  return out;
}

/** Plain-text rendering of inline nodes (for previews / tests). */
export function inlineToText(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return n.text;
        case 'code':
          return n.text;
        case 'br':
          return '\n';
        default:
          return inlineToText(n.children);
      }
    })
    .join('');
}
