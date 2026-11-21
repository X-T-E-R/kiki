/**
 * Lightweight zero-dependency Markdown renderer for the mobile assistant feed.
 * Keeps `shiki`, `mermaid`, `katex`, and `streamdown` completely out of the
 * mobile critical chunk while rendering clean typography, lists, links, and
 * fenced code blocks.
 */

import { Fragment, type ReactNode } from 'react';

interface Block {
  readonly kind: 'code' | 'heading' | 'list' | 'quote' | 'paragraph';
  readonly text: string;
  readonly lang?: string;
  readonly level?: number;
  readonly items?: readonly string[];
  readonly ordered?: boolean;
}

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw, window.location.origin);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return url.href;
    }
  } catch {
    // Reject malformed URLs.
  }
  return null;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let tokenIndex = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<Fragment key={`${keyPrefix}-t-${tokenIndex++}`}>{text.slice(lastIndex, match.index)}</Fragment>);
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code
          key={`${keyPrefix}-c-${tokenIndex++}`}
          className="rounded bg-ink/[0.06] px-1.5 py-0.5 font-mono text-[13px] text-ink"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-b-${tokenIndex++}`} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('[')) {
      const linkParts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkParts !== null) {
        const href = safeHref(linkParts[2]!);
        if (href !== null) {
          nodes.push(
            <a
              key={`${keyPrefix}-a-${tokenIndex++}`}
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-selected-ink underline decoration-selected-ink/40 underline-offset-2"
            >
              {linkParts[1]}
            </a>,
          );
        } else {
          nodes.push(<Fragment key={`${keyPrefix}-p-${tokenIndex++}`}>{linkParts[1]}</Fragment>);
        }
      }
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(<Fragment key={`${keyPrefix}-tail`}>{text.slice(lastIndex)}</Fragment>);
  }
  return nodes;
}

function parseBlocks(source: string): readonly Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = /^```([a-zA-Z0-9_+-]*)\s*$/.exec(line.trim());
    if (fence !== null) {
      const lang = fence[1] || undefined;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ kind: 'code', lang, text: codeLines.join('\n') });
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('> ')) {
        quoteLines.push(lines[i]!.trimStart().slice(2));
        i += 1;
      }
      blocks.push({ kind: 'quote', text: quoteLines.join('\n') });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'list', ordered: false, items, text: '' });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'list', ordered: true, items, text: '' });
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !lines[i]!.trim().startsWith('```') &&
      !/^#{1,4}\s+/.test(lines[i]!) &&
      !lines[i]!.trimStart().startsWith('> ') &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', text: paraLines.join('\n') });
  }

  return blocks;
}

export function MobileMarkdown({ content }: { readonly content: string }) {
  const blocks = parseBlocks(content);
  if (blocks.length === 0) return null;

  return (
    <div className="space-y-2.5 text-[15.5px] leading-[1.6] text-ink">
      {blocks.map((block, index) => {
        if (block.kind === 'code') {
          return (
            <div key={index} className="overflow-hidden rounded-xl border border-hairline/80 bg-canvas/70">
              {block.lang !== undefined ? (
                <div className="border-b border-hairline/60 px-3 py-1 font-mono text-[11px] text-ink-faint">
                  {block.lang}
                </div>
              ) : null}
              <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-[1.5] text-ink">
                <code>{block.text}</code>
              </pre>
            </div>
          );
        }
        if (block.kind === 'heading') {
          const sizeClass =
            block.level === 1
              ? 'text-[19px] font-semibold tracking-[-0.015em]'
              : block.level === 2
                ? 'text-[17px] font-semibold tracking-[-0.01em]'
                : 'text-[15.5px] font-semibold';
          return (
            <h3 key={index} className={`pt-1 ${sizeClass} text-ink`}>
              {renderInline(block.text, `h-${index}`)}
            </h3>
          );
        }
        if (block.kind === 'quote') {
          return (
            <blockquote key={index} className="border-l-2 border-hairline-strong pl-3 text-ink-soft">
              {renderInline(block.text, `q-${index}`)}
            </blockquote>
          );
        }
        if (block.kind === 'list' && block.items !== undefined) {
          const ListTag = block.ordered === true ? 'ol' : 'ul';
          return (
            <ListTag
              key={index}
              className={`space-y-1 pl-5 ${block.ordered === true ? 'list-decimal' : 'list-disc'}`}
            >
              {block.items.map((item, itemIdx) => (
                <li key={itemIdx} className="pl-0.5">
                  {renderInline(item, `l-${index}-${itemIdx}`)}
                </li>
              ))}
            </ListTag>
          );
        }
        return (
          <p key={index} className="whitespace-pre-wrap break-words">
            {renderInline(block.text, `p-${index}`)}
          </p>
        );
      })}
    </div>
  );
}
