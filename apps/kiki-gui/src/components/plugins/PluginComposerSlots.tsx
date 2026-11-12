/**
 * PluginComposerSlots — E12 Slot 1 (`composer-toolbar`) plus the shared
 * authenticated broker query & declarative slot action executor consumed by all
 * E12 GUI extension mounts.
 *
 * Uses the active Kiki connection's endpoint and bearer/cookie credentials to
 * read `GET /api/plugins/gui-slots` (keyed under `['plugins', 'gui-slots', ...]`
 * so `event.plugin.changed` invalidates it automatically) and to dispatch
 * `invoke_plugin_route` calls against `/api/plugins/:pluginId/routes/*`.
 */

import { useCallback, useContext, useState } from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { UNSAFE_NavigationContext, useNavigate } from 'react-router-dom';

import {
  listPluginGuiSlotsResponseSchema,
  type PluginGuiSlotContribution,
  type PluginSlotAction,
} from '@kiki/protocol';
import {
  requestPluginPromptInsert,
  resolvePluginLocalizedText,
  selectComposerToolbarSlots,
  type PluginComposerToolbarSlotContribution,
} from '@kiki/session-core';
import { errorText } from '@kiki/session-core/i18n';
import { appendToDraft } from '@kiki/session-core/composer';
import { readLastSessionId } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { API_CODES, ApiError } from '../../lib/client';
import { pushToast } from '../../lib/toasts';
import * as connectionState from '../../state/connection';
import type { ConnectionValue } from '../../state/connection';
import { Spinner } from '../icons';

