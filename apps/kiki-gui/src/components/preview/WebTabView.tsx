/**
 * External web URL iframe preview tab.
 */

import { useCallback, useEffect, useState } from 'react';

import { openExternalUrl, useHost } from '#/host';
import { useI18n } from '#/i18n';
import { copyTextToClipboard } from '#/lib/clipboard';
import { Icon } from '../icons';
import {
  BODY_ACTION_CLASS,
  DelayedReadingNotice,
  HEADER_ACTION_CLASS,
  webUrlDisplayLabel,
} from './shared';

const WEB_EMBED_TIMEOUT_MS = 10_000;

export function PreviewWebView({
  tabKey,
  url,
  title,
  visible,
  externalReloadNonce,
  timeoutMs = WEB_EMBED_TIMEOUT_MS,
}: {
  readonly tabKey: string;
  readonly url: string;
  readonly title?: string;
  readonly visible: boolean;
  readonly externalReloadNonce?: number;
  readonly timeoutMs?: number;
}) {
  const host = useHost();
  const { t } = useI18n();
  const [reloadKey, setReloadKey] = useState(0);
  const [frameState, setFrameState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const label = webUrlDisplayLabel(url, title);

  const reload = useCallback(() => {
    setFrameState('loading');
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (externalReloadNonce !== undefined && externalReloadNonce > 0) reload();
  }, [externalReloadNonce, reload]);

  useEffect(() => {
    setFrameState('loading');
    const timer = setTimeout(() => {
      setFrameState((current) => (current === 'loading' ? 'failed' : current));
    }, timeoutMs);
    return () => {
      clearTimeout(timer);
    };
  }, [url, reloadKey, timeoutMs]);

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
          title={t('preview.reloadFile')}
          aria-label={t('preview.reloadFile')}
          data-web-reload
          onClick={reload}
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
      {frameState === 'failed' ? (
        <div
          className="flex min-h-0 flex-1 flex-col items-start gap-3 p-4"
          data-web-embed-failed
        >
          <p className="text-[13px] text-ink-soft" role="alert">
            {t('preview.webFailed')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-web-open-failed
              onClick={() => { void openExternalUrl(host, url, t('common.popupBlocked')); }}
              className={BODY_ACTION_CLASS}
            >
              {t('message.openInBrowser')}
            </button>
            <button
              type="button"
              data-web-retry
              onClick={reload}
              className={BODY_ACTION_CLASS}
            >
              {t('preview.reloadFile')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center justify-between border-b border-hairline bg-paper/60 px-3 py-1 text-[11px] text-ink-faint">
            <span className="truncate">{t('preview.webHint')}</span>
          </div>
          <div className="relative flex min-h-0 flex-1 flex-col bg-paper">
            {frameState === 'loading' ? (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-paper/90" data-web-loading>
                <DelayedReadingNotice active />
              </div>
            ) : null}
            <iframe
              key={`${url}:${reloadKey}`}
              title={label}
              data-preview-web
              src={url}
              onLoad={() => { setFrameState('ready'); }}
              onError={() => { setFrameState('failed'); }}
              sandbox="allow-scripts allow-forms allow-popups"
              referrerPolicy="no-referrer"
              className="min-h-0 min-w-0 flex-1 border-0 bg-paper"
            />
          </div>
        </>
      )}
    </div>
  );
}
