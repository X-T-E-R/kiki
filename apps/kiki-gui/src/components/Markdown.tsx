/**
 * Markdown renderer for assistant/user text, built on Streamdown (streaming-
 * safe incomplete-block parsing, GFM tables/strikethrough/task-lists) with
 * shiki highlighting lazy-loaded via ./streamdown-plugins (codeg's pattern).
 * Fenced code uses KikiCodeBlock chrome; complete Mermaid fences render through
 * the lazy-loaded Streamdown engine. Typography lives in `.kiki-md` (index.css).
 */

import { memo, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Streamdown, defaultRemarkPlugins, defaultRehypePlugins, type Components } from 'streamdown';

import { useHost } from '../host';
import { ExternalLink } from '../host/ExternalLink';
import { openExternalUrl } from '../host/external';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { useOptionalConnection } from '../state/connection';
import { sourceTextVersion, type TimelineAnnotation } from '@kiki/session-core/composer';
import {
  resolveFileReference,
  unwrapFileLinkTarget,
  wrapFileLinkTarget,
} from '@kiki/session-core/composer/media';
import { KikiMarkdownPre } from './markdown/KikiCodeBlock';
import { MarkdownFileImage } from './markdown/MarkdownFileImage';
import { projectTextWithAnnotationMarks, rehypeAnnotationMarks } from './markdown/annotationMarks';
import { useStreamdownPlugins } from './markdown/streamdown-plugins';
import { useMediaPreview } from './mediaPreviewContext';
import { Icon, type IconName } from './icons';
import { MiniContextMenu, type MiniMenuEntry } from './MiniContextMenu';

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

const EXTERNAL_HREF = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

export function isInAppHref(href: string | undefined): href is string {
  return href !== undefined && !EXTERNAL_HREF.test(href);
}

/**
 * The in-app destinations a message may name, matched against the routes the
 * app really registers (`App.tsx`). A link to a page that exists reads as an
 * object reference: it keeps the author's own words as its label, gains the
 * small mark and the route name on hover, and never turns into a heavy card.
 */
const APP_ROUTES: { readonly pattern: RegExp; readonly name: IconName }[] = [
  { pattern: /^\/s\/[^/]+(?:\/.*)?$/, name: 'thread' },
  { pattern: /^\/(?:r|rooms)\/[^/]+(?:\/.*)?$/, name: 'room' },
  { pattern: /^\/board(?:\/|$)/, name: 'board' },
  { pattern: /^\/cron(?:\/|$)/, name: 'clock' },
  { pattern: /^\/memory(?:\/|$)/, name: 'memory' },
  { pattern: /^\/usage(?:\/|$)/, name: 'usage' },
  { pattern: /^\/activity(?:\/|$)/, name: 'clock' },
  { pattern: /^\/capabilities(?:\/|$)/, name: 'persona' },
  { pattern: /^\/personas(?:\/|$)/, name: 'persona' },
  { pattern: /^\/settings(?:\/|$)/, name: 'settings' },
  { pattern: /^\/new(?:\/|$)/, name: 'plus' },
];

