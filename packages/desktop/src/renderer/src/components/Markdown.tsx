import { memo, useMemo, useState, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../lib/markdown';
import { IconCheck, IconCopy } from './Icons';

function renderInline(nodes: Inline[], keyPrefix = 'i'): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}${i}`;
    switch (n.type) {
      case 'text':
        return n.text;
      case 'br':
        return <br key={key} />;
      case 'code':
        return <code key={key}>{n.text}</code>;
      case 'strong':
        return <strong key={key}>{renderInline(n.children, key)}</strong>;
      case 'em':
        return <em key={key}>{renderInline(n.children, key)}</em>;
      case 'del':
        return <del key={key}>{renderInline(n.children, key)}</del>;
      case 'link':
        return (
          <a
            key={key}
            href={n.href}
            title={n.href}
            onClick={(e) => {
              e.preventDefault();
              void window.aim.openExternal(n.href);
            }}
          >
            {renderInline(n.children, key)}
          </a>
        );
    }
  });
}

export function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="code-block">
      <div className="cb-head">
        <span>{lang || 'code'}</span>
        <button className="copy-btn" onClick={copy} aria-label="Copy code">
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function renderBlock(b: Block, key: string): ReactNode {
  switch (b.type) {
    case 'heading': {
      const Tag = `h${Math.min(6, Math.max(1, b.level))}` as 'h1';
      return <Tag key={key}>{renderInline(b.children, key)}</Tag>;
    }
    case 'paragraph':
      return <p key={key}>{renderInline(b.children, key)}</p>;
    case 'code':
      return <CodeBlock key={key} lang={b.lang} text={b.text} />;
    case 'hr':
      return <hr key={key} />;
    case 'blockquote':
      return <blockquote key={key}>{b.children.map((c, i) => renderBlock(c, `${key}q${i}`))}</blockquote>;
    case 'list': {
      const items = b.items.map((it, i) => (
        <li key={`${key}l${i}`}>
          {renderInline(it.children, `${key}l${i}`)}
          {it.sub ? it.sub.map((s, j) => renderBlock(s, `${key}l${i}s${j}`)) : null}
        </li>
      ));
      return b.ordered ? (
        <ol key={key} start={b.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'table':
      return (
        <table key={key}>
          <thead>
            <tr>
              {b.header.map((c, i) => (
                <th key={i} style={b.align[i] ? { textAlign: b.align[i]! } : undefined}>
                  {renderInline(c, `${key}h${i}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci} style={b.align[ci] ? { textAlign: b.align[ci]! } : undefined}>
                    {renderInline(c, `${key}r${ri}c${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

export const Markdown = memo(function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className={`md ${className}`}>{blocks.map((b, i) => renderBlock(b, `b${i}`))}</div>;
});
