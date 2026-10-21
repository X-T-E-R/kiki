import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { OptionalCapabilitySessionResponse } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import type { KikiConfigResponse } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { Toggle } from '../controls';
import { Segmented } from './primitives';
import { heldByConversation, type McpSessionRow } from './sessionMcp';
import { useMcpPicker } from './useMcpPicker';
import {
  currentPendingCapabilityScope,
  pendingNewSessionCapabilities,
  setPendingOptionalChoice,
  subscribePendingNewSessionCapabilities,
  type PendingOptionalCapabilityId,
} from './newSessionCapabilities';

export const OPTIONAL_CAPABILITY_IDS = ['browser', 'computer', 'memory', 'thread', 'web'] as const;
export type OptionalCapabilityId = PendingOptionalCapabilityId;

export interface OptionalCapabilityState {
  readonly allowed: boolean;
  readonly host_locked: boolean;
  readonly default_on: boolean;
  readonly unresolved: boolean;
}

const LABEL: Record<OptionalCapabilityId, I18nKey> = {
  browser: 'cap.browser',
  computer: 'cap.computer',
  memory: 'cap.memory',
  thread: 'cap.thread',
  web: 'cap.web',
};

const FACTORY_DEFAULT: Record<OptionalCapabilityId, boolean> = {
  browser: true,
  computer: true,
  memory: true,
  thread: false,
  web: true,
};

type Choice = 'inherit' | 'on' | 'off';

interface RowModel {
  readonly id: OptionalCapabilityId;
  readonly choice: Choice;
  readonly allowed: boolean;
  readonly hostLocked: boolean;
  readonly defaultOn: boolean;
  readonly unresolved: boolean;
  readonly effective: boolean;
  readonly reason: string;
  readonly source: 'session' | 'default' | 'off';
  readonly applies: 'next-model-request' | 'next-step';
}

function stateOf(config: KikiConfigResponse | undefined, id: OptionalCapabilityId): OptionalCapabilityState | undefined {
  const value = config?.optional_capabilities?.[id];
  if (value === undefined) return undefined;
  return value;
}

export function optionalCapabilityState(config: KikiConfigResponse | undefined, id: OptionalCapabilityId): OptionalCapabilityState | undefined {
  return stateOf(config, id);
}

