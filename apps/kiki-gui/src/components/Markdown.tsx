/**
 * Markdown renderer for assistant/user text, built on Streamdown (streaming-
 * safe incomplete-block parsing, GFM tables/strikethrough/task-lists) with
 * shiki highlighting lazy-loaded via ./streamdown-plugins (codeg's pattern).
 * Fenced code renders through KikiCodeBlock chrome (language + copy +
 * collapse). Typography lives in `.kiki-md` (index.css).
 */

import { memo } from 'react';
import { Streamdown, type Components } from 'streamdown';

import { KikiCodeBlock } from './markdown/KikiCodeBlock';
import { useStreamdownPlugins } from './markdown/streamdown-plugins';

/**
 * Plain-prose fast path: a single line with no markdown-reactive construct
 * parses to exactly one plain `<p>`, so it can skip the Streamdown pipeline
 * (remark parse + rehype sanitize + hast→JSX) entirely. Conservative by
 * design — anything ambiguous stays on the full path:
 * - `* _ ~ # [ ] | < > \ ` `` — emphasis/heading/link/table/html/fence syntax
 * - `&` — markdown decodes entities (`&amp;` → `&`)
 * - leading `-`/`+`/`>`/`1.` — list/quote markers
 * - `https?://` / `www.` / email-shaped tokens — GFM autolink literals
 *   would render them as anchors
 * - runs of whitespace / edge whitespace — markdown collapses them
 */
const MARKDOWN_REACTIVE =
  /[\n\r`*_~#[\]|<>&\\]|^\s*(?:[-+>]|\d+[.)]\s)|https?:\/\/|www\.|[\w.+-]+@[\w-]+\.\w|\s{2}|^\s|\s$/i;

export function isPlainProse(text: string): boolean {
  return text !== '' && !MARKDOWN_REACTIVE.test(text);
}

const components: Components = {
  pre: KikiCodeBlock as Components['pre'],
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
};

export const Markdown = memo(function Markdown({
  text,
  preserveEdgeMargins = false,
}: {
  text: string;
  /** Streaming-prefix chunks keep their natural first/last block margins so
   * adjacent chunks' margins collapse like a single parse; standalone usage
   * zeroes them (see `.kiki-md--edges` in index.css). */
  preserveEdgeMargins?: boolean;
}) {
  const plain = isPlainProse(text);
  const plugins = useStreamdownPlugins(plain ? null : text);
  const className = preserveEdgeMargins ? 'kiki-md kiki-md--edges' : 'kiki-md';
  if (plain) {
    return (
      <div className={className}>
        <p>{text}</p>
      </div>
    );
  }
  return (
    <div className={className}>
      <Streamdown
        mode="streaming"
        plugins={plugins}
        components={components}
        // kiki draws its own chrome; streamdown's built-in action rows stay off.
        controls={{ table: false, code: false, mermaid: false }}
      >
        {text}
      </Streamdown>
    </div>
  );
});
