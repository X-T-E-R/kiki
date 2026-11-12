/**
 * External web URL iframe preview tab.
 */

import { useState } from 'react';

import { openExternalUrl, useHost } from '#/host';
import { useI18n } from '#/i18n';
import { copyTextToClipboard } from '#/lib/clipboard';
import { Icon } from '../icons';
import { HEADER_ACTION_CLASS, webUrlDisplayLabel } from './shared';

export function PreviewWebView({
  tabKey,
  url,
  title,
  visible,
}: {
  readonly tabKey: string;
  readonly url: string;
  readonly title?: string;
  readonly visible: boolean;
}) {
  const host = useHost();
  const { t } = useI18n();
  const [reloadKey, setReloadKey] = useState(0);
  const label = webUrlDisplayLabel(url, title);
  return (
    <div
      role="tabpanel"
      hidden={!visible}
      className={`min-h-0 flex-1 flex-col ${visible ? 'flex' : 'hidden'}`}
      data-preview-tabpanel={tabKey}
      data-preview-web-panel={url}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
        <Icon name="compass" size={12} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-soft" title={url}>
          {url}
        </span>
        <button
          type="button"
          title={t('preview.reload')}
          aria-label={t('preview.reload')}
          data-web-reload
          onClick={() => { setReloadKey((k) => k + 1); }}
          className={HEADER_ACTION_CLASS}
        >
          <Icon name="refresh" size={12} />
        </button>
        <button
          type="button"
          title={t('preview.copyUrl')}
          aria-label={t('preview.copyUrl')}
          data-web-copy-url
          onClick={() => { void copyTextToClipboard(url); }}
          className={HEADER_ACTION_CLASS}
        >
          <Icon name="copy" size={12} />
        </button>
        <button
          type="button"
          data-web-open-external
          onClick={() => { void openExternalUrl(host, url, t('common.popupBlocked')); }}
          className="shrink-0 inline-flex items-center gap-1 rounded-full border border-hairline bg-paper px-2.5 py-0.5 text-[11px] font-medium text-ink transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
        >
          <span>{t('message.openInBrowser')}</span>
          <Icon name="external" size={12} />
        </button>
      </div>
      <div className="flex shrink-0 items-center justify-between border-b border-hairline bg-paper/60 px-3 py-1 text-[11px] text-ink-faint">
        <span className="truncate">{t('preview.webHint')}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-paper">
        <iframe
          key={`${url}:${reloadKey}`}
          title={label}
          data-preview-web
          src={url}
          sandbox="allow-scripts allow-forms allow-popups"
          referrerPolicy="no-referrer"
          className="min-h-0 min-w-0 flex-1 border-0 bg-paper"
        />
      </div>
    </div>
  );
}
