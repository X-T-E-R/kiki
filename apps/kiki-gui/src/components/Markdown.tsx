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

const components: Components = {
  pre: KikiCodeBlock as Components['pre'],
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const plugins = useStreamdownPlugins(text);
  return (
    <div className="kiki-md">
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
