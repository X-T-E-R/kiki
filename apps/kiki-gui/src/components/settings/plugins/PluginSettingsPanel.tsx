/**
 * A plugin's own settings panel, on its settings page only.
 *
 * The document is the same opaque-origin sandbox as every other panel
 * (`sandbox="allow-scripts"`, never `allow-same-origin`). `plugin.call` still
 * goes through the panel bridge. Reading and saving settings does not: the
 * frame has no token, so this page answers `plugin.settings.get` /
 * `plugin.settings.patch` with the settings routes the form already uses.
 * `plugin.dirty` is the unsaved bit the page guard already watches.
 *
 * The frame cannot see the host's fonts, CSS variables or i18n, so `init`
 * carries an optional `presentation` — locale, resolved theme and the live
 * color tokens the panel needs — and a `presentation` message pushes updates
 * when the theme or locale flips. Everything in it is optional: a panel from
 * before this field keeps working, and a host that never sends it leaves the
 * panel on its own defaults.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n, type Locale } from '../../../i18n';
import { prefersDark, type ResolvedTheme } from '../../../lib/theme';
import { useConnection } from '../../../state/connection';
import { PluginSettingsForm } from '../../capabilities/PluginSettingsForm';
import { bridgeBody, isPanelRequest, PANEL_CHANNEL as CHANNEL, type PanelRequest } from '../../capabilities/pluginPanelBridge';
import { InlineError } from '../../controls';
import { useDirtyReporter } from '../../dirtyGuard';
import { Spinner } from '../../icons';
import { SECONDARY_BUTTON } from '../../ui';

const MAX_REQUESTS_PER_WINDOW = 20;
const RATE_WINDOW_MS = 10_000;

/**
 * The presentation context a settings panel may opt into. Locale and theme are
 * the host's current choices; tokens are the live values of the few custom
 * properties a panel needs, read from the host root so a skin or a palette
 * change carries into the frame. Every field is optional on the wire.
 */
export interface PanelPresentation {
  readonly locale: Locale;
  readonly theme: ResolvedTheme;
  readonly tokens?: Record<string, string>;
}

/** The tokens a settings panel can reasonably ask for; kept in one list so the frame contract stays explicit. */
const PRESENTATION_TOKEN_KEYS = [
  '--color-paper',
  '--color-panel',
  '--color-hairline',
  '--color-hairline-strong',
  '--color-ink',
  '--color-ink-soft',
  '--color-ink-faint',
  '--color-accent',
  '--color-accent-deep',
  '--color-on-accent',
  '--color-selected',
  '--color-selected-ink',
  '--color-success',
  '--color-danger',
] as const;

function readPresentationTokens(): Record<string, string> | undefined {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return undefined;
  const styles = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const key of PRESENTATION_TOKEN_KEYS) {
    const value = styles.getPropertyValue(key).trim();
    if (value !== '') tokens[key] = value;
  }
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function currentPresentation(locale: Locale): PanelPresentation {
  const theme = document.documentElement.dataset['theme'];
  return {
    locale,
    theme: theme === 'dark' || theme === 'light' ? theme : (prefersDark() ? 'dark' : 'light'),
    tokens: readPresentationTokens(),
  };
}

/** Repost the presentation when the resolved theme or a skin's inline tokens move on `<html>`. */
function usePresentationChanges(onChange: () => void): void {
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => { onChange(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => { observer.disconnect(); };
  }, [onChange]);
}

export function settingsPanelOf(manifest: unknown): { readonly id: string; readonly label: string } | undefined {
  if (manifest === null || typeof manifest !== 'object') return undefined;
  const record = manifest as { readonly kiki?: unknown; readonly 'x-kiki'?: unknown };
  const extension = record.kiki ?? record['x-kiki'];
  if (extension === null || typeof extension !== 'object') return undefined;
  const panels = (extension as { readonly panels?: unknown }).panels;
  if (!Array.isArray(panels)) return undefined;
  for (const panel of panels) {
    if (panel === null || typeof panel !== 'object') continue;
    const item = panel as { readonly slot?: unknown; readonly id?: unknown; readonly label?: unknown };
    if (item.slot === 'settings' && typeof item.id === 'string' && typeof item.label === 'string') {
      return { id: item.id, label: item.label };
    }
  }
  return undefined;
}

