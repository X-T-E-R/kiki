import { useState, type ReactNode } from 'react';

import { useI18n } from '../i18n';
import { useOptionalConnection } from '../state/connection';

function imageUrl(source: string | undefined): URL | undefined {
  if (source === undefined) return undefined;
  try { return new URL(source, document.baseURI); } catch { return undefined; }
}

export function remoteImageUrl(source: string | undefined, serverBaseUrl: string | undefined): URL | undefined {
  const url = imageUrl(source);
  if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin === window.location.origin) return undefined;
  const serverMedia = url.origin === imageUrl(serverBaseUrl)?.origin && /^\/(?:api\/sessions\/[^/]+\/media\/|api\/fs:content$|(?:html|media)-preview\/)/u.test(url.pathname);
  return serverMedia ? undefined : url;
}

export function RemoteImageGate({ source, alt, children }: { source?: string; alt?: string; children: ReactNode }) {
  const client = useOptionalConnection()?.client;
  const { t } = useI18n();
  const [shownSource, setShownSource] = useState<string>();
  const url = remoteImageUrl(source, client?.baseUrl);
  if (url === undefined || shownSource === source) return children;
  const description = alt?.trim();
  return (
    <button
      type="button"
      data-markdown-remote-image=""
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShownSource(source); }}
      className="inline-flex max-w-full items-center gap-2 rounded-lg border border-hairline bg-panel px-2.5 py-1 align-middle font-sans text-[12px] text-ink-faint transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
    >
      <span className="min-w-0 truncate">{description ? `${description} · ` : ''}{url.host}</span>
      <span className="shrink-0 font-medium text-ink">{t('media.showImage')}</span>
    </button>
  );
}
