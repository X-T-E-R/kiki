/**
 * Markdown renderer for assistant/user text, built on Streamdown (streaming-
 * safe incomplete-block parsing, GFM tables/strikethrough/task-lists) with
 * shiki highlighting lazy-loaded via ./streamdown-plugins (codeg's pattern).
 * Fenced code renders through KikiCodeBlock chrome (language + copy +
 * collapse). Typography lives in `.kiki-md` (index.css).
 */

import { memo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Streamdown, defaultRemarkPlugins, type Components } from 'streamdown';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import {
  resolveFileHref,
  unwrapFileLinkTarget,
  wrapFileLinkTarget,
} from '../lib/media';
import { KikiCodeBlock } from './markdown/KikiCodeBlock';
import { useStreamdownPlugins } from './markdown/streamdown-plugins';
import { useMediaPreview } from './mediaPreviewContext';
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

function openExternalLink(url: string): void {
  if (window.open(url, '_blank', 'noreferrer,noopener') === null) {
    throw new Error('The browser blocked the new window.');
  }
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
  url?: string;
  children?: MdastLike[];
}

function remarkLocalFileLinks() {
  return (tree: MdastLike) => {
    const visit = (node: MdastLike) => {
      if (node.type === 'link' && typeof node.url === 'string') {
        const wrapped = wrapFileLinkTarget(node.url);
        if (wrapped !== undefined) node.url = wrapped;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

const REMARK_PLUGINS = [remarkLocalFileLinks];

/**
 * Link renderer: local file paths (absolute, file://, or workspace-relative)
 * open in the file preview pane; app routes keep the client-side Link;
 * everything else is an external anchor. Without a MediaPreviewProvider the
 * file branch falls through to the old behavior.
 *
 * Right-click raises a small menu (G-1): file links get preview/copy-path/
 * copy-absolute plus the desktop opener pair; external links get open/copy.
 */
function MarkdownAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  const host = useHost();
  const { t } = useI18n();
  const preview = useMediaPreview();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const target = href === undefined ? undefined : (unwrapFileLinkTarget(href) ?? href);
  const filePath =
    preview !== null && target !== undefined ? resolveFileHref(target, preview.cwd) : undefined;

  const openMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  };
  const closeMenu = () => { setMenu(null); };

  if (filePath !== undefined && preview !== null && target !== undefined) {
    const entries: MiniMenuEntry[] = [
      { key: 'open-preview', label: t('file.openPreview'), run: () => { preview.openFile(filePath); } },
      { key: 'copy-path', label: t('file.copyPath'), run: () => copyTextToClipboard(target) },
      {
        key: 'copy-absolute',
        label: t('file.copyAbsolutePath'),
        run: () => copyTextToClipboard(filePath),
      },
      ...(host.revealPath !== undefined && host.openPath !== undefined
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
            preview.openFile(filePath);
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
    return <Link to={href}>{children}</Link>;
  }
  const url = href ?? '';
  const entries: MiniMenuEntry[] = [
    { key: 'open-link', label: t('link.open'), run: () => { openExternalLink(url); } },
    { key: 'copy-link', label: t('link.copyLink'), run: () => copyTextToClipboard(url) },
  ];
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
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
          ariaLabel={t('link.menuAria')}
          overlayId="markdown-link"
          dataAttribute="data-link-menu"
        />
      ) : null}
    </>
  );
}

const components: Components = {
  pre: KikiCodeBlock as Components['pre'],
  a: MarkdownAnchor as Components['a'],
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
        // The bare remarkPlugins prop REPLACES Streamdown's defaults, so
        // spread them back in — dropping remark-gfm kills GFM tables,
        // strikethrough, task-lists, and autolinks.
        remarkPlugins={[...Object.values(defaultRemarkPlugins), ...REMARK_PLUGINS]}
        components={components}
        // kiki draws its own chrome; streamdown's built-in action rows stay off.
        controls={{ table: false, code: false, mermaid: false }}
      >
        {text}
      </Streamdown>
    </div>
  );
});