interface SettingsFrameRequest {
  readonly channel: typeof CHANNEL;
  readonly kind: 'request';
  readonly id: number;
  readonly method: PanelRequest['method'] | 'plugin.settings.get' | 'plugin.settings.patch' | 'plugin.dirty';
  readonly text?: unknown;
  readonly action?: unknown;
  readonly args?: unknown;
  readonly url?: unknown;
  readonly prerequisiteId?: unknown;
  readonly consent?: unknown;
  readonly values?: unknown;
  readonly dirty?: unknown;
}

function isSettingsRequest(data: unknown): data is SettingsFrameRequest {
  if (isPanelRequest(data)) return true;
  if (data === null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return record['channel'] === CHANNEL && record['kind'] === 'request' && Number.isSafeInteger(record['id'])
    && (record['method'] === 'plugin.settings.get' || record['method'] === 'plugin.settings.patch' || record['method'] === 'plugin.dirty');
}

function patchValues(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const values: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean' && item !== null) return undefined;
    values[key] = item;
  }
  return values;
}

export function PluginSettingsPanel({
  pluginId,
  panelId,
  label,
}: {
  readonly pluginId: string;
  readonly panelId: string;
  readonly label: string;
}) {
  const { client, scopeId, meta } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const recent = useRef<number[]>([]);
  /** Seat of the plugin, panel, scope, and server instance now on screen. Late receipts compare against it. */
  const seatRef = useRef(0);
  const frameWindowRef = useRef<Window | null>(null);
  const [loadSeq, setLoadSeq] = useState(0);
  const [dirty, setDirty] = useState(false);
  // `meta.server_id` is the instance. The client wrapper is a new object on
  // later renders of the same server, so it is not part of the seat.
  const serverId = meta?.server_id ?? '';
  const identity = `${scopeId ?? ''}:${serverId}:${pluginId}:${panelId}`;
  const [renderedIdentity, setRenderedIdentity] = useState(identity);
  if (renderedIdentity !== identity) {
    setRenderedIdentity(identity);
    setDirty(false);
    setLoadSeq(0);
    seatRef.current += 1;
    frameWindowRef.current = null;
    recent.current = [];
  }
  useDirtyReporter(`plugin-settings:${pluginId}`, dirty);
  const documentQuery = useQuery({
    queryKey: ['plugin-panel-document', scopeId ?? '', serverId, pluginId, panelId, 'settings'],
    queryFn: () => client.getPluginPanelDocument(pluginId, panelId),
    staleTime: 60_000,
    retry: false,
  });

  const post = useCallback((message: unknown) => {
    const target = frameRef.current?.contentWindow;
    if (target == null || target !== frameWindowRef.current) return;
    target.postMessage(message, '*');
  }, []);

  // init fires on every real document load — a routed switch to another plugin
  // or a refreshed srcDoc re-boots the frame, and the fresh document waits for
  // it. Later locale/theme moves go out as `presentation` updates instead, so
  // a panel that re-reads its world on init is never re-booted mid-draft.
  const localeRef = useRef(locale);
  localeRef.current = locale;
  /* The locale the running document was booted with; a later move pushes a
   * presentation update, while the load that sent init must not double-post. */
  const initLocale = useRef(locale);
  useEffect(() => {
    if (loadSeq === 0) return;
    initLocale.current = localeRef.current;
    post({ channel: CHANNEL, kind: 'init', sessionId: null, presentation: currentPresentation(localeRef.current) });
  }, [loadSeq, post]);

  const postPresentation = useCallback(() => {
    post({ channel: CHANNEL, kind: 'presentation', presentation: currentPresentation(localeRef.current) });
  }, [post]);
  usePresentationChanges(postPresentation);

  useEffect(() => {
    if (loadSeq === 0 || initLocale.current === locale) return;
    initLocale.current = locale;
    postPresentation();
  }, [loadSeq, locale, postPresentation]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow || event.origin !== 'null') return;
      if (!isSettingsRequest(event.data)) return;
      const request = event.data;
      const generation = seatRef.current;
      const target = frameRef.current?.contentWindow ?? null;
      // A switch keeps the call that was already accepted. Only this seat may
      // see the receipt, the cache write, or a dirty clear.
      const stillHere = () => seatRef.current === generation
        && target !== null
        && frameRef.current?.contentWindow === target;
      const respond = (ok: boolean, payload: { result?: unknown; error?: string }) => {
        if (!stillHere() || target === null) return;
        target.postMessage({ channel: CHANNEL, kind: 'response', id: request.id, ok, ...payload }, '*');
      };
      const now = Date.now();
      recent.current = recent.current.filter((stamp) => now - stamp < RATE_WINDOW_MS);
      if (recent.current.length >= MAX_REQUESTS_PER_WINDOW) {
        respond(false, { error: 'rate limited' });
        return;
      }
      recent.current.push(now);
      if (request.method === 'plugin.dirty') {
        setDirty(request.dirty === true);
        respond(true, { result: true });
        return;
      }
      if (request.method === 'plugin.settings.get') {
        void client.getPluginSettings(pluginId)
          .then((result) => {
            if (!stillHere()) return;
            queryClient.setQueryData(['plugin-settings', pluginId], result);
            respond(true, { result });
          })
          .catch((error: unknown) => { if (stillHere()) respond(false, { error: errorText(locale, error) }); });
        return;
      }
      if (request.method === 'plugin.settings.patch') {
        const values = patchValues(request.values);
        if (values === undefined) {
          respond(false, { error: 'invalid settings' });
          return;
        }
        void client.setPluginSettings(pluginId, values)
          .then((result) => {
            if (!stillHere()) return;
            queryClient.setQueryData(['plugin-settings', pluginId], result);
            setDirty(false);
            respond(true, { result });
          })
          .catch((error: unknown) => { if (stillHere()) respond(false, { error: errorText(locale, error) }); });
        return;
      }
      const body = bridgeBody(request as PanelRequest, undefined);
      if (typeof body === 'string') {
        respond(false, { error: body });
        return;
      }
      void client.callPluginPanelBridge(pluginId, panelId, body)
        .then((response) => { if (stillHere()) respond(true, { result: response.result }); })
        .catch((error: unknown) => { if (stillHere()) respond(false, { error: errorText(locale, error) }); });
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); };
  }, [client, locale, panelId, pluginId, post, queryClient]);

  if (documentQuery.isPending) {
    return (
      <p className="flex items-center gap-2 py-2 text-[13px] text-ink-faint" role="status" data-plugin-settings-panel-loading>
        <Spinner label={t('cap.loading')} />{t('cap.panel.loading')}
      </p>
    );
  }
  if (documentQuery.isError) {
    return (
      <div className="space-y-2" data-plugin-panel-error>
        <InlineError error={documentQuery.error} />
        <button type="button" className={SECONDARY_BUTTON} onClick={() => { void documentQuery.refetch(); }}>{t('common.retry')}</button>
        <PluginSettingsForm pluginId={pluginId} />
      </div>
    );
  }
  return (
    <iframe
      key={identity}
      ref={frameRef}
      title={label}
      srcDoc={documentQuery.data.html}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={() => {
        frameWindowRef.current = frameRef.current?.contentWindow ?? null;
        setLoadSeq((seq) => seq + 1);
      }}
      data-plugin-panel={`${pluginId}:${panelId}`}
      data-plugin-settings-panel={pluginId}
      className="block h-[32rem] max-h-[70vh] min-h-[22rem] w-full border-0 bg-paper"
    />
  );
}
