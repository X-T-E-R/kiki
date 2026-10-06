/**
 * Plugin panel host — renders a plugin's panel HTML in a sandboxed iframe and
 * relays its requests to the REST bridge.
 *
 * Contract (plugin REST contract, "P2 panels"): `srcdoc` = the served HTML,
 * `sandbox="allow-scripts"` exactly — never `allow-same-origin` — so the
 * frame has an opaque origin and cannot reach the parent DOM, cookies or the
 * bearer token. The host accepts a message only when it comes from this
 * iframe's window with origin `'null'`, and pins plugin/panel/session from
 * its own props: ids inside the payload are never trusted. Requests are
 * bounded (rate and size) and answered with `kind:'response'`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { PluginUsageTarget } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { useHost } from '../../host';
import { openExternalUrl } from '../../host/external';
import { bridgeBody, isPanelRequest, panelWebUrl, PANEL_CHANNEL as CHANNEL } from './pluginPanelBridge';
export { bridgeBody } from './pluginPanelBridge';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { InlineError } from '../controls';
import { Spinner } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { scopeKey } from './pluginUsage';

const MAX_REQUESTS_PER_WINDOW = 20;
const RATE_WINDOW_MS = 10_000;

export function PluginPanelHost({
  pluginId,
  panelId,
  label,
  sessionId,
  target,
  className = 'h-full min-h-[420px] w-full',
}: {
  readonly pluginId: string;
  readonly panelId: string;
  readonly label: string;
  /** The session the panel acts on; absent → the panel runs without one. */
  readonly sessionId?: string;
  /**
   * The scope the document is served for. A workspace panel is served only for
   * the target that asked for it, so the key carries it and switching scope
   * cannot reuse the other scope's document — which would leave an executable
   * panel behind after it is closed.
   */
  readonly target?: PluginUsageTarget;
  readonly className?: string;
}) {
  const { client } = useConnection();
  const host = useHost();
  const { t, locale } = useI18n();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const recent = useRef<number[]>([]);
  const [loaded, setLoaded] = useState(false);
  const targetKey = scopeKey(target);
  const documentQuery = useQuery({
    queryKey: ['plugin-panel-document', pluginId, panelId, targetKey],
    queryFn: () => client.getPluginPanelDocument(pluginId, panelId, target),
    staleTime: 60_000,
    retry: false,
  });

  const post = useCallback((message: unknown) => {
    frameRef.current?.contentWindow?.postMessage(message, '*');
  }, []);

  // Init once the frame document has loaded, and again when the pinned
  // session changes under an already-loaded panel.
  useEffect(() => {
    if (!loaded) return;
    post({ channel: CHANNEL, kind: 'init', sessionId: sessionId ?? null });
  }, [loaded, sessionId, post]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow || event.origin !== 'null') return;
      if (!isPanelRequest(event.data)) return;
      const request = event.data;
      const respond = (ok: boolean, payload: { result?: unknown; error?: string }) => {
        post({ channel: CHANNEL, kind: 'response', id: request.id, ok, ...payload });
      };
      const now = Date.now();
      recent.current = recent.current.filter((stamp) => now - stamp < RATE_WINDOW_MS);
      if (recent.current.length >= MAX_REQUESTS_PER_WINDOW) {
        respond(false, { error: 'rate limited' });
        return;
      }
      recent.current.push(now);
      if (request.method === 'plugin.openExternal') {
        try {
          void openExternalUrl(host, panelWebUrl(request.url), t('common.popupBlocked'))
            .then(() => respond(true, { result: true }))
            .catch((error: unknown) => respond(false, { error: errorText(locale, error) }));
        } catch (error) { respond(false, { error: errorText(locale, error) }); }
        return;
      }
      if (request.method === 'plugin.installPrerequisite') {
        if (request.consent !== true || typeof request.prerequisiteId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.prerequisiteId)) {
          respond(false, { error: 'Choose Install to allow downloading this dependency' });
          return;
        }
        void client.installPluginPrerequisite(pluginId, request.prerequisiteId)
          .then((result) => respond(true, { result }))
          .catch((error: unknown) => respond(false, { error: errorText(locale, error) }));
        return;
      }
      const body = bridgeBody(request, sessionId);
      if (typeof body === 'string') {
        respond(false, { error: body });
        return;
      }
      client.callPluginPanelBridge(pluginId, panelId, body)
        .then((response) => { respond(true, { result: response.result }); })
        .catch((error: unknown) => { respond(false, { error: errorText(locale, error) }); });
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); };
  }, [client, host, pluginId, panelId, sessionId, locale, post, t]);

  if (documentQuery.isPending) {
    return (
      <p className="flex items-center gap-2 p-4 text-[13px] text-ink-faint" role="status">
        <Spinner label={t('cap.loading')} />{t('cap.panel.loading')}
      </p>
    );
  }
  if (documentQuery.isError) {
    return (
      <div className="space-y-2 p-4" data-plugin-panel-error>
        <InlineError error={documentQuery.error} />
        <button type="button" className={SECONDARY_BUTTON} onClick={() => { void documentQuery.refetch(); }}>{t('common.retry')}</button>
      </div>
    );
  }
  return (
    <iframe
      ref={frameRef}
      title={label}
      srcDoc={documentQuery.data.html}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={() => { setLoaded(true); }}
      data-plugin-panel={`${pluginId}:${panelId}`}
      className={`${className} block border-0 bg-paper`}
    />
  );
}
