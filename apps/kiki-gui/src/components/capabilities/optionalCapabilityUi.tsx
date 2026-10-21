import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { OptionalCapabilitySessionResponse } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import type { KikiConfigResponse } from '../../lib/client';
import { useConnection } from '../../state/connection';
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
      <button
        type="button"
        role="switch"
        id={`${id}-default-on`}
        aria-checked={state.default_on}
        data-capability-default-switch={id}
        disabled={locked}
        onClick={() => { onChange(!state.default_on); }}
        className="min-h-6 rounded px-2 text-[12px] text-ink-soft disabled:opacity-40"
      >
        {state.default_on ? t('cap.choice.on') : t('cap.choice.off')}
      </button>
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
    const effective = !unresolved && allowed && (choice === 'on' || (choice === 'inherit' && defaultOn));
    return {
      id,
      choice,
      allowed,
      hostLocked: state?.host_locked ?? false,
      defaultOn,
      unresolved,
      effective,
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
    applies: row.applies,
  }));
}

function sentenceKey(row: RowModel): I18nKey {
  if (!row.allowed || row.unresolved) return 'cap.sentence.hardOff';
  if (row.choice === 'on') return 'cap.sentence.sessionOn';
  if (row.choice === 'off' || !row.defaultOn) return 'cap.sentence.sessionOff';
  return 'cap.sentence.inheritOn';
}

function sourceKey(row: RowModel): I18nKey {
  if (!row.allowed || row.unresolved) return 'cap.source.off';
  if (row.choice === 'inherit') return 'cap.source.default';
  return 'cap.source.session';
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
        <div key={row.id} data-optional-capability={row.id} data-optional-choice={row.choice} data-optional-effective={row.effective ? 'true' : 'false'} className="rounded-md px-2 py-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 text-[13px] text-ink">{t(LABEL[row.id])}</span>
            <span data-optional-source={row.id} className="shrink-0 text-[11px] text-ink-faint">{t(sourceKey(row))}</span>
          </div>
          <p className="mt-0.5 text-[12px] leading-4 text-ink-soft">{t(sentenceKey(row))}</p>
          <p className="text-[11px] text-ink-faint">{t(row.applies === 'next-step' ? 'cap.applies.nextStep' : 'cap.applies.nextModel')}</p>
          <div className="mt-1 flex gap-1" role="group" aria-label={t(LABEL[row.id])}>
            {(['inherit', 'on', 'off'] as const).map((choice) => {
              const blocked = choice === 'on' && (!row.allowed || row.unresolved);
              return (
                <button
                  key={choice}
                  type="button"
                  data-optional-set={choice}
                  aria-pressed={row.choice === choice}
                  disabled={busyId === row.id || blocked}
                  onClick={() => { choose(row.id, choice); }}
                  className={`min-h-6 rounded px-1.5 text-[11px] ${row.choice === choice ? 'bg-paper text-ink' : 'text-ink-soft'} disabled:opacity-40`}
                >
                  {t(choice === 'inherit' ? 'cap.choice.inherit' : choice === 'on' ? 'cap.choice.on' : 'cap.choice.off')}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {error === undefined ? null : <p role="alert" className="px-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
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
      {mcp.items.map((row) => (
        <div key={row.name} data-rail-mcp-server={row.name} className="flex items-center justify-between gap-2 px-2 py-1">
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
      ))}
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