/** The route this href names, or undefined when it is not a page the app has. */
function appRouteOf(href: string): { readonly name: IconName } | undefined {
  const [path] = href.split(/[?#]/, 1);
  return path === undefined ? undefined : APP_ROUTES.find((route) => route.pattern.test(path));
}

/**
 * A link into the app: client-side navigation, an object mark, and the same
 * hover/focus treatment as every other control. The author's link text is
 * never replaced — the mark sits beside it, so `[see the contract](/rooms/x)`
 * still says what the writer said.
 */
function InternalLink({ to, children }: { to: string; children: ReactNode }) {
  const route = appRouteOf(to);
  if (route === undefined) return <Link to={to}>{children}</Link>;
  return (
    <Link
      to={to}
      data-internal-link={route.name}
      className="inline-flex items-baseline gap-0.5 rounded-[3px] text-ink no-underline transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
    >
      <Icon name={route.name} size={12} className="shrink-0 translate-y-px text-ink-faint" />
      <span>{children}</span>
    </Link>
  );
}

/**
 * Streamdown's sanitize+harden chain strips `file:`/`C:` hrefs and resolves
 * `./x` against a dummy origin, so the anchor component would never see the
 * original local-file target. This remark plugin runs while link URLs are
 * still pristine and rewrites file-ish targets behind FILE_LINK_SENTINEL
 * (a plain path, which sanitize preserves); MarkdownAnchor unwraps it.
 */
interface MdastLike {
  type?: string;
  /** Source offsets; absent means the node was built, not parsed. */
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  url?: string;
  /** Remark's emphasis markers; kept so a re-cut delimiter stays balanced. */
  open?: string;
  close?: string;
  value?: string;
  children?: MdastLike[];
}

function remarkLocalFileLinks(includeImages = false) {
  return (tree: MdastLike) => {
    const visit = (node: MdastLike) => {
      if ((node.type === 'link' || (includeImages && node.type === 'image')) && typeof node.url === 'string') {
        const target = node.type === 'image' ? node.url.split(/[?#]/, 1)[0]! : node.url;
        const wrapped = wrapFileLinkTarget(target);
        if (wrapped !== undefined) node.url = wrapped;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/**
 * Repair a GFM autolink that ran past the end of its URL into the rest of the
 * line — the shape `**http://127.0.0.1:63474**，浏览器也已打开。` produces.
 *
 * GFM's autolink literal ends a bare URL at ASCII whitespace or GFM's own
 * trailing-punctuation set, and CJK punctuation is in neither. A Chinese
 * sentence with no space after the URL therefore yields ONE link node whose
 * `url` is `http://127.0.0.1:63474**，浏览器也已打开。`, with the closing `**`
 * and the rest of the sentence absorbed. `rehype-harden` then resolves every
 * href with `new URL()`, this one does not parse, and the node came back as a
 * grey `… [blocked]` span with the bold markers showing literally.
 *
 * The fix is to re-cut the link at the last point where the prefix still parses
 * as a URL and hand the swallowed tail back to the paragraph as text. The URL
 * the reader wrote is preserved exactly; a link that already parses is never
 * touched, so ordinary links, file links and autolinks ending in `/` behave
 * exactly as before.
 */
interface VFileLike { value?: unknown }

function remarkSplitAutolinkTail() {
  return (tree: MdastLike, file: VFileLike) => {
    const source = typeof file.value === 'string' ? file.value : undefined;
    const repair = (parent: MdastLike): void => {
      const children = parent.children;
      if (children === undefined) return;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index]!;
        // Only a bare GFM autolink is ever re-cut, and "is one" is decided by
        // the SOURCE the parser read, never by how the node looks. A node whose
        // label equals its url is not evidence of anything: `[https://a:bad](https://a:bad)`
        // and `[https://a:bad]` are explicit syntax that produce exactly that
        // shape. Trimming those would silently invent a different address, so
        // the node's own text span is compared with a bare autolink instead.
        if (child.type === 'link' && typeof child.url === 'string' && !parsesAsUrl(child.url) && isBareAutolink(child, source)) {
          const cut = lastParseablePrefix(child.url);
          if (cut > 0) {
            const url = child.url.slice(0, cut);
            let tail = child.url.slice(cut);
            child.url = url;
            child.children = [{ type: 'text', value: url }];
            // A `**` run left on the text before the link, matched by the same
            // run opening the tail, is the emphasis the writer put around the
            // URL and the autolink stepped over. Re-pairing them here is what
            // brings the bold back instead of showing raw markers.
            const before = index > 0 ? children[index - 1] : undefined;
            const opener = before?.type === 'text' ? trailingMarker(before.value) : undefined;
            const closer = opener === undefined ? 0 : leadingMarker(tail, opener);
            // Only re-pair when the emphasis would actually wrap the link once:
            // an empty tail or an already-wrapped link leaves nothing to do.
            const strong = opener === '**' || opener === '__';
            if (opener !== undefined && closer > 0 && before !== undefined && before.value !== undefined && before.value.trim() !== '') {
              before.value = before.value.slice(0, before.value.length - opener.length);
              tail = tail.slice(closer);
              // Replace the link in place with the emphasis that wraps it, and
              // put the tail after that — one splice, so the pair cannot drift.
              children.splice(index, 1, { type: strong ? 'strong' : 'emphasis', children: [child] }, { type: 'text', value: tail });
              index += 2;
              continue;
            }
            children.splice(index + 1, 0, { type: 'text', value: tail });
          }
        }
        repair(child);
      }
    };
    repair(tree);
  };
}

/**
 * Whether the parser built this link from a bare autolink in the source text.
 *
 * A GFM autolink literal occupies exactly the URL it points at: the span the
 * parser read is the url itself, with no markup around it. Every explicit form
 * wraps or names it — `[text](url)`, `[url]`, `<url>`, or a reference
 * definition — so the span cannot equal the url. When the source is unavailable
 * (a node with no offsets, a programmatically built tree) the answer is false:
 * with no evidence the link is left exactly as it was.
 */
function isBareAutolink(node: MdastLike, source: string | undefined): boolean {
  if (source === undefined) return false;
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined || start < 0 || end > source.length) return false;
  return source.slice(start, end) === node.url;
}

/** A `*`/`_` run at the end of `value`, longest first (`**` before `*`). */
function trailingMarker(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /(\*\*|__|\*|_)$/u.exec(value)?.[1];
}

/** How many leading characters of `text` repeat `marker`; 0 when it does not. */
function leadingMarker(text: string, marker: string): number {
  return text.startsWith(marker) ? marker.length : 0;
}

function parsesAsUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * The last index at which `url` still parses on its own.
 *
 * A `*`/`_` run is never left at the end of the kept prefix: it is an emphasis
 * delimiter that the autolink stepped over, and leaving it inside the URL is
 * what made `rehype-harden` reject the href in the first place.
 */
function lastParseablePrefix(url: string): number {
  for (let end = url.length; end > 0; end -= 1) {
    const candidate = url.slice(0, end);
    if (/[*_]$/u.test(candidate)) continue;
    if (parsesAsUrl(candidate)) return end;
  }
  return 0;
}

const REMARK_PLUGINS = [remarkLocalFileLinks, remarkSplitAutolinkTail];
const DOCUMENT_REMARK_PLUGINS = [
  function remarkDocumentAssets() { return remarkLocalFileLinks(true); },
  remarkSplitAutolinkTail,
];

/**
 * Link renderer: local file paths (absolute, file://, or workspace-relative)
 * open in the file preview pane; app routes keep the client-side Link;
 * everything else is an external anchor. Without a MediaPreviewProvider the
 * file branch falls through to the old behavior.
 *
 * Right-click raises a small menu (G-1): file links get preview/copy-path/
 * copy-absolute plus the desktop opener pair; external links get open/copy.
 */
function MarkdownAnchor({ href, children, documentDirectory }: {
  href?: string; children?: ReactNode; documentDirectory?: string;
}) {
  const host = useHost();
  const { t } = useI18n();
  const preview = useMediaPreview();
  const remoteScope = useOptionalConnection()?.scopeId.startsWith('ssh:') ?? false;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const target = href === undefined ? undefined : (unwrapFileLinkTarget(href) ?? href);
  const fileReference = preview !== null && target !== undefined
    ? resolveFileReference(target, documentDirectory ?? preview.cwd) : undefined;
  const filePath = fileReference?.path;

  const openMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  };
  const closeMenu = () => { setMenu(null); };

  if (filePath !== undefined && preview !== null && target !== undefined) {
    const entries: MiniMenuEntry[] = [
      { key: 'open-preview', label: t('file.openPreview'), run: () => { preview.openFile(fileReference ?? filePath); } },
      { key: 'copy-path', label: t('file.copyPath'), run: () => copyTextToClipboard(target) },
      {
        key: 'copy-absolute',
        label: t('file.copyAbsolutePath'),
        run: () => copyTextToClipboard(filePath),
      },
      ...(!remoteScope && host.revealPath !== undefined && host.openPath !== undefined
        ? [
            { separator: true } as const,
            {
              key: 'show-in-folder',
              label: t('file.showInFolder'),
              run: () => host.revealPath?.(filePath),
            } as const,
            {
              key: 'open-default-app',
              label: t('file.openDefaultApp'),
              run: () => host.openPath?.(filePath),
            } as const,
          ]
        : []),
    ];
    return (
      <>
        <a
          href={href}
          title={filePath}
          onClick={(event) => {
            event.preventDefault();
            preview.openFile(fileReference ?? filePath);
          }}
          onContextMenu={openMenu}
        >
          {children}
        </a>
        {menu !== null ? (
          <MiniContextMenu
            x={menu.x}
            y={menu.y}
            entries={entries}
            onClose={closeMenu}
            ariaLabel={t('file.menuAria')}
            overlayId="markdown-file-link"
            dataAttribute="data-file-link-menu"
          />
        ) : null}
      </>
    );
  }
  // A sentinel-wrapped link that cannot resolve (e.g. relative path without a
  // session cwd) renders as plain text rather than a dead route link.
  if (href !== undefined && unwrapFileLinkTarget(href) !== undefined) {
    return <span>{children}</span>;
  }
  if (isInAppHref(href)) {
    return <InternalLink to={href}>{children}</InternalLink>;
  }
  const url = href ?? '';
  const entries: MiniMenuEntry[] = [
    { key: 'open-link', label: t('link.open'), run: () => openExternalUrl(host, url, t('common.popupBlocked')) },
    { key: 'copy-link', label: t('link.copyLink'), run: () => copyTextToClipboard(url) },
  ];
  return (
    <>
      {/* One rule for every outward link: the desktop webview cannot open a new
          window, so the click is routed through the shell bridge there, while a
          browser keeps its native handling. */}
      <ExternalLink
        href={href ?? ''}
        onContextMenu={openMenu}
      >
        {children}
      </ExternalLink>
      {menu !== null ? (
        <MiniContextMenu
          x={menu.x}
          y={menu.y}
          entries={entries}
          onClose={closeMenu}
          ariaLabel={t('link.menuAria')}
          overlayId="markdown-link"
          dataAttribute="data-link-menu"
        />
      ) : null}
    </>
  );
}

const components: Components = {
  pre: KikiMarkdownPre as Components['pre'],
  a: MarkdownAnchor as Components['a'],
};

export const Markdown = memo(function Markdown({
  text,
  mode = 'streaming',
  documentDirectory,
  preserveEdgeMargins = false,
  annotationTargets,
  sourceBlockId,
}: {
  text: string;
  mode?: 'streaming' | 'static';
  documentDirectory?: string;
  sourceBlockId?: string;
  /** Streaming-prefix chunks keep their natural first/last block margins so
   * adjacent chunks' margins collapse like a single parse; standalone usage
   * zeroes them (see `.kiki-md--edges` in index.css). */
  preserveEdgeMargins?: boolean;
  /**
   * Timeline annotations anchored to this block's text: the quoted passage is
   * wrapped in a `<mark data-annotation-ref>` (identity-stable array from the
   * transcript — a fresh one each render defeats this memo).
   */
  annotationTargets?: readonly TimelineAnnotation[];
}) {
  const plain = isPlainProse(text);
  const plugins = useStreamdownPlugins(plain ? null : text);
  const className = preserveEdgeMargins ? 'kiki-md kiki-md--edges' : 'kiki-md';
  // The mark plugin runs after the default sanitize/harden pair, so neither
  // strips the injected `<mark data-annotation-ref>`; spreading the defaults
  // back in is required because the prop REPLACES them (same rule as remark).
  const rehypePlugins = useMemo(
    () =>
      annotationTargets === undefined || annotationTargets.length === 0
        ? undefined
        : [...Object.values(defaultRehypePlugins), rehypeAnnotationMarks(annotationTargets)],
    [annotationTargets],
  );
  // Streamdown's own memo does not compare rehypePlugins, so an annotation
  // arriving after this message already rendered would never reach the mark
  // plugin. Keying by the target ids remounts exactly when this block's
  // annotation set changes; the transcript keeps the array identity stable
  // otherwise (useStableAnnotationTargets), so unrelated renders never thrash.
  const annotationKey = JSON.stringify(annotationTargets ?? []);
  const renderers = useMemo<Components>(() => {
    const next: Components = { ...components };
    if (documentDirectory !== undefined) {
      next.a = (props) => <MarkdownAnchor {...props} documentDirectory={documentDirectory} />;
      next.img = (props) => <MarkdownFileImage {...props} documentDirectory={documentDirectory} />;
    }
    if (annotationTargets?.length) next.code = ({ children, className }) => <code className={className}>{children}</code>;
    return next;
  }, [documentDirectory, annotationTargets]);
  if (plain) {
    return (
      <div className={className} data-source-block-id={sourceBlockId} data-source-version={sourceBlockId === undefined ? undefined : sourceTextVersion(text)}>
        <p>
          {annotationTargets === undefined || annotationTargets.length === 0
            ? text
            : projectTextWithAnnotationMarks(text, annotationTargets)}
        </p>
      </div>
    );
  }
  return (
    <div className={className} data-source-block-id={sourceBlockId} data-source-version={sourceBlockId === undefined ? undefined : sourceTextVersion(text)}>
      <Streamdown
        key={annotationKey}
        mode={annotationTargets?.length ? 'static' : mode}
        parseIncompleteMarkdown={mode === 'streaming' && !annotationTargets?.length}
        plugins={plugins}
        // The bare remarkPlugins prop REPLACES Streamdown's defaults, so
        // spread them back in — dropping remark-gfm kills GFM tables,
        // strikethrough, task-lists, and autolinks.
        remarkPlugins={[...Object.values(defaultRemarkPlugins), ...(documentDirectory === undefined
          ? REMARK_PLUGINS : DOCUMENT_REMARK_PLUGINS)]}
        rehypePlugins={rehypePlugins}
        components={renderers}
        // Streamdown's link safety defaults to ON and blocks any href it
        // cannot open, drawing it as a greyed "Blocked URL" chip that is not a
        // link at all. It is a click-time "open this external page?" prompt,
        // not a security boundary: the URI sanitizer already ran (javascript:
        // and data: never survive), and Kiki routes every external click
        // through `openExternalUrl` and every in-app one through the router.
        // Leaving it on also swallowed a bare `127.0.0.1:63474` that a GFM
        // autolink had absorbed a trailing `**` into, so a bold preview URL
        // read as literal markdown next to a broken bold marker. The real
        // boundaries — the sanitizer and our own anchor — stay on.
        linkSafety={{ enabled: false }}
        // kiki draws its own chrome; streamdown's built-in action rows stay off.
        controls={{ table: false, code: false, mermaid: false }}
      >
        {text}
      </Streamdown>
    </div>
  );
});
