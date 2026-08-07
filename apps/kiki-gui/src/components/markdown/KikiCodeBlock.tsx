/**
 * KikiCodeBlock — code-block chrome for markdown fences: language label, copy
 * button, and collapse for long blocks ("View more (N lines)").
 *
 * Chrome pattern adapted from aionui (https://github.com/AionUi/AionUi —
 * `packages/desktop/src/renderer/components/Markdown/CodeBlock.tsx`,
 * Apache-2.0): fixed preview height, footer toggle, copy feedback. The actual
 * highlighting is Streamdown's exported `CodeBlock` (shiki via the lazily
 * loaded `@streamdown/code` plugin), rendered inside our chrome with its own
 * header/actions suppressed (scoped CSS in index.css) so nothing is
 * duplicated. kiki shows 12 lines before collapsing (aionui shows 3).
 */

import { useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { CodeBlock } from 'streamdown';

/** Lines shown before a fence collapses behind "View more". */
const PREVIEW_LINES = 12;
/** JetBrains Mono 12.5px × 1.55 line-height + vertical padding. */
const LINE_HEIGHT_PX = 19.4;
const BODY_PADDING_PX = 16;

function extractCode(children: ReactNode): { code: string; language: string } {
  // `pre` wraps a single <code className="language-x"> element.
  if (children !== null && typeof children === 'object' && 'props' in (children as object)) {
    const element = children as ReactElement<{ className?: string; children?: ReactNode }>;
    const className = element.props.className ?? '';
    const match = /language-(\w+)/.exec(className);
    const raw = element.props.children;
    const text = Array.isArray(raw) ? raw.join('') : typeof raw === 'string' ? raw : '';
    return { code: text.replace(/\n$/, ''), language: match?.[1] ?? 'text' };
  }
  return { code: String(children ?? ''), language: 'text' };
}

type PreProps = ComponentProps<'pre'> & { isIncomplete?: boolean; node?: unknown };

export function KikiCodeBlock({ children, isIncomplete }: PreProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const { code, language } = extractCode(children);
  const totalLines = code === '' ? 0 : code.split('\n').length;
  const canCollapse = totalLines > PREVIEW_LINES;

  const copy = () => {
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <div className="kiki-cb my-2 overflow-hidden rounded-lg border border-hairline bg-paper">
      <div className="flex h-7 items-center justify-between border-b border-hairline px-3">
        <span className="font-mono text-[10.5px] tracking-wide text-ink-faint lowercase">
          {language}
        </span>
        <div className="flex items-center gap-1">
          {canCollapse ? (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              title={expanded ? 'Collapse' : 'Expand'}
              className="rounded px-1 py-0.5 font-mono text-[10.5px] text-ink-faint transition-colors hover:text-ink"
            >
              {expanded ? '▴' : '▾'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={copy}
            title="Copy code"
            className={`rounded px-1 py-0.5 font-mono text-[10.5px] transition-colors ${
              copied ? 'text-success' : 'text-ink-faint hover:text-ink'
            }`}
          >
            {copied ? '✓ copied' : 'copy'}
          </button>
        </div>
      </div>

      <div
        className="kiki-cb-body overflow-x-auto"
        style={{
          maxHeight:
            canCollapse && !expanded
              ? `${PREVIEW_LINES * LINE_HEIGHT_PX + BODY_PADDING_PX}px`
              : undefined,
          overflowY: canCollapse && !expanded ? 'hidden' : undefined,
        }}
      >
        <CodeBlock code={code} language={language as never} isIncomplete={isIncomplete ?? false} />
      </div>

      {canCollapse ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center justify-center gap-1 border-t border-hairline py-1 text-[11px] text-ink-faint transition-colors hover:text-ink"
        >
          {expanded ? 'Show less' : `View more (${totalLines - PREVIEW_LINES} lines)`}
          <span aria-hidden>{expanded ? '▴' : '▾'}</span>
        </button>
      ) : null}
    </div>
  );
}
