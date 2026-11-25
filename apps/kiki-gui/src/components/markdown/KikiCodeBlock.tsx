/**
 * KikiCodeBlock — quiet code-block chrome for markdown fences: hover-revealed
 * language label + copy in the corner, and collapse for long blocks ("View more (N lines)").
 *
 * Chrome pattern adapted from aionui (https://github.com/AionUi/AionUi —
 * `packages/desktop/src/renderer/components/Markdown/CodeBlock.tsx`,
 * Apache-2.0): fixed preview height, footer toggle, copy feedback. The actual
 * highlighting is Streamdown's exported `CodeBlock` (shiki via the lazily
 * loaded `@streamdown/code` plugin), rendered inside our chrome with its own
 * header/actions suppressed (scoped CSS in index.css) so nothing is
 * duplicated. Only a fence longer than 40 lines collapses, to a 12-line
 * preview (aionui collapses at 3), so the usual block in a coding reply reads
 * in full without a click.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { CodeBlock } from 'streamdown';

import { canonicalSelectionText } from '@kiki/session-core/composer';
import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import { afterPaint } from '../../lib/afterPaint';
import { useMediaQuery, usePhoneMode } from '../../lib/layoutHooks';
import { pushToast } from '../../lib/toasts';
import { Icon } from '../icons';
import { registerCodeBlockBody, unwrapDomAnnotationMarks } from './domAnnotationMarks';
import { useMermaidEngine } from './streamdown-plugins';

/** A settled fence longer than this collapses behind "View more". */
const COLLAPSE_AFTER_LINES = 40;
/** Lines a collapsed fence still shows. */
const PREVIEW_LINES = 12;
const CODE_LINE_HEIGHT = 1.55;
const BODY_PADDING_PX = 20;

function codeText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(codeText).join('');
  if (node !== null && typeof node === 'object' && 'props' in node) {
    const props = (node as ReactElement<{
      children?: ReactNode;
      'data-annotation-bubble'?: string;
      'data-source-ignore'?: string;
    }>).props;
    if (props['data-annotation-bubble'] !== undefined || props['data-source-ignore'] === 'true') return '';
    return codeText(props.children);
  }
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}

function hasAnnotation(node: ReactNode): boolean {
  if (Array.isArray(node)) return node.some(hasAnnotation);
  if (node === null || typeof node !== 'object' || !('props' in node)) return false;
  const props = (node as ReactElement<{ children?: ReactNode; 'data-annotation-ref'?: string }>).props;
  return props['data-annotation-ref'] !== undefined || hasAnnotation(props.children);
}

function extractCode(children: ReactNode): { code: string; language: string } {
  const element = children as ReactElement<{ className?: string }> | null;
  const match = /language-([\w-]+)/.exec(element?.props?.className ?? '');
  return { code: codeText(children).replace(/\n$/, ''), language: match?.[1] ?? 'text' };
}

type PreProps = ComponentProps<'pre'> & { isIncomplete?: boolean; node?: unknown };
let nextDiagramId = 0;

