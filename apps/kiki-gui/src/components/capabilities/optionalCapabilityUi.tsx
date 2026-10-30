import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { OptionalCapabilitySessionResponse } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import type { KikiConfigResponse } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { Toggle } from '../controls';
import { FOCUS_RING } from '../rail-variants/shell';
import { heldByConversation, overrideForSwitch, type McpSessionRow } from './sessionMcp';
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
  browser: false,
  computer: false,
  memory: true,
  thread: true,
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

export function DefaultOnSwitch({ id, state, disabled, labelKey = 'cap.defaultOn', onChange }: {
  id: string;
  state: OptionalCapabilityState | undefined;
  disabled?: boolean;
  /** The row label; a card whose "on by default" means something narrower names it. */
  labelKey?: I18nKey;
  onChange: (next: boolean) => void;
}) {
  const { t } = useI18n();
  if (state === undefined) return null;
  const locked = disabled === true || !state.allowed || state.unresolved || state.host_locked;
  return (
    <div className="flex items-center justify-between gap-4" data-capability-default={id}>
      <span className="text-[13px] text-ink">{t(labelKey)}</span>
      <span data-capability-default-switch={id}>
        <Toggle
          id={`${id}-default-on`}
          layout="bare"
          label={t(labelKey)}
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

function isOptionalCapabilityId(id: string): id is OptionalCapabilityId {
  return (OPTIONAL_CAPABILITY_IDS as readonly string[]).includes(id);
}

function serverRows(view: OptionalCapabilitySessionResponse): RowModel[] {
  return view.rows.filter((row) => isOptionalCapabilityId(row.id)).map((row) => ({
    id: row.id as OptionalCapabilityId,
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

function withOptimisticChoice(row: RowModel, choice: Choice | undefined): RowModel {
  if (choice === undefined || choice === row.choice) return row;
  const blocked = !row.allowed || row.unresolved || row.reason === 'workspace_off';
  const effective = !blocked && (choice === 'on' || (choice === 'inherit' && row.defaultOn));
  const source = !row.allowed || row.unresolved ? 'off' : choice === 'inherit' ? 'default' : 'session';
  const reason = blocked ? row.reason
    : choice === 'off' ? 'session_off'
      : choice === 'on' || row.defaultOn ? 'admitted'
        : 'default_off';
  return { ...row, choice, effective, source, reason };
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
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const queryClient = useQueryClient();
  const live = sessionId !== undefined && sessionId !== '';
  const sessionScopeKey = `${scopeId}:${sessionId ?? 'draft'}`;
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
    queryFn: async () => {
      const view = await client.getSessionOptionalCapabilities(sessionId!);
      const current = queryClient.getQueryData<OptionalCapabilitySessionResponse>(['optional-capabilities', scopeId, sessionId]);
      return current !== undefined && view.revision < current.revision ? current : view;
    },
    enabled: live && typeof client.getSessionOptionalCapabilities === 'function',
    staleTime: 5_000,
  });
  const nextGeneration = useRef(0);
  const rowGenerations = useRef(new Map<string, number>());
  const acceptedGenerations = useRef(new Map<string, number>());
  const [optimistic, setOptimistic] = useState<Readonly<Record<string, Choice>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const baseRows = live && sessionQuery.data !== undefined
    ? serverRows(sessionQuery.data)
    : draftRows(configQuery.data, pending.optional ?? []);
  const rows = baseRows.map((row) =>
    live ? withOptimisticChoice(row, optimistic[`${sessionScopeKey}:${row.id}`]) : row,
  );
  const failed = live ? sessionQuery.isError : configQuery.isError && configQuery.data === undefined;
  const currentError = errors[sessionScopeKey];

  const choose = (id: OptionalCapabilityId, choice: Choice) => {
    if (!live) {
      setPendingOptionalChoice(id, choice, currentPendingCapabilityScope({ scopeId, spaceKey, connectionId }));
      return;
    }
    const rowKey = `${sessionScopeKey}:${id}`;
    const mine = ++nextGeneration.current;
    rowGenerations.current.set(rowKey, mine);
    setOptimistic((prev) => ({ ...prev, [rowKey]: choice }));
    setErrors(({ [sessionScopeKey]: _cleared, ...rest }) => rest);
    void client.setSessionOptionalCapability(sessionId!, { id, choice }).then((view) => {
      if (rowGenerations.current.get(rowKey) !== mine) return;
      rowGenerations.current.delete(rowKey);
      setOptimistic(({ [rowKey]: _done, ...rest }) => rest);
      queryClient.setQueryData<OptionalCapabilitySessionResponse>(
        ['optional-capabilities', scopeId, sessionId],
        (current) => {
          if (current === undefined) {
            acceptedGenerations.current.set(sessionScopeKey, Math.max(acceptedGenerations.current.get(sessionScopeKey) ?? 0, mine));
            return view;
          }
          if (view.revision < current.revision) return current;
          const latestMine = acceptedGenerations.current.get(sessionScopeKey) ?? 0;
          if (view.revision === current.revision && mine < latestMine) {
            const updatedRow = view.rows.find((candidate) => candidate.id === id);
            if (updatedRow === undefined) return current;
            return {
              ...current,
              rows: current.rows.map((row) => (row.id === id ? updatedRow : row)),
            };
          }
          acceptedGenerations.current.set(sessionScopeKey, Math.max(latestMine, mine));
          return view;
        },
      );
    }).catch((cause: unknown) => {
      if (rowGenerations.current.get(rowKey) !== mine) return;
      rowGenerations.current.delete(rowKey);
      setOptimistic(({ [rowKey]: _rolledBack, ...rest }) => rest);
      setErrors((prev) => ({ ...prev, [sessionScopeKey]: errorText(localeRef.current, cause) }));
    });
  };

  if (failed && rows.length === 0) return <p className="px-1 py-1 text-[12px] text-ink-faint">{t('cap.unavailable')}</p>;
  return (
    <div data-optional-capabilities={live ? 'session' : 'draft'}>
      {rows.map((row) => {
        const blocked = !row.allowed || row.unresolved || row.reason === 'workspace_off';
        const namedByProfile = row.reason === 'admitted' && row.choice === 'inherit' && !row.defaultOn;
        const showInlineFact = blocked || namedByProfile || row.choice !== 'inherit';
        const appliesText = t(row.applies === 'next-step' ? 'cap.applies.nextStep' : 'cap.applies.nextModel');
        const fact = t(factKey(row));
        const nextChoice: Choice = row.effective ? 'off' : 'on';
        return (
          <div
            key={row.id}
            data-optional-capability={row.id}
            data-optional-choice={row.choice}
            data-optional-effective={row.effective ? 'true' : 'false'}
            data-optional-reason={row.reason}
            title={`${t(LABEL[row.id])} · ${fact} · ${appliesText}`}
            className="flex min-h-7 items-center justify-between gap-2.5 border-t border-hairline py-1 first:border-t-0"
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span
                className={`truncate text-[12.5px] leading-5 ${
                  row.effective ? 'text-ink' : blocked ? 'text-ink-faint' : 'text-ink-soft'
                }`}
              >
                {t(LABEL[row.id])}
              </span>
              <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[11.5px] leading-4 text-ink-faint">
                <span
                  data-optional-fact={row.id}
                  data-optional-source={row.source}
                  className={showInlineFact ? (row.choice === 'on' ? 'text-selected-ink' : 'text-ink-faint') : 'sr-only'}
                >
                  {fact}
                </span>
                {row.choice !== 'inherit' ? (
                  <button
                    type="button"
                    data-optional-restore={row.id}
                    data-optional-set="inherit"
                    onClick={() => { choose(row.id, 'inherit'); }}
                    className={`rounded text-ink-faint underline decoration-dotted underline-offset-2 transition-colors hover:text-ink ${FOCUS_RING}`}
                  >
                    {t('rail.plugins.restore')}
                  </button>
                ) : null}
              </span>
            </div>
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- delegates synthetic clicks targeted at data-optional-set to the inner checkbox */}
            <span
              className="flex shrink-0 items-center"
              data-optional-toggle={row.id}
              data-optional-set={nextChoice}
              onClick={(event) => {
                if (event.target !== event.currentTarget) return;
                if (nextChoice === 'on' && blocked) return;
                choose(row.id, nextChoice);
              }}
            >
              <Toggle
                id={`optional-cap-${live ? sessionId : 'draft'}-${row.id}`}
                layout="bare"
                label={t(LABEL[row.id])}
                checked={row.effective}
                disabled={blocked}
                onChange={(next) => {
                  if (next && blocked) return;
                  choose(row.id, next ? 'on' : 'off');
                }}
              />
            </span>
          </div>
        );
      })}
      {currentError === undefined ? null : <p role="alert" className="pt-1 text-[12px] text-danger">{currentError}</p>}
    </div>
  );
}

function mcpRailFact(row: McpSessionRow): I18nKey {
  if (row.override === 'off') return 'cap.fact.sessionOff';
  if (row.override === 'on') return 'cap.fact.sessionOn';
  if (row.condition === 'plugin-off') return 'composer.addMenu.mcpPluginMuted';
  if (row.condition === 'off-config') return 'cap.fact.defaultOff';
  if (row.condition === 'signed-out') return 'composer.addMenu.mcpNeedsAuth';
  if (row.origin === 'plugin') return 'composer.addMenu.mcpFromPlugin';
  if (row.condition === 'live' || row.condition === 'on-here') return 'cap.fact.inheritOn';
  return 'composer.addMenu.mcpStateUnknown';
}

export function SessionMcpRail({ sessionId }: { sessionId?: string }) {
  const { t } = useI18n();
  const mcp = useMcpPicker(sessionId);
  if (!mcp.available || (mcp.items.length === 0 && mcp.failure === undefined)) return null;
  const activeCount = mcp.items.filter(heldByConversation).length;
  return (
    <div className="mt-1.5 border-t border-hairline pt-1.5" data-rail-mcp>
      <div className="flex items-baseline justify-between gap-1.5 pb-0.5 text-[11px] font-medium text-ink-faint">
        <span>{t('rail.mcp.title')}</span>
        {mcp.items.length > 0 ? <span className="font-normal tabular-nums">{activeCount}/{mcp.items.length}</span> : null}
      </div>
      <div>
        {mcp.items.map((row) => {
        const held = heldByConversation(row);
        const rowBusy = mcp.busyName === row.name;
        const checked = rowBusy && mcp.busyOn !== undefined ? mcp.busyOn : held;
        const key = mcpRailFact(row);
        const pluginName = row.pluginLabel ?? '';
        const fact = t(key, key === 'composer.addMenu.mcpPluginMuted' || key === 'composer.addMenu.mcpFromPlugin' ? { name: pluginName } : undefined);
        const showInlineFact = row.override !== 'inherit' || row.condition === 'plugin-off' || row.condition === 'signed-out' || row.condition === 'failed';
        const nextChoice: Choice = checked ? 'off' : 'on';
        return (
          <div
            key={row.name}
            data-rail-mcp-server={row.name}
            data-rail-mcp-effective={held ? 'true' : 'false'}
            data-rail-mcp-source={row.override === 'inherit' ? row.origin : 'session'}
            data-rail-mcp-override={row.override}
            className="flex min-h-7 items-center justify-between gap-2.5 border-t border-hairline py-1 first:border-t-0"
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className={`truncate text-[12.5px] leading-5 ${checked ? 'text-ink' : 'text-ink-soft'}`} title={row.name}>
                {row.name}
              </span>
              <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[11.5px] leading-4 text-ink-faint">
                <span
                  data-rail-mcp-fact={row.name}
                  className={showInlineFact ? (row.override === 'on' ? 'text-selected-ink' : 'text-ink-faint') : 'sr-only'}
                >
                  {fact}
                </span>
                {row.canRestore && row.locator !== undefined ? (
                  <button
                    type="button"
                    data-rail-mcp-restore={row.name}
                    data-rail-mcp-set="inherit"
                    disabled={rowBusy || !mcp.writable}
                    onClick={() => { mcp.setOverride(row.locator!, 'inherit', row.name); }}
                    className={`rounded text-ink-faint underline decoration-dotted underline-offset-2 transition-colors hover:text-ink disabled:opacity-40 ${FOCUS_RING}`}
                  >
                    {t('rail.plugins.restore')}
                  </button>
                ) : null}
              </span>
            </div>
            {row.addressable && row.locator !== undefined ? (
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- delegates synthetic clicks targeted at data-rail-mcp-set to the inner checkbox
              <span
                className="flex shrink-0 items-center"
                data-rail-mcp-toggle={row.name}
                data-rail-mcp-set={nextChoice}
                onClick={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (rowBusy || !mcp.writable) return;
                  mcp.setOverride(row.locator!, overrideForSwitch(row, nextChoice === 'on'), row.name);
                }}
              >
                <Toggle
                  id={`rail-mcp-${sessionId ?? 'draft'}-${row.name}`}
                  layout="bare"
                  label={t('composer.addMenu.mcpToggle', { name: row.name })}
                  checked={checked}
                  disabled={rowBusy || !mcp.writable}
                  onChange={(next) => {
                    if (rowBusy || !mcp.writable) return;
                    mcp.setOverride(row.locator!, overrideForSwitch(row, next), row.name);
                  }}
                />
              </span>
            ) : null}
          </div>
        );
        })}
      </div>
      {mcp.failure === undefined ? null : <p role="alert" className="pt-1 text-[12px] text-danger">{mcp.failure.message}</p>}
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
