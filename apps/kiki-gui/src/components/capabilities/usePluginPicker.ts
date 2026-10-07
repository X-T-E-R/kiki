/**
 * The composer plugin picker — turning a plugin on for this conversation.
 *
 * Skills reach the composer as a `/token` in the draft and activate on send,
 * because a skill is a prompt the reader writes arguments into. A plugin is
 * not that: turning one on is a fact about the conversation, so picking it
 * writes that fact and nothing else.
 *
 * Three rules earn their own code because each one is a way to lie:
 *
 * - **Nothing is sent.** A picked plugin never becomes a user message, never
 *   enters the draft and never triggers a send. The reader asked for a plugin
 *   to be available, not for the agent to be told about it.
 * - **No new conversation.** It is a session override, so it applies to the
 *   conversation already open, and enabling a plugin is never a reason to
 *   start another one.
 * - **The answer is the server's.** A failed write keeps the row where the
 *   server last put it and says why, and a row the master switch denies is
 *   never offered as if it could be turned on.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PluginUsageItem, PluginUsageResponse, PluginUsageTarget } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { isStaleRevision, isStaleTarget, overrideSource, rowBlockedByHome, type OverrideSource } from './pluginUsage';
import { PLUGIN_QUERY_KEYS, useInstalledPlugins } from './usePlugins';

export type PluginPickState =
  | { readonly kind: 'idle' }
  /** The choice just made, before the server has answered. */
  | { readonly kind: 'pending'; readonly pluginId: string; readonly override: 'on' | 'off' }
  /** A write that was refused; the row keeps the server's own value. */
  | { readonly kind: 'failed'; readonly pluginId: string; readonly message: string };

/** Which level decided a row's value, named exactly as the rail names it. */
export type PluginPickSource = OverrideSource;

export interface PluginPickerItem {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
  /** What the switch shows right now, with the picker's own pending value. */
  readonly enabled: boolean;
  /** False when the master switch denies it, so the row explains rather than lies. */
  readonly available: boolean;
  readonly source: PluginPickSource;
  /** What it adds, in the reader's language, or an empty string when none. */
  readonly contributions: string;
}

/**
 * Read a conversation's plugins and turn one of them on or off.
 *
 * `sessionId` is required: a plugin scoped to a conversation only exists
 * relative to one, and a picker on a draft that has no conversation yet would
 * be promising a scope it cannot name.
 */
export function usePluginPicker(sessionId: string | undefined) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const installed = useInstalledPlugins();
  const [state, setState] = useState<PluginPickState>({ kind: 'idle' });
  const target: PluginUsageTarget | undefined = useMemo(
    () => (sessionId === undefined || sessionId === '' ? undefined : { session_id: sessionId }),
    [sessionId],
  );
  // Read by a write that outlives this render, so a late failure is written in
  // the language the reader is actually looking at when it lands.
  const localeRef = useRef(locale);
  localeRef.current = locale;

  const read = useQuery({
    queryKey: target === undefined ? ['plugin-usage', 'none'] : PLUGIN_QUERY_KEYS.usage(target.session_id),
    queryFn: () => client.getPluginUsage(target!),
    enabled: target !== undefined,
    staleTime: 5_000,
    retry: false,
  });

  const latest = useRef(0);
  const write = useMutation({
    mutationFn: (input: { pluginId: string; override: 'on' | 'off'; target: PluginUsageTarget }) =>
      client.setPluginUsage({ target: input.target, plugin_id: input.pluginId, override: input.override }),
    onMutate: (input) => {
      const requestId = ++latest.current;
      setState({ kind: 'pending', pluginId: input.pluginId, override: input.override });
      // The key travels with the answer so a late reply updates the cache entry
      // that asked for it, rather than whatever the reader is looking at now.
      return { requestId, target: input.target, key: PLUGIN_QUERY_KEYS.usage(targetKey(input.target)) };
    },
    onSuccess: (response: PluginUsageResponse, _input, request) => {
      if (request === undefined || latest.current !== request.requestId) return;
      setState({ kind: 'idle' });
      if (isStaleTarget(request.target, target)) return;
      const previous = queryClient.getQueryData<PluginUsageResponse>(request.key);
      if (previous === undefined || !isStaleRevision(previous.revision, response.revision)) {
        queryClient.setQueryData(request.key, response);
      }
    },
    onError: (error, input, request) => {
      if (request === undefined || latest.current !== request.requestId) return;
      // The refused choice is dropped and the row keeps the server's answer: a
      // switch that reads on after the write was refused is the one lie this
      // picker must not tell.
      setState({ kind: 'failed', pluginId: input.pluginId, message: errorText(localeRef.current, error) });
    },
  });

  /**
   * The switch's answer, not an override. The switch already decided which of
   * the two the reader asked for; taking a boolean here keeps the one place
   * that knows the protocol's vocabulary (override) in the writer, so the menu
   * cannot ask for an override the row never meant.
   */
  const toggle = useCallback((pluginId: string, enabled: boolean) => {
    if (target === undefined) return;
    void write.mutateAsync({ pluginId, override: enabled ? 'on' : 'off', target }).catch(() => undefined);
  }, [write, target]);

  const items: readonly PluginPickerItem[] = useMemo(() => {
    const usage = read.data;
    if (usage === undefined) return [];
    const names = new Map((installed.data?.plugins ?? []).map((plugin) => [plugin.id, plugin.displayName]));
    return usage.plugins.map((row: PluginUsageItem) => ({
      id: row.id,
      name: names.get(row.id) ?? row.displayName,
      ...(row.icon !== undefined ? { icon: row.icon } : {}),
      enabled: state.kind === 'pending' && state.pluginId === row.id ? state.override === 'on' : row.effective,
      available: !rowBlockedByHome(row),
      // The same rule the rail and the workspace page read, so a row cannot
      // name one level here and another there. A picker with its own narrower
      // rule is how the caption came apart from the switch beside it: a value
      // this *workspace* turned off would have been reported as a global
      // default, and one it turned on as this conversation's own.
      source: overrideSource(row),
      contributions: contributionsOf(row, t),
    }));
  }, [read.data, installed.data, state, t]);

  return {
    items,
    /** False where this server has no conversation to scope a plugin to. */
    available: target !== undefined,
    loading: target !== undefined && read.isPending,
    failed: read.isError,
    failure: state.kind === 'failed' ? state : undefined,
    toggle,
    busyId: write.isPending ? write.variables?.pluginId : undefined,
    dismissFailure: useCallback(() => { setState({ kind: 'idle' }); }, []),
  };
}

/**
 * The query key for a target. A session picker only ever holds a session
 * target, so a workspace one is unreachable here rather than silently keyed
 * under a session id it does not have.
 */
function targetKey(target: PluginUsageTarget): string {
  return 'session_id' in target ? target.session_id : target.workspace_id;
}

/** The rows' one-line "what it adds", or an empty string when it adds none. */
function contributionsOf(row: PluginUsageItem, t: (key: 'rail.plugins.counts.skill' | 'rail.plugins.counts.mcp', params: { count: number }) => string): string {
  return [
    ...(row.skillCount > 0 ? [t('rail.plugins.counts.skill', { count: row.skillCount })] : []),
    ...(row.mcpServerCount > 0 ? [t('rail.plugins.counts.mcp', { count: row.mcpServerCount })] : []),
  ].join(' · ');
}