import { Fragment, type ReactNode } from 'react';
import {
  FILE_TEXT_REFERENCE_SENTINEL,
  findFileReferences,
  wrapFileLinkTarget,
} from '@kiki/session-core/composer/media';

const COMPLEX_MARKDOWN_RE =
  /```|~~~|\||<|\$|!\[|\]\(|:\/\/|&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);|\\|\]\[|`[^`\n]*[/\\:~]|%[0-9a-fA-F]{2}|(?:^|\n)\s*>|(?:^|\n)(?: {2,}|\t)|(?:^|\n)\s*\[[^\]]+\]:|(?:^|\n)(?:[-*_][ \t]*){3,}(?:\n|$)|(?:^|\n)[=-]{2,}[ \t]*(?:\n|$)|(?:^|\n)[-*+][ \t]+\[[ xX]\]/;

const UNDERSCORE_EMPHASIS_RE = /(?:^|[^\p{L}\p{N}])_|_(?:$|[^\p{L}\p{N}])/u;

/**
 * Conservative gate for the zero-AST fast Markdown path. Anything with tables,
 * fences, raw HTML, math, blockquotes, images, entities, escapes, nested lists,
 * reference links, or underscore emphasis falls back to Streamdown.
 */
export function canFastRenderMarkdown(text: string): boolean {
  if (text === '') return false;
  if (COMPLEX_MARKDOWN_RE.test(text)) return false;
  if (UNDERSCORE_EMPHASIS_RE.test(text)) return false;
  return true;
}

export type FastLinkRenderer = (href: string, children: ReactNode, key: string) => ReactNode;

const INLINE_TOKEN_SOURCE =
  '`([^`\\n]+)`|\\*\\*([^*\\n]+)\\*\\*|~~([^~\\n]+)~~|\\*([^*\\n]+)\\*|\\[([^\\]\\n]+)\\]\\(([^)\\s\\n]+)\\)|(https?:\\/\\/[^\\s)<>]+[^\\s)<>.,;:!?\'"\\]])';

function renderPlainTextWithFileRefs(
  text: string,
  renderLink: FastLinkRenderer,
  keyPrefix: string,
): ReactNode {
  if (!text.includes('/') && !text.includes('\\') && !text.includes(':')) return text;
  const refs = findFileReferences(text);
  if (refs.length === 0) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i]!;
    if (ref.start > cursor) nodes.push(text.slice(cursor, ref.start));
    const raw = text.slice(ref.start, ref.end);
    const wrapped = wrapFileLinkTarget(raw) ?? `${FILE_TEXT_REFERENCE_SENTINEL}${encodeURIComponent(raw)}`;
    nodes.push(renderLink(wrapped, raw, `${keyPrefix}-f${i}`));
    cursor = ref.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderInline(
  text: string,
  renderLink: FastLinkRenderer,
  keyPrefix: string,
): ReactNode {
  const re = new RegExp(INLINE_TOKEN_SOURCE, 'g');
  let match = re.exec(text);
  if (match === null) {
    return renderPlainTextWithFileRefs(text, renderLink, keyPrefix);
  }
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;
  while (match !== null) {
    if (match.index > cursor) {
      nodes.push(
        <Fragment key={`${keyPrefix}-t${tokenIndex}`}>
          {renderPlainTextWithFileRefs(text.slice(cursor, match.index), renderLink, `${keyPrefix}-p${tokenIndex}`)}
        </Fragment>,
      );
    }
    const k = `${keyPrefix}-i${tokenIndex}`;
    if (match[1] !== undefined) {
      nodes.push(<code key={k}>{match[1]}</code>);
    } else if (match[2] !== undefined) {
      nodes.push(<strong key={k}>{renderInline(match[2], renderLink, `${k}b`)}</strong>);
    } else if (match[3] !== undefined) {
      nodes.push(<del key={k}>{renderInline(match[3], renderLink, `${k}s`)}</del>);
    } else if (match[4] !== undefined) {
      nodes.push(<em key={k}>{renderInline(match[4], renderLink, `${k}e`)}</em>);
    } else if (match[5] !== undefined && match[6] !== undefined) {
      const target = wrapFileLinkTarget(match[6]) ?? match[6];
      nodes.push(renderLink(target, renderInline(match[5], renderLink, `${k}l`), k));
    } else if (match[7] !== undefined) {
      nodes.push(renderLink(match[7], match[7], k));
    }
    cursor = match.index + match[0].length;
    tokenIndex += 1;
    match = re.exec(text);
  }
  if (cursor < text.length) {
    nodes.push(
      <Fragment key={`${keyPrefix}-end`}>
        {renderPlainTextWithFileRefs(text.slice(cursor), renderLink, `${keyPrefix}-pe`)}
      </Fragment>,
    );
  }
  return nodes;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*$/;
const UL_ITEM_RE = /^[-*+][ \t]+(.*)$/;
const OL_ITEM_RE = /^(\d+)[.)][ \t]+(.*)$/;

/**
 * Render common Markdown (paragraphs, ATX headings, flat bullet/numbered lists,
 * bold, italic, strikethrough, inline code, links, autolinks, and file refs)
 * directly to React elements without invoking unified/micromark/rehype.
 * Returns `null` if any unsupported construct is encountered so the caller can
 * fall back to Streamdown seamlessly.
 */
export function renderFastMarkdown(text: string, renderLink: FastLinkRenderer): ReactNode | null {
  if (!canFastRenderMarkdown(text)) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let blockIndex = 0;

  while (i < lines.length) {
    const raw = lines[i]!;
    if (raw.trim() === '') {
      i += 1;
      continue;
    }

    const headingMatch = HEADING_RE.exec(raw);
    if (headingMatch !== null) {
      const level = headingMatch[1]!.length;
      const content = renderInline(headingMatch[2]!, renderLink, `b${blockIndex}`);
      const k = `b${blockIndex}`;
      if (level === 1) blocks.push(<h1 key={k}>{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={k}>{content}</h2>);
      else if (level === 3) blocks.push(<h3 key={k}>{content}</h3>);
      else if (level === 4) blocks.push(<h4 key={k}>{content}</h4>);
      else if (level === 5) blocks.push(<h5 key={k}>{content}</h5>);
      else blocks.push(<h6 key={k}>{content}</h6>);
      blockIndex += 1;
      i += 1;
      continue;
    }

    if (UL_ITEM_RE.test(raw)) {
      const items: ReactNode[] = [];
      let itemIndex = 0;
      while (i < lines.length) {
        const m = UL_ITEM_RE.exec(lines[i]!);
        if (m === null) break;
        items.push(<li key={`li${itemIndex}`}>{renderInline(m[1]!, renderLink, `b${blockIndex}u${itemIndex}`)}</li>);
        itemIndex += 1;
        i += 1;
      }
      blocks.push(<ul key={`b${blockIndex}`}>{items}</ul>);
      blockIndex += 1;
      continue;
    }

    const olStart = OL_ITEM_RE.exec(raw);
    if (olStart !== null) {
      const startNum = Number(olStart[1]);
      const items: ReactNode[] = [];
      let itemIndex = 0;
      while (i < lines.length) {
        const m = OL_ITEM_RE.exec(lines[i]!);
        if (m === null) break;
        items.push(<li key={`li${itemIndex}`}>{renderInline(m[2]!, renderLink, `b${blockIndex}o${itemIndex}`)}</li>);
        itemIndex += 1;
        i += 1;
      }
      blocks.push(
        <ol key={`b${blockIndex}`} start={startNum !== 1 ? startNum : undefined}>
          {items}
        </ol>,
      );
      blockIndex += 1;
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.trim() === '' || HEADING_RE.test(line) || UL_ITEM_RE.test(line) || OL_ITEM_RE.test(line)) {
        break;
      }
      paraLines.push(line);
      i += 1;
    }
    const paraText = paraLines.join('\n');
    // Unclosed markdown emphasis/code delimiters in a streaming chunk need
    // Streamdown's remend recovery rather than literal asterisks/backticks.
    if (/`/.test(paraText) && (paraText.match(/`/g)?.length ?? 0) % 2 !== 0) return null;
    blocks.push(<p key={`b${blockIndex}`}>{renderInline(paraText, renderLink, `b${blockIndex}`)}</p>);
    blockIndex += 1;
  }

  return blocks.length > 0 ? blocks : null;
}
