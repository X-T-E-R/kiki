/**
 * Plugin panel host — renders a plugin's panel HTML in a sandboxed iframe and
 * relays its requests to the REST bridge.
 *
 * Contract (plugin REST contract, "P2 panels"): a returned `url` is resolved
 * against the client base URL for `src`; without one, `html` is loaded as
 * `srcdoc`. `sandbox="allow-scripts"` exactly — never `allow-same-origin` — so the
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
import { useI18n } from '../../i18n';
import * as connectionState from '../../state/connection';
import {
  bridgeBody,
  isPanelRequest,
  panelWebUrl,
  PANEL_CHANNEL as CHANNEL,
  PluginPanelStreamBridge,
  isPluginPanelStreamName,
} from './pluginPanelBridge';
import { scopeKey } from './pluginUsage';
import { InlineError } from '../controls';
import { Spinner } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
export { bridgeBody } from './pluginPanelBridge';

export const MAX_REQUESTS_PER_WINDOW = 150;
const RATE_WINDOW_MS = 10_000;
const PANEL_DOCUMENT_STALE_TIME_MS = 5 * 60_000;
const PANEL_GRANT_SAFE_REUSE_MS = 8 * 60_000;

interface PinnedPanelDocument {
  readonly identity: string;
  readonly sourceDoc: { readonly html: string; readonly url?: string };
  readonly html: string;
  readonly url?: string;
  readonly needsFreshGrant: boolean;
}

export function PluginPanelHost({
  pluginId,
  panelId,
  label,
  title,
  sessionId,
  workspaceId,
  target,
  variant = 'card',
  className,
}: {
  readonly pluginId: string;
  readonly panelId: string;
  readonly label?: string;
  /** Alias for `label` used by workspace tab hosts. */
  readonly title?: string;
  /** The session the panel acts on; absent → the panel runs without one. */
  readonly sessionId?: string;
  /** Optional workspace id shortcut when `target` is not explicitly provided. */
  readonly workspaceId?: string;
  /**
   * The scope the document is served for. A workspace panel is served only for
   * the target that asked for it, so the key carries it and switching scope
   * cannot reuse the other scope's document — which would leave an executable
   * panel behind after it is closed.
   */
  readonly target?: PluginUsageTarget;
  /** `'card'` preserves `/capabilities` drawer sizing; `'workspace'` fills 100% inside `PreviewWorkspace`. */
  readonly variant?: 'card' | 'workspace';
  readonly className?: string;
}) {
  const connection =
    'useOptionalConnection' in connectionState && typeof connectionState.useOptionalConnection === 'function'
      ? connectionState.useOptionalConnection()
      : connectionState.useConnection();
  const client = connection?.client ?? connectionState.useConnection().client;
  const host = useHost();
  const { t, locale } = useI18n();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const recent = useRef<number[]>([]);
  const pinnedRef = useRef<PinnedPanelDocument | null>(null);
  const lastObservedRef = useRef<{
    readonly identity: string;
    readonly doc: { readonly html: string; readonly url?: string };
  } | null>(null);
  const [loadSeq, setLoadSeq] = useState(0);
  const effectiveLabel = label ?? title ?? panelId;
  const effectiveTarget: PluginUsageTarget | undefined =
    target ??
    (workspaceId !== undefined && workspaceId !== ''
      ? { workspace_id: workspaceId }
      : sessionId !== undefined && sessionId !== ''
        ? { session_id: sessionId }
        : undefined);
  const targetKey = scopeKey(effectiveTarget);
  const streamSessionId = sessionId !== undefined && sessionId !== ''
    ? sessionId
    : effectiveTarget !== undefined && 'session_id' in effectiveTarget ? effectiveTarget.session_id : undefined;
  const streamWorkspaceId = effectiveTarget !== undefined && 'workspace_id' in effectiveTarget
    ? effectiveTarget.workspace_id
    : undefined;
  const scopeId =
    connection !== null && connection !== undefined && 'scopeId' in connection && typeof connection.scopeId === 'string'
      ? connection.scopeId
      : '';
  const serverId =
    connection !== null &&
    connection !== undefined &&
    'meta' in connection &&
    connection.meta !== null &&
    connection.meta !== undefined &&
    typeof (connection.meta as { server_id?: unknown }).server_id === 'string'
      ? (connection.meta as { server_id: string }).server_id
      : '';
  const baseOrigin = client.baseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  const documentIdentity = `${scopeId}\0${serverId}\0${baseOrigin}\0${pluginId}\0${panelId}\0${targetKey}`;
  const streamIdentity = `${documentIdentity}\0${streamSessionId ?? ''}`;
  const resolvedClassName =
    className ??
    (variant === 'workspace'
      ? 'h-full min-h-0 min-w-0 w-full flex-1'
      : 'h-full min-h-[420px] w-full');
  const documentQuery = useQuery({
    queryKey: ['plugin-panel-document', pluginId, panelId, targetKey, serverId, baseOrigin],
    queryFn: () => client.getPluginPanelDocument(pluginId, panelId, effectiveTarget),
    staleTime: PANEL_DOCUMENT_STALE_TIME_MS,
    gcTime: PANEL_GRANT_SAFE_REUSE_MS,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const post = useCallback((message: unknown, transfer?: Transferable[]) => {
    const target = frameRef.current?.contentWindow;
    if (target === null || target === undefined) return false;
    if (transfer === undefined) target.postMessage(message, '*');
    else target.postMessage(message, '*', transfer);
    return true;
  }, []);
  const streamBridgeRef = useRef<PluginPanelStreamBridge | null>(null);
  streamBridgeRef.current ??= new PluginPanelStreamBridge();
  const streamScopeRef = useRef<{ identity: string; document: object | undefined; version: number }>({
    identity: streamIdentity,
    document: undefined,
    version: 0,
  });
  if (streamScopeRef.current.identity !== streamIdentity) {
    streamScopeRef.current = { ...streamScopeRef.current, identity: streamIdentity, version: streamScopeRef.current.version + 1 };
  }

  // Init once the frame document has loaded, and again when the pinned
  // session changes under an already-loaded panel.
  useEffect(() => {
    if (loadSeq === 0) return;
    post({ channel: CHANNEL, kind: 'init', sessionId: sessionId ?? null });
  }, [loadSeq, sessionId, post]);

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
      if (request.method === 'plugin.openStream') {
        if (!isPluginPanelStreamName(request.stream)) {
          respond(false, { error: 'invalid stream' });
          return;
        }
        const frameWindow = frame.contentWindow;
        const streamScope = { ...streamScopeRef.current };
        const isCurrent = () => frameRef.current === frame && frame.contentWindow === frameWindow
          && streamScopeRef.current.identity === streamScope.identity
          && streamScopeRef.current.document === streamScope.document
          && streamScopeRef.current.version === streamScope.version;
        void streamBridgeRef.current!.open({
          client,
          pluginId,
          panelId,
          request,
          context: { session_id: streamSessionId, workspace_id: streamWorkspaceId },
          isCurrent,
          respond: (message, transfer) => isCurrent() && post(message, transfer),
        }).catch((error: unknown) => { if (isCurrent()) respond(false, { error: errorText(locale, error) }); });
        return;
      }
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
  }, [client, host, pluginId, panelId, sessionId, locale, post, t, streamIdentity, streamSessionId, streamWorkspaceId]);

  const panelDocument = documentQuery.data;
  if (panelDocument !== undefined) {
    if (lastObservedRef.current?.doc !== panelDocument) {
      lastObservedRef.current = { identity: documentIdentity, doc: panelDocument };
    }
    const freshMintedAt = documentQuery.dataUpdatedAt || Date.now();
    const currentPinned = pinnedRef.current;
    const identityChanged = currentPinned !== null && currentPinned.identity !== documentIdentity;
    const staleFromPreviousIdentity = lastObservedRef.current.identity !== documentIdentity;
    if (
      currentPinned === null ||
      identityChanged ||
      currentPinned.html !== panelDocument.html ||
      (currentPinned.url === undefined) !== (panelDocument.url === undefined) ||
      (currentPinned.needsFreshGrant && !staleFromPreviousIdentity && panelDocument !== currentPinned.sourceDoc)
    ) {
      pinnedRef.current = {
        identity: documentIdentity,
        sourceDoc: panelDocument,
        html: panelDocument.html,
        url: panelDocument.url,
        needsFreshGrant:
          staleFromPreviousIdentity ||
          (panelDocument.url !== undefined && Date.now() - freshMintedAt >= PANEL_GRANT_SAFE_REUSE_MS),
      };
    }
  }
  const activeDocument =
    pinnedRef.current !== null && pinnedRef.current.identity === documentIdentity
      ? pinnedRef.current
      : undefined;
  if (streamScopeRef.current.document !== activeDocument) {
    streamScopeRef.current = {
      ...streamScopeRef.current,
      document: activeDocument,
      version: streamScopeRef.current.version + 1,
    };
  }
  useEffect(() => {
    const scope = { ...streamScopeRef.current };
    return () => {
      if (streamScopeRef.current.identity === scope.identity && streamScopeRef.current.document === scope.document
        && streamScopeRef.current.version === scope.version) {
        streamScopeRef.current = { ...scope, version: scope.version + 1 };
      }
      streamBridgeRef.current?.closeAll();
    };
  }, [streamIdentity, activeDocument]);

  if (activeDocument === undefined) {
    if (documentQuery.isPending) {
      return (
        <div className={variant === 'workspace' ? 'flex min-h-0 flex-1 items-start p-4' : 'p-4'}>
          <p className="flex items-center gap-2 text-[13px] text-ink-faint" role="status">
            <Spinner label={t('cap.loading')} />{t('cap.panel.loading')}
          </p>
        </div>
      );
    }
    if (documentQuery.isError) {
      return (
        <div className={`space-y-2 p-4 ${variant === 'workspace' ? 'min-h-0 flex-1' : ''}`} data-plugin-panel-error>
          <InlineError error={documentQuery.error} />
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { void documentQuery.refetch(); }}>{t('common.retry')}</button>
        </div>
      );
    }
    return null;
  }
  return (
    <iframe
      ref={frameRef}
      title={effectiveLabel}
      src={activeDocument.url === undefined ? undefined : new URL(activeDocument.url, client.baseUrl || window.location.origin).toString()}
      srcDoc={activeDocument.url === undefined ? activeDocument.html : undefined}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={() => {
        recent.current = [];
        streamScopeRef.current = { ...streamScopeRef.current, version: streamScopeRef.current.version + 1 };
        streamBridgeRef.current?.closeAll();
        setLoadSeq((seq) => seq + 1);
      }}
      data-plugin-panel={`${pluginId}:${panelId}`}
      data-plugin-panel-variant={variant}
      className={`${resolvedClassName} block border-0 bg-paper`}
    />
  );
}