export function DefaultOnSwitch({ id, state, disabled, onChange }: {
  id: string;
  state: OptionalCapabilityState | undefined;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useI18n();
  if (state === undefined) return null;
  const locked = disabled === true || !state.allowed || state.unresolved || state.host_locked;
  return (
    <div className="flex items-center justify-between gap-4" data-capability-default={id}>
      <span className="text-[13px] text-ink">{t('cap.defaultOn')}</span>
      <span data-capability-default-switch={id}>
        <Toggle
          id={`${id}-default-on`}
          layout="bare"
          label={t('cap.defaultOn')}
          checked={state.default_on}
          disabled={locked}
          onChange={onChange}
        />
      </span>
    </div>
  );
}

function draftRows(config: KikiConfigResponse | undefined, pending: readonly { id: OptionalCapabilityId; choice: 'on' | 'off' }[]): RowModel[] {
  return OPTIONAL_CAPABILITY_IDS.map((id) => {
    const state = stateOf(config, id);
    const choice = pending.find((item) => item.id === id)?.choice ?? 'inherit';
    const allowed = state?.allowed ?? true;
    const unresolved = state?.unresolved ?? false;
    const defaultOn = state?.default_on ?? FACTORY_DEFAULT[id];
    const hostLocked = state?.host_locked ?? false;
    const effective = !unresolved && allowed && (choice === 'on' || (choice === 'inherit' && defaultOn));
    const source = !allowed || unresolved ? 'off' : choice === 'inherit' ? 'default' : 'session';
    const reason = unresolved ? 'origin_unreadable'
      : !allowed && hostLocked ? 'host_locked'
        : !allowed ? 'allowed_off'
          : choice === 'off' ? 'session_off'
            : choice === 'on' || defaultOn ? 'admitted'
              : 'default_off';
    return {
      id,
      choice,
      allowed,
      hostLocked,
      defaultOn,
      unresolved,
      effective,
      reason,
      source,
      applies: id === 'memory' || id === 'thread' ? 'next-step' : 'next-model-request',
    };
  });
}

function serverRows(view: OptionalCapabilitySessionResponse): RowModel[] {
  return view.rows.map((row) => ({
    id: row.id,
    choice: row.choice,
    allowed: row.allowed,
    hostLocked: row.host_locked,
    defaultOn: row.default_on,
    unresolved: row.unresolved,
    effective: row.effective,
    reason: row.reason,
    source: row.source,
    applies: row.applies,
  }));
}

function factKey(row: RowModel): I18nKey {
  if (row.reason === 'workspace_off') return 'cap.fact.workspaceOff';
  if (row.reason === 'unbound') return 'cap.fact.unbound';
  if (row.reason === 'session_off') return 'cap.fact.sessionOff';
  if (row.reason === 'default_off') return 'cap.fact.defaultOff';
  if (row.reason === 'host_locked' || row.reason === 'allowed_off' || row.reason === 'origin_unreadable') return 'cap.fact.hardOff';
  if (row.reason === 'admitted' && row.choice === 'inherit' && !row.defaultOn) return 'cap.fact.named';
  if (row.reason === 'admitted' && row.source === 'session') return 'cap.fact.sessionOn';
  if (row.reason === 'admitted') return 'cap.fact.inheritOn';
  return 'cap.fact.defaultOff';
}

export function OptionalCapabilityRows({ sessionId }: { sessionId?: string }) {
  const { client, scopeId, spaceKey, connectionId } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const live = sessionId !== undefined && sessionId !== '';
  const readPending = useCallback(
    () => pendingNewSessionCapabilities(currentPendingCapabilityScope({ scopeId, spaceKey, connectionId })),
    [connectionId, scopeId, spaceKey],
  );
  const pending = useSyncExternalStore(subscribePendingNewSessionCapabilities, readPending, readPending);
  const configQuery = useQuery({
    queryKey: ['config', scopeId],
    queryFn: () => client.getConfig(),
    enabled: typeof client.getConfig === 'function',
    staleTime: 30_000,
  });
  const sessionQuery = useQuery({
    queryKey: ['optional-capabilities', scopeId, sessionId],
    queryFn: () => client.getSessionOptionalCapabilities(sessionId!),
    enabled: live && typeof client.getSessionOptionalCapabilities === 'function',
    staleTime: 5_000,
  });
  const generation = useRef(0);
  const [error, setError] = useState<string | undefined>();
  const [busyId, setBusyId] = useState<OptionalCapabilityId | undefined>();
  const rows = live && sessionQuery.data !== undefined
    ? serverRows(sessionQuery.data)
    : draftRows(configQuery.data, pending.optional ?? []);
  const failed = live ? sessionQuery.isError : configQuery.isError && configQuery.data === undefined;

  const choose = (id: OptionalCapabilityId, choice: Choice) => {
    if (!live) {
      setPendingOptionalChoice(id, choice, currentPendingCapabilityScope({ scopeId, spaceKey, connectionId }));
      return;
    }
    const mine = generation.current + 1;
    generation.current = mine;
    setBusyId(id);
    setError(undefined);
    void client.setSessionOptionalCapability(sessionId!, { id, choice }).then((view) => {
      if (generation.current !== mine) return;
      queryClient.setQueryData(['optional-capabilities', scopeId, sessionId], view);
    }).catch((cause: unknown) => {
      if (generation.current !== mine) return;
      setError(errorText(locale, cause));
    }).finally(() => {
      if (generation.current === mine) setBusyId(undefined);
    });
  };

  if (failed && rows.length === 0) return <p className="px-2 py-1 text-[12px] text-ink-faint">{t('cap.unavailable')}</p>;
  return (
    <div className="space-y-1 px-1 py-1" data-optional-capabilities={live ? 'session' : 'draft'}>
      {rows.map((row) => (
        <div key={row.id} data-optional-capability={row.id} data-optional-choice={row.choice} data-optional-effective={row.effective ? 'true' : 'false'} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 py-1.5">
          <div className="min-w-0">
            <span className="text-[13px] text-ink">{t(LABEL[row.id])}</span>
            <p data-optional-fact={row.id} data-optional-source={row.source} className="text-[12px] leading-4 text-ink-faint">
              {t(factKey(row))}
              <span> · {t(row.applies === 'next-step' ? 'cap.applies.nextStep' : 'cap.applies.nextModel')}</span>
            </p>
          </div>
          <Segmented
            value={row.choice}
            ariaLabel={t(LABEL[row.id])}
            options={[
              { value: 'inherit', label: t('cap.choice.inherit') },
              { value: 'on', label: t('cap.choice.on') },
              { value: 'off', label: t('cap.choice.off') },
            ]}
            onChange={(choice) => {
              if (busyId === row.id) return;
              if (choice === 'on' && (!row.allowed || row.unresolved)) return;
              choose(row.id, choice);
            }}
          />
        </div>
      ))}
      {error === undefined ? null : <p role="alert" className="px-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

function mcpRailFact(row: McpSessionRow): I18nKey {
  if (row.override === 'off') return 'composer.addMenu.mcpOffSession';
  if (row.override === 'on') return 'composer.addMenu.mcpOnSession';
  if (row.condition === 'plugin-off') return 'composer.addMenu.mcpPluginMuted';
  if (row.condition === 'off-config') return 'composer.addMenu.mcpConfigOff';
  if (row.condition === 'signed-out') return 'composer.addMenu.mcpNeedsAuth';
  if (row.condition === 'live' || row.condition === 'on-here') return 'composer.addMenu.mcpSourceOn';
  return 'composer.addMenu.mcpStateUnknown';
}

function mcpRailOrigin(row: McpSessionRow): I18nKey {
  if (row.override !== 'inherit') return 'cap.source.session';
  if (row.origin === 'plugin') return 'composer.addMenu.mcpFromPlugin';
  if (row.origin === 'caller') return 'composer.addMenu.mcpFromConversation';
  return 'composer.addMenu.mcpFromConfig';
}

export function SessionMcpRail({ sessionId }: { sessionId?: string }) {
  const { t } = useI18n();
  const mcp = useMcpPicker(sessionId);
  if (!mcp.available) return null;
  return (
    <div className="space-y-1 px-1 py-1" data-rail-mcp>
      <p className="px-2 text-[12px] font-medium text-ink">{t('rail.mcp.title')}</p>
      <p className="px-2 text-[11px] leading-4 text-ink-faint">{t('rail.mcp.hint')}</p>
      {mcp.failed && mcp.items.length === 0 ? <p className="px-2 text-[12px] text-ink-faint">{t('composer.addMenu.mcpFailed')}</p> : null}
      {mcp.items.map((row) => {
        const factKey = mcpRailFact(row);
        const originKey = mcpRailOrigin(row);
        const pluginName = row.pluginLabel ?? '';
        return (
          <div key={row.name} data-rail-mcp-server={row.name} data-rail-mcp-effective={heldByConversation(row) ? 'true' : 'false'} data-rail-mcp-source={row.override === 'inherit' ? row.origin : 'session'} className="px-2 py-1">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[13px] text-ink">{row.name}</span>
              {row.addressable && row.locator !== undefined ? (
                <span className="flex shrink-0 gap-1">
                  {(['inherit', 'on', 'off'] as const).map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      data-rail-mcp-set={choice}
                      aria-pressed={row.override === choice}
                      disabled={mcp.busyName === row.name || !mcp.writable}
                      onClick={() => { mcp.setOverride(row.locator!, choice, row.name); }}
                      className={`min-h-6 rounded px-1.5 text-[11px] ${row.override === choice ? 'bg-paper text-ink' : 'text-ink-soft'} disabled:opacity-40`}
                    >
                      {t(choice === 'inherit' ? 'cap.choice.inherit' : choice === 'on' ? 'cap.choice.on' : 'cap.choice.off')}
                    </button>
                  ))}
                </span>
              ) : null}
            </div>
            <p data-rail-mcp-fact={row.name} className="text-[11px] leading-4 text-ink-faint">{t(factKey, factKey === 'composer.addMenu.mcpPluginMuted' || originKey === 'composer.addMenu.mcpFromPlugin' ? { name: pluginName } : undefined)}</p>
            <p className="text-[11px] leading-4 text-ink-faint">{t(originKey, originKey === 'composer.addMenu.mcpFromPlugin' ? { name: pluginName } : undefined)}</p>
          </div>
        );
      })}
      {mcp.failure === undefined ? null : <p role="alert" className="px-2 text-[12px] text-danger">{mcp.failure.message}</p>}
    </div>
  );
}

export function useOptionalCapabilityMenu(sessionId: string | undefined) {
  const { client } = useConnection();
  const readable = typeof client.getConfig === 'function';
  const query = useQuery({
    queryKey: ['config', 'optional-menu'],
    queryFn: () => client.getConfig(),
    enabled: readable,
    staleTime: 30_000,
  });
  return {
    available: readable && (query.isSuccess || query.data !== undefined),
    loading: query.isPending,
    failed: query.isError,
    sessionId,
  };
}