function KikiMermaidBlock({ children, isIncomplete }: PreProps) {
  const { code } = extractCode(children);
  const engine = useMermaidEngine();
  const [rendered, setRendered] = useState<{ source: string; url: string } | null>(null);

  useEffect(() => {
    if (engine === null || isIncomplete === true || code === '') return;
    let active = true;
    let url: string | undefined;
    const id = `kiki-mermaid-${++nextDiagramId}`;
    void engine.getMermaid().render(id, code).then(({ svg }) => {
      if (!active) return;
      url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      setRendered({ source: code, url });
    }).catch(() => { if (active) setRendered(null); });
    return () => {
      active = false;
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, [code, engine, isIncomplete]);

  if (rendered?.source !== code || isIncomplete === true) {
    return <KikiCodeBlock isIncomplete={isIncomplete}>{children}</KikiCodeBlock>;
  }
  return (
    <div className="kiki-md-mermaid my-3 overflow-x-auto rounded-[10px] border border-hairline bg-panel p-3">
      <img src={rendered.url} alt={code} className="mx-auto h-auto max-w-full" />
    </div>
  );
}

export function KikiMarkdownPre(props: PreProps) {
  const { language } = extractCode(props.children);
  return language === 'mermaid' ? <KikiMermaidBlock {...props} /> : <KikiCodeBlock {...props} />;
}

export function KikiCodeBlock({ children, isIncomplete }: PreProps) {
  const { t } = useI18n();
  const phoneMode = usePhoneMode() || useMediaQuery('(max-width: 767px)');
  // The open/closed decision is taken once, when the block first renders: a
  // fence still streaming in is never clamped (the reader is watching it
  // grow), and once it settles it stays open rather than snapping shut under
  // the reader's eyes. Only a block that first renders settled (history, a
  // reload, a row scrolled back into view) starts collapsed.
  const [expanded, setExpanded] = useState(isIncomplete === true);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { code, language } = extractCode(children);
  const lines = code === '' ? [] : code.split('\n');
  const totalLines = lines.length;
  const canCollapse = isIncomplete !== true && totalLines > COLLAPSE_AFTER_LINES;
  const collapsed = canCollapse && !expanded;
  const plainPhonePreview = collapsed && phoneMode;
  const previewCode = plainPhonePreview ? lines.slice(0, PREVIEW_LINES).join('\n') : code;
  const omittedCanonicalChars = plainPhonePreview
    ? canonicalSelectionText(code.slice(previewCode.length)).length
    : 0;
  const [highlight, setHighlight] = useState(false);
  const annotated = hasAnnotation(children);
  const canHighlight = !plainPhonePreview && !annotated && language !== 'text' && language !== 'mermaid';
  const usesAsyncHighlight = !annotated && !plainPhonePreview && highlight && canHighlight;

  useEffect(() => {
    if (!canHighlight || highlight) return;
    if (!phoneMode) {
      return afterPaint(() => { setHighlight(true); });
    }
    let cancelled = false;
    let idleId: number | null = null;
    const timer = setTimeout(() => {
      if (cancelled) return;
      const win = window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        cancelIdleCallback?: (id: number) => void;
      };
      if (typeof win.requestIdleCallback === 'function') {
        idleId = win.requestIdleCallback(() => {
          idleId = null;
          if (!cancelled) setHighlight(true);
        }, { timeout: 600 });
      } else {
        setHighlight(true);
      }
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      const win = window as Window & { cancelIdleCallback?: (id: number) => void };
      if (idleId !== null && typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(idleId);
      }
    };
  }, [canHighlight, highlight, phoneMode]);

  useLayoutEffect(() => {
    if (!usesAsyncHighlight || bodyRef.current === null) return;
    return registerCodeBlockBody(code, bodyRef.current);
  }, [usesAsyncHighlight, code, language]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
  }, []);

  const copy = () => {
    void copyTextToClipboard(code)
      .then(() => {
        setCopied(true);
        if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => {
          copyTimerRef.current = null;
          setCopied(false);
        }, 1500);
      })
      // Both clipboard paths failed: say so, or the click looks dead.
      .catch(() => { pushToast({ tone: 'error', text: t('transcript.copyFailed') }); });
  };

  return (
    <div
      data-collapsed={collapsed || undefined}
      className="kiki-cb my-3 overflow-hidden rounded-[10px] border border-hairline bg-panel"
    >
      {/* Corner tools on desktop hover/focus; in-flow header strip on touch/narrow viewports (markdown.css). */}
      <div
        data-copied={copied || undefined}
        className="kiki-cb-tools select-none absolute top-1.5 right-1.5 z-[1] flex items-center gap-0.5 rounded-md bg-panel/90 pl-2"
      >
        {language !== 'text' ? (
          <span className="pr-1 font-sans text-[12px] text-ink-faint">{language}</span>
        ) : null}
        <button
          type="button"
          onClick={copy}
          title={t('cb.copyTitle')}
          aria-label={t('cb.copyTitle')}
          className={`kiki-cb-copy inline-flex min-h-7 items-center gap-1 rounded-md px-2 font-sans text-[12px] font-normal transition-colors ${
            copied ? 'text-success' : 'text-ink-soft hover:bg-paper hover:text-ink'
          }`}
        >
          {copied ? <Icon name="check" size={12} /> : null}
          {copied ? t('cb.copied') : t('cb.copy')}
        </button>
      </div>

      <div
        ref={bodyRef}
        className="kiki-cb-body overflow-x-auto"
        style={{
          maxHeight: collapsed
            ? `calc(${PREVIEW_LINES * CODE_LINE_HEIGHT} * var(--kiki-code-font-size, 12.5px) + ${BODY_PADDING_PX}px)`
            : undefined,
          overflowY: collapsed ? 'hidden' : undefined,
        }}
      >
        {annotated ? (
          <div data-streamdown="code-block-body"><pre className="font-mono whitespace-pre">{children}</pre></div>
        ) : plainPhonePreview || !highlight || !canHighlight ? (
          <div
            data-streamdown="code-block-body"
            data-plain-preview={plainPhonePreview || undefined}
            data-source-omitted-canonical-chars={omittedCanonicalChars > 0 ? String(omittedCanonicalChars) : undefined}
          >
            <pre className="font-mono whitespace-pre"><code>{previewCode}</code></pre>
          </div>
        ) : (
          <CodeBlock code={code} language={language as never} isIncomplete={isIncomplete ?? false} />
        )}
      </div>

      {canCollapse ? (
        <button
          type="button"
          onClick={() => {
            if (bodyRef.current !== null) unwrapDomAnnotationMarks(bodyRef.current);
            setExpanded((value) => !value);
          }}
          aria-expanded={expanded}
          className="kiki-cb-toggle flex min-h-7 w-full items-center justify-center gap-1 border-t border-hairline font-sans text-[12px] text-ink-faint transition-colors hover:bg-paper/60 hover:text-ink"
        >
          {expanded ? t('cb.showLess') : t('cb.viewMore', { count: totalLines - PREVIEW_LINES })}
          <Icon name="chevron" size={12} className={expanded ? '-rotate-90' : 'rotate-90'} />
        </button>
      ) : null}
    </div>
  );
}
