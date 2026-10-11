/**
 * ExternalLink — the one anchor for a URL that leaves the app.
 *
 * A plain `<a target="_blank">` only works where the host renderer *is* a
 * browser. The desktop webview is not one: its new-window handling is not a
 * browser window, so the click opened nothing at all — silently, with no
 * error the user could act on. That is why every settings link and OAuth
 * sign-in button read as "the link does nothing", while the paths that went
 * through `openExternalUrl` (markdown links, device sign-in) worked: they
 * route through the shell bridge.
 *
 * So this component makes the bridge the single route, at the element level:
 * the anchor keeps its real `href` (middle-click, copy-link, and a browser
 * with no bridge all keep working), and the click is intercepted only when a
 * native opener exists — exactly the rule the Markdown renderer already used
 * by hand. On a host without one the browser handles the click natively.
 *
 * A failed open is reported through `onOpenFailed` rather than swallowed, so
 * the caller can show the one thing that helps: the address, for a person to
 * open themselves. Nothing is silently dropped.
 */

import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';

import { useHost } from '.';
import { openExternalUrl } from './external';
import { useI18n } from '../i18n';
import { runToastAction } from '../lib/toasts';

export interface ExternalLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** The destination. Must be http(s); the native opener accepts nothing else. */
  readonly href: string;
  /**
   * Called when the open could not be handed to a browser. Pass a handler when
   * the page has somewhere of its own to show it; otherwise the failure is
   * reported as a toast, so it is never silent.
   */
  readonly onOpenFailed?: () => void;
  readonly children: ReactNode;
}

export function ExternalLink({ href, onOpenFailed, onClick, children, ...rest }: ExternalLinkProps) {
  const host = useHost();
  const { t } = useI18n();

  return (
    <a
      {...rest}
      href={href}
      // The anchor keeps its real browser semantics — a new tab, and no
      // referrer or opener leaking to the destination — so middle-click,
      // copy-link and any host without a native opener all behave.
      target={rest.target ?? '_blank'}
      rel={rest.rel ?? 'noopener noreferrer'}
      {...(onClick === undefined ? {} : { onClick })}
      onClickCapture={(event: MouseEvent<HTMLAnchorElement>) => {
        // A browser host opens this natively; do not intercept a real browser.
        if (host.openUrl === undefined) return;
        // Let the browser handle a modified click (new tab, download, copy).
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        // Only the browser's own navigation is suppressed. The event is *not*
        // stopped: a caller that passes onClick (a menu opening, an analytics
        // hook) still has to see it, and this handler must not take that away.
        event.preventDefault();
        const failed = () => {
          if (onOpenFailed !== undefined) { onOpenFailed(); return; }
          // A link that did not open and said nothing is indistinguishable from
          // a broken button, so the failure is stated rather than swallowed.
          runToastAction(t('link.open'), () => Promise.reject(new Error(t('common.popupBlocked'))));
        };
        void openExternalUrl(host, href, t('common.popupBlocked'))
          .then(() => undefined, failed);
      }}
    >
      {children}
    </a>
  );
}