const EMPTY_GUI_SLOTS: readonly PluginGuiSlotContribution[] = [];
const FALLBACK_QUERY_CLIENT = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function useSafeOptionalConnection(): ConnectionValue | null {
  try {
    if ('useOptionalConnection' in connectionState && typeof connectionState.useOptionalConnection === 'function') {
      return connectionState.useOptionalConnection() ?? null;
    }
  } catch {
    // Partial test mocks of `state/connection` may omit `useOptionalConnection` so accessing the proxy getter throws.
  }
  try {
    if ('useConnection' in connectionState && typeof connectionState.useConnection === 'function') {
      return connectionState.useConnection() ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function hasBrokerConnection(connection: ConnectionValue | null | undefined): connection is ConnectionValue {
  return connection != null && typeof connection.config?.url === 'string';
}

export interface PluginGuiSlotScope {
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly enabled?: boolean;
}

function buildBrokerApiUrl(connection: ConnectionValue, path: string, query?: Record<string, string | undefined>): URL {
  const rawBase = connection.config.url.trim().replace(/\/+$/u, '');
  const baseOrigin = rawBase === ''
    ? (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://127.0.0.1')
    : rawBase;
  const url = new URL(`/api${path.startsWith('/') ? path : `/${path}`}`, `${baseOrigin}/`);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    }
  }
  return url;
}

function buildBrokerHeaders(connection: ConnectionValue, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  const token = connection.config.token.trim();
  if (token !== '') {
    headers['authorization'] = `Bearer ${token}`;
  }
  if (hasBody) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

export async function fetchPluginGuiSlots(
  connection: ConnectionValue,
  scope: PluginGuiSlotScope,
  signal?: AbortSignal,
): Promise<readonly PluginGuiSlotContribution[]> {
  const url = buildBrokerApiUrl(connection, '/plugins/gui-slots', {
    session_id: scope.sessionId,
    workspace_id: scope.sessionId === undefined ? scope.workspaceId : undefined,
  });
  const response = await fetch(url, {
    method: 'GET',
    headers: buildBrokerHeaders(connection, false),
    credentials: connection.config.token.trim() === '' ? 'include' : 'same-origin',
    signal,
  });
  if (response.status === 404) return EMPTY_GUI_SLOTS;
  let envelope: unknown = null;
  try {
    envelope = await response.json();
  } catch {
    return EMPTY_GUI_SLOTS;
  }
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    !('code' in envelope) ||
    (envelope as { code: unknown }).code !== 0 ||
    !('data' in envelope)
  ) {
    return EMPTY_GUI_SLOTS;
  }
  const parsed = listPluginGuiSlotsResponseSchema.safeParse((envelope as { data: unknown }).data);
  return parsed.success ? parsed.data.slots : EMPTY_GUI_SLOTS;
}

export async function invokePluginBrokerRoute(
  connection: ConnectionValue,
  input: {
    readonly pluginId: string;
    readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    readonly subpath: string;
    readonly body?: Record<string, unknown>;
    readonly sessionId?: string;
    readonly workspaceId?: string;
    readonly spaceId?: string;
    readonly signal?: AbortSignal;
  },
): Promise<unknown> {
  const cleanSubpath = input.subpath.replace(/^\/+/, '');
  const url = buildBrokerApiUrl(
    connection,
    `/plugins/${encodeURIComponent(input.pluginId)}/routes/${cleanSubpath}`,
    {
      session_id: input.sessionId,
      workspace_id: input.workspaceId,
      space_id: input.spaceId,
    },
  );
  const hasBody = (input.method === 'POST' || input.method === 'PUT') && input.body !== undefined;
  const response = await fetch(url, {
    method: input.method,
    headers: buildBrokerHeaders(connection, hasBody),
    credentials: connection.config.token.trim() === '' ? 'include' : 'same-origin',
    body: hasBody ? JSON.stringify(input.body) : undefined,
    signal: input.signal,
  });
  let envelope: unknown = null;
  try {
    envelope = await response.json();
  } catch {
    throw new ApiError({
      code: API_CODES.INVALID_RESPONSE,
      msg: `HTTP ${response.status} — invalid response`,
      data: null,
    });
  }
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    !('code' in envelope) ||
    typeof (envelope as { code: unknown }).code !== 'number'
  ) {
    throw new ApiError({
      code: API_CODES.INVALID_RESPONSE,
      msg: `HTTP ${response.status} — malformed envelope`,
      data: null,
    });
  }
  const typed = envelope as { code: number; msg?: string; data?: unknown };
  if (typed.code !== 0) {
    throw new ApiError({
      code: typed.code,
      msg: typeof typed.msg === 'string' ? typed.msg : `Plugin route failed (${typed.code})`,
      data: typed.data ?? null,
    });
  }
  return typed.data ?? null;
}

export function pluginGuiSlotsQueryKey(scopeId: string, scope: PluginGuiSlotScope) {
  return [
    'plugins',
    'gui-slots',
    scopeId,
    scope.sessionId ?? '',
    scope.sessionId === undefined ? (scope.workspaceId ?? '') : '',
  ] as const;
}

export function usePluginGuiSlots(scope: PluginGuiSlotScope = {}): {
  readonly slots: readonly PluginGuiSlotContribution[];
  readonly isLoading: boolean;
} {
  const connection = useSafeOptionalConnection();
  const contextQueryClient = useContext(QueryClientContext);
  const canQueryBroker = hasBrokerConnection(connection) && contextQueryClient !== undefined && scope.enabled !== false;
  const scopeId = connection?.scopeId ?? 'disconnected';
  const query = useQuery(
    {
      queryKey: pluginGuiSlotsQueryKey(scopeId, scope),
      queryFn: ({ signal }) => fetchPluginGuiSlots(connection!, scope, signal),
      enabled: canQueryBroker,
      staleTime: 15_000,
      retry: false,
    },
    contextQueryClient ?? FALLBACK_QUERY_CLIENT,
  );
  return {
    slots: query.data ?? EMPTY_GUI_SLOTS,
    isLoading: query.isPending && canQueryBroker,
  };
}

export function buildPluginPanelHref(input: {
  readonly pluginId: string;
  readonly panelId: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
}): string {
  const params = new URLSearchParams();
  params.set('panel', `${input.pluginId}:${input.panelId}`);
  const effectiveSessionId = input.sessionId ?? readLastSessionId();
  if (effectiveSessionId !== undefined && effectiveSessionId !== '') {
    params.set('session', effectiveSessionId);
  } else if (input.workspaceId !== undefined && input.workspaceId !== '') {
    params.set('workspace', input.workspaceId);
  }
  return `/capabilities?${params.toString()}`;
}

export interface ExecutePluginActionOptions {
  readonly pluginId: string;
  readonly label: string;
  readonly action: PluginSlotAction;
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly args?: string;
  readonly contextPayload?: Record<string, unknown>;
  readonly onOpenPanel?: (pluginId: string, panelId: string) => void;
}

export function useExecutePluginSlotAction() {
  const connection = useSafeOptionalConnection();
  const queryClient = useContext(QueryClientContext);
  const navigationContext = useContext(UNSAFE_NavigationContext);
  const navigateTo = useCallback(
    async (to: string) => {
      if (navigationContext !== null && navigationContext.navigator !== undefined) {
        navigationContext.navigator.push(to);
      }
    },
    [navigationContext],
  );
  const { t, locale } = useI18n();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const execute = useCallback(
    async (options: ExecutePluginActionOptions, actionKey?: string): Promise<boolean> => {
      const { action, pluginId, label, sessionId, workspaceId, args, contextPayload, onOpenPanel } = options;
      if (action.kind === 'insert_prompt') {
        const handled = requestPluginPromptInsert(sessionId, {
          text: action.text,
          submit: action.submit,
          args,
        });
        if (!handled && sessionId !== undefined) {
          appendToDraft(sessionId, args !== undefined && args.trim() !== '' ? `${action.text}\n${args.trim()}` : action.text);
        } else if (!handled && sessionId === undefined) {
          await navigateTo('/new');
          requestAnimationFrame(() => {
            requestPluginPromptInsert(undefined, { text: action.text, submit: action.submit, args });
          });
        }
        return true;
      }

      if (action.kind === 'open_plugin_panel') {
        if (onOpenPanel !== undefined) {
          onOpenPanel(pluginId, action.panelId);
          return true;
        }
        await navigateTo(
          buildPluginPanelHref({
            pluginId,
            panelId: action.panelId,
            sessionId,
            workspaceId,
          }),
        );
        return true;
      }

      if (action.kind === 'open_settings_section') {
        const cleanSection = action.sectionId.replace(/^\/+/, '');
        if (cleanSection === 'plugins' || cleanSection === 'extensions') {
          await navigateTo(`/settings/${cleanSection}?plugin=${encodeURIComponent(pluginId)}`);
        } else {
          await navigateTo(`/settings/${encodeURIComponent(cleanSection)}`);
        }
        return true;
      }

      if (!hasBrokerConnection(connection)) return false;
      const currentKey = actionKey ?? `${pluginId}:${action.method}:${action.subpath}`;
      setBusyKey(currentKey);
      try {
        const mergedBody =
          action.body === undefined && contextPayload === undefined && (args === undefined || args === '')
            ? undefined
            : {
                ...action.body,
                ...(args !== undefined && args !== '' ? { args } : undefined),
                ...contextPayload,
              };
        await invokePluginBrokerRoute(connection, {
          pluginId,
          method: action.method,
          subpath: action.subpath,
          body: mergedBody,
          sessionId,
          workspaceId,
          spaceId: connection.meta?.current_space_id ?? undefined,
        });
        await queryClient?.invalidateQueries({ queryKey: ['plugins', 'gui-slots'] });
        return true;
      } catch (error) {
        pushToast({
          tone: 'error',
          text: t('pluginSlot.actionFailed', {
            label,
            detail: errorText(locale, error),
          }),
        });
        return false;
      } finally {
        setBusyKey((prev) => (prev === currentKey ? null : prev));
      }
    },
    [connection, locale, navigateTo, queryClient, t],
  );

  return { execute, busyKey };
}

const TONE_CLASSES: Readonly<Record<PluginComposerToolbarSlotContribution['tone'], string>> = {
  neutral:
    'border-hairline bg-paper/70 text-ink-soft hover:border-hairline-strong hover:bg-ink/[0.04] hover:text-ink',
  accent:
    'border-accent/25 bg-accent/[0.06] text-accent-ink hover:border-accent/45 hover:bg-accent/[0.1]',
  warning:
    'border-amber-rule/40 bg-amber-card/60 text-amber-ink hover:border-amber-rule/70 hover:bg-amber-card',
};

export function PluginComposerSlots({
  slots,
  sessionId,
  workspaceId,
  disabled = false,
  onOpenPanel,
}: {
  readonly slots?: readonly PluginGuiSlotContribution[];
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly disabled?: boolean;
  readonly onOpenPanel?: (pluginId: string, panelId: string) => void;
}) {
  const { t, locale } = useI18n();
  const queried = usePluginGuiSlots({ sessionId, workspaceId });
  const effectiveSlots = slots ?? queried.slots;
  const toolbarSlots = selectComposerToolbarSlots(effectiveSlots);
  const { execute, busyKey } = useExecutePluginSlotAction();

  if (toolbarSlots.length === 0) return null;

  return (
    <div
      role="toolbar"
      aria-label={t('pluginSlot.toolbarAria')}
      data-plugin-composer-slots
      className="-mt-1 mb-2 flex min-w-0 flex-wrap items-center gap-1"
    >
      {toolbarSlots.map((slot) => {
        const key = `${slot.pluginId}:${slot.id}`;
        const label = resolvePluginLocalizedText(slot.label, locale);
        const tooltip = slot.tooltip === undefined ? label : resolvePluginLocalizedText(slot.tooltip, locale);
        const isBusy = busyKey === key;
        return (
          <button
            key={key}
            type="button"
            disabled={disabled || isBusy}
            title={tooltip}
            aria-label={label}
            data-plugin-composer-slot={`${slot.pluginId}:${slot.id}`}
            data-plugin-slot-tone={slot.tone}
            onClick={() => {
              void execute(
                {
                  pluginId: slot.pluginId,
                  label,
                  action: slot.action,
                  sessionId,
                  workspaceId,
                  onOpenPanel,
                },
                key,
              );
            }}
            className={`inline-flex h-6 max-w-48 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] leading-4 transition-colors duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-8 ${TONE_CLASSES[slot.tone]}`}
          >
            {isBusy ? <Spinner label={label} /> : null}
            <span className="truncate font-medium">{label}</span>
            {slot.badgeText !== undefined && slot.badgeText !== '' ? (
              <span
                data-plugin-slot-badge
                className="shrink-0 font-mono text-[11px] text-ink-faint tabular-nums"
              >
                {slot.badgeText}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
