import { memo, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ImBinding,
  type ImBindingPatch,
  type ImChannelView,
  type ImProviderKind,
} from '@kiki/protocol';

import { pushUndoToast } from '../../lib/toasts';
import { useChannelsI18n as useI18n } from './channelsI18n';
import { useOptionalConnection } from '../../state/connection';
import { FOCUS_RING } from '../rail-variants/shell';
import { INSPECTOR_HEAD, InspectorChevron } from '../agent-panel/InspectorSection';
import { RebindModal } from './RebindModal';
import {
  extractConflictDetails,
  findSendMessageRow,
  formatIdentityChannel,
  formatIdentityVariant,
  isBindingAdmittedInbound,
  isBindingAdmittedOutbound,
  isBindingSessionAdmitted,
  isIdentityAlreadyBoundError,
  stripNotifyPrefix,
  type RebindCandidate,
  type RebindConflictDetails,
} from './channelTypes';

const SECTION_BUTTON = `group -ml-1.5 flex h-8 w-[calc(100%+0.375rem)] min-w-0 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left transition-colors hover:bg-ink/[0.04] ${FOCUS_RING}`;

export interface SessionChannelsRailProps {
  readonly sessionId: string;
  readonly sessionTitle?: string;
  readonly personaId?: string;
  readonly personaName?: string;
  readonly onOpenSettings?: () => void;
}

export const SessionChannelsRail = memo(function SessionChannelsRail(props: SessionChannelsRailProps) {
  const connection = useOptionalConnection();
  if (connection === null) return null;
  return <SessionChannelsRailBody key={`${connection.scopeId}:${connection.spaceKey}:${props.sessionId}`} {...props} />;
});

function SessionChannelsRailBody({
  sessionId,
  sessionTitle,
  personaId,
  personaName,
  onOpenSettings,
}: SessionChannelsRailProps) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Rebind dialog state
  const [rebindCandidate, setRebindCandidate] = useState<RebindCandidate | undefined>();
  const [rebindConflict, setRebindConflict] = useState<RebindConflictDetails | undefined>();
  const [rebindModalOpen, setRebindModalOpen] = useState(false);

  // Home and Connection scoped query keys (R3: Scope isolation)
  const scopeId = connection?.scopeId ?? 'local';
  const spaceKey = connection?.spaceKey ?? 'main';

  const snapshotQuery = useQuery({
    queryKey: ['im-sessions', scopeId, spaceKey],
    queryFn: () => connection!.client.imSessions.snapshot(),
    enabled: connection !== null,
    placeholderData: (previous) => previous,
    refetchInterval: (query) => query.state.data?.instances.some((item) => item.listening) === true ? 2_000 : false,
  });

  const sessionCapQuery = useQuery({
    queryKey: ['optional-capabilities', scopeId, spaceKey, sessionId],
    queryFn: () => connection!.client.getSessionOptionalCapabilities(sessionId),
    enabled: connection !== null && typeof connection.client.getSessionOptionalCapabilities === 'function',
    staleTime: 5_000,
  });

  // R1 / R2: Fetch target session channels from authoritative GET /api/im/sessions/targets/:id/channels
  const targetChannelsQuery = useQuery({
    queryKey: ['target-channels', scopeId, spaceKey, sessionId],
    queryFn: () => connection!.client.imSessions.channelViews(sessionId),
    enabled: connection !== null && typeof connection.client.imSessions?.channelViews === 'function',
    staleTime: 10_000,
  });

  const notifySettingsQuery = useQuery({
    queryKey: ['notifications', 'settings', scopeId, spaceKey],
    queryFn: () => connection!.client.notifications.getSettings(),
    enabled: connection !== null && typeof connection.client.notifications?.getSettings === 'function',
    staleTime: 30_000,
  });

  // R4: Candidates construction
  const candidates: RebindCandidate[] = useMemo(() => {
    if (snapshotQuery.data === undefined) return [];
    const list: RebindCandidate[] = [];
    for (const d of snapshotQuery.data.discoveries) {
      list.push({
        id: d.id,
        source: 'discovery',
        provider_instance_id: d.provider_instance_id,
        provider_kind: d.provider_kind,
        account_id: d.account_id,
        identity: d.identity,
        isOccupied: false,
      });
    }
    for (const b of snapshotQuery.data.bindings) {
      // If binding is pending_reanchor, it needs confirmation regardless of current session_id
      if (b.pending_reanchor) {
        list.push({
          id: b.id,
          source: 'binding',
          provider_instance_id: b.provider_instance_id,
          provider_kind: b.provider_kind,
          account_id: b.account_id,
          identity: b.identity,
          isOccupied: false,
          currentSessionId: b.session_id,
          pendingReanchor: true,
        });
      } else if (!b.session_id) {
        // Orphan binding without session
        list.push({
          id: b.id,
          source: 'binding',
          provider_instance_id: b.provider_instance_id,
          provider_kind: b.provider_kind,
          account_id: b.account_id,
          identity: b.identity,
          isOccupied: false,
          pendingReanchor: false,
        });
      } else if (b.session_id !== sessionId) {
        // Occupied by a different session
        list.push({
          id: b.id,
          source: 'binding',
          provider_instance_id: b.provider_instance_id,
          provider_kind: b.provider_kind,
          account_id: b.account_id,
          identity: b.identity,
          isOccupied: true,
          currentSessionId: b.session_id,
          pendingReanchor: false,
        });
      }
    }
    return list;
  }, [snapshotQuery.data, sessionId]);

  const data = snapshotQuery.data;
  const policy = data?.policy;
  const bindings = useMemo(() => {
    // Only bindings formally anchored to this session and not pending reanchor belong in active list
    return data?.bindings.filter((b) => b.session_id === sessionId && !b.pending_reanchor) ?? [];
  }, [data?.bindings, sessionId]);

  // R2: Authoritative optional row admission — NO guessing
  const smRow = findSendMessageRow(sessionCapQuery.data);
  const smLoading = sessionCapQuery.isLoading;
  const smQueryFailed = sessionCapQuery.isError || (sessionCapQuery.isSuccess && smRow === undefined);
  const smUnresolved = smQueryFailed || (smRow?.unresolved ?? false);
  const smToolPolicyDeny = smRow?.reason === 'tool_policy';
  const smAllowed = smRow ? (smRow.allowed && !smToolPolicyDeny) : false;
  const smHostLocked = smRow?.host_locked ?? false;
  // If query is in error, never treat cached data as currently effective
  const smEffective = !sessionCapQuery.isError && smRow?.effective === true && !smToolPolicyDeny;
  const smChoice = smRow?.choice ?? 'inherit';
  const smSwitchDisabled = !smAllowed || smHostLocked || smUnresolved || smLoading || smToolPolicyDeny || busyId === 'send_message_tool';

  // Compute active counts
  const inboundCount = useMemo(() => policy ? bindings.filter((b) => isBindingAdmittedInbound(b, policy, sessionId)).length : 0, [bindings, policy, sessionId]);
  const outboundImCount = useMemo(() => policy ? bindings.filter((b) => isBindingAdmittedOutbound(b, policy, sessionId)).length : 0, [bindings, policy, sessionId]);

  // R1 / R2: Notification channel filtering (bound vs candidate from target channels)
  const allTargetChannels = useMemo(() => targetChannelsQuery.data?.channels ?? [], [targetChannelsQuery.data?.channels]);
  const boundNotifyChannels = useMemo(() => {
    return allTargetChannels.filter((c) => c.kind === 'notify' && c.bound !== false);
  }, [allTargetChannels]);

  const candidateNotifyChannels = useMemo(() => {
    return allTargetChannels.filter((c) => c.kind === 'notify' && c.bound === false);
  }, [allTargetChannels]);

  const enabledBoundNotifyCount = useMemo(() => {
    return boundNotifyChannels.filter((c) => c.enabled).length;
  }, [boundNotifyChannels]);

  const outboundTotal = 1 + outboundImCount + enabledBoundNotifyCount; // internal (always 1) + IM outbound + Enabled Bound Notify
  const isBorrowingEnabled = policy?.allow_channel_borrowing ?? false;

  const runAction = async (id: string, work: () => Promise<unknown>) => {
    setBusyId(id);
    setError(undefined);
    try {
      await work();
      if (connection) {
        await queryClient.invalidateQueries({ queryKey: ['im-sessions', scopeId, spaceKey] });
        await queryClient.invalidateQueries({ queryKey: ['target-channels', scopeId, spaceKey, sessionId] });
      }
    } catch (caught) {
      if (isIdentityAlreadyBoundError(caught)) {
        const details = extractConflictDetails(caught);
        setRebindConflict(details);
        setRebindModalOpen(true);
        return;
      }
      const message = caught instanceof Error && caught.message ? caught.message : t('st.im.error');
      setError(message);
    } finally {
      setBusyId(undefined);
    }
  };

  // Toggle SendMessage Tool Hot-Reload Switch
  const toggleSendMessageTool = async () => {
    if (!connection || typeof connection.client.setSessionOptionalCapability !== 'function') return;
    const nextChoice = smEffective ? 'off' : 'on';
    setBusyId('send_message_tool');
    try {
      const view = await connection.client.setSessionOptionalCapability(sessionId, {
        id: 'send_message',
        choice: nextChoice,
      });
      queryClient.setQueryData(['optional-capabilities', scopeId, spaceKey, sessionId], view);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('st.im.error'));
    } finally {
      setBusyId(undefined);
    }
  };

  // Toggle Input pill on IM binding (R3: do not silently mutate session_enabled)
  const toggleBindingInput = (binding: ImBinding) => {
    if (!connection || !policy) return;
    const current = isBindingAdmittedInbound(binding, policy, sessionId);
    const next = !current;
    const patch: ImBindingPatch = {
      input_enabled: next,
    };
    void runAction(binding.id, () => connection.client.imSessions.updateBinding(binding.id, patch));
  };

  // Toggle Output pill on IM binding (R3: do not silently mutate session_enabled)
  const toggleBindingOutput = (binding: ImBinding) => {
    if (!connection || !policy) return;
    const current = isBindingAdmittedOutbound(binding, policy, sessionId);
    const next = !current;
    const patch: ImBindingPatch = {
      output_enabled: next,
    };
    void runAction(binding.id, () => connection.client.imSessions.updateBinding(binding.id, patch));
  };

  // Unbind / Remove
  const removeBinding = (bindingId: string) => {
    if (!connection) return;
    void runAction(bindingId, () => connection.client.imSessions.removeBinding(bindingId));
  };

  // R4: Handle Candidate Confirmation
  const onConfirmCandidate = (candidate: RebindCandidate) => {
    if (!connection) return;
    if (candidate.source === 'binding' || candidate.isOccupied) {
      // Any existing binding (whether occupied, orphan, or pending reanchor) requires explicit confirmation modal
      setRebindCandidate(candidate);
      setRebindConflict(undefined);
      setRebindModalOpen(true);
      return;
    }

    // Source is new discovery -> confirm(id) directly
    void runAction(candidate.id, () =>
      connection.client.imSessions.confirm(candidate.id, {
        target: { kind: 'session', session_id: sessionId },
        input_enabled: true,
        output_enabled: true,
      })
    );
  };

  // R4: Execute Rebind from Modal. Reversible (the binding just points at a
  // conversation), so it runs at once and the toast rebinds back to the
  // captured prior owner; the modal opens only to show the move first.
  const handleExecuteRebind = async () => {
    if (!connection) return;
    const candidateId = rebindConflict?.existing_binding_id || rebindCandidate?.id;
    if (!candidateId) return;
    const priorSessionId = rebindConflict?.previous_session_id ?? rebindCandidate?.currentSessionId;

    setRebindModalOpen(false);
    await runAction(candidateId, async () => {
      const isExistingBinding = rebindCandidate?.source === 'binding' || rebindConflict?.existing_binding_id;
      if (isExistingBinding) {
        const patch: ImBindingPatch = {
          session_id: sessionId,
          rebind: true,
          input_enabled: true,
          output_enabled: true,
        };
        return connection.client.imSessions.updateBinding(candidateId, patch);
      }
      return connection.client.imSessions.confirm(candidateId, {
        target: { kind: 'session', session_id: sessionId },
        rebind: true,
        input_enabled: true,
        output_enabled: true,
      });
    });
    if (priorSessionId !== undefined && priorSessionId !== sessionId) {
      pushUndoToast({
        text: t('st.im.rebind.transferred'),
        undoFailedText: t('toast.undoFailed'),
        undo: async () => { await connection.client.imSessions.updateBinding(candidateId, {
          session_id: priorSessionId,
          rebind: true,
          input_enabled: true,
          output_enabled: true,
        }); },
      });
    }
  };

  // R1: Strip 'notify:' prefix so klient sends raw channelId
  const toggleNotifyBinding = async (fullChannelId: string, enabled: boolean) => {
    if (!connection) return;
    const channelId = stripNotifyPrefix(fullChannelId);
    if (enabled) {
      await runAction(`notify:${channelId}`, () =>
        connection.client.imSessions.setNotificationChannel(sessionId, channelId, true)
      );
    } else {
      await runAction(`notify:${channelId}`, () =>
        connection.client.imSessions.removeNotificationChannel(sessionId, channelId)
      );
    }
  };

  const toggleNotifyEnabled = async (channel: ImChannelView) => {
    if (!connection) return;
    const channelId = stripNotifyPrefix(channel.id);
    await runAction(`notify:${channelId}`, () =>
      connection.client.imSessions.setNotificationChannel(sessionId, channelId, !channel.enabled)
    );
  };

  if (connection === null || snapshotQuery.data === undefined || policy === undefined) return null;

  // R2: Authoritative status copy based on effective/allowed/reason (never guess)
  let smStatusText: string;
  if (smLoading) {
    smStatusText = t('st.im.sm.loading');
  } else if (smUnresolved) {
    smStatusText = t('st.im.sm.unresolved');
  } else if (!smAllowed && smHostLocked) {
    smStatusText = t('st.im.sm.hostLocked');
  } else if (!smAllowed || smToolPolicyDeny) {
    smStatusText = t('st.im.sm.hardOff');
  } else if (smEffective) {
    if (personaId !== undefined && personaId !== '') {
      smStatusText = t('st.im.sm.personaActive', { count: outboundTotal, name: personaName || t('st.im.personaDefault') });
    } else if (smChoice === 'on') {
      smStatusText = t('st.im.sm.sessionActive', { count: outboundTotal });
    } else {
      smStatusText = t('st.im.sm.globalActive', { count: outboundTotal });
    }
  } else {
    if (personaId !== undefined && personaId !== '') {
      smStatusText = t('st.im.sm.personaOff');
    } else {
      smStatusText = t('st.im.sm.defaultOff');
    }
  }

  // Lookup notify display name
  const notifyCatalog = notifySettingsQuery.data?.channels ?? {};
  const getNotifyDisplayName = (channelViewId: string) => {
    const rawId = stripNotifyPrefix(channelViewId);
    return notifyCatalog[rawId]?.label || rawId;
  };

  return (
    <section data-rail-channels="">
      {/* Header */}
      <div className="flex items-center justify-between min-h-7 gap-1">
        <button
          type="button"
          data-rail-channels-toggle=""
          aria-expanded={open}
          onClick={() => { setOpen((v) => !v); }}
          className={SECTION_BUTTON}
        >
          <span className={`${INSPECTOR_HEAD} transition-colors group-hover:text-ink`}>
            {t('st.im.channels')}
          </span>
          <span className="text-[12px] text-ink-faint tabular-nums" data-rail-channels-count>
            {bindings.length + boundNotifyChannels.length}
          </span>
          <span className="flex-1" />
          <span className="text-[11.5px] text-ink-faint mr-1" data-rail-channels-summary>
            {inboundCount} {t('st.im.dir.in')} · {outboundTotal} {t('st.im.dir.out')}
          </span>
          <InspectorChevron open={open} />
        </button>

        <button
          type="button"
          data-rail-channel-add=""
          aria-expanded={open && pickerOpen}
          onClick={() => {
            const nextPickerOpen = !open || !pickerOpen;
            setOpen(true);
            setPickerOpen(nextPickerOpen);
          }}
          className={`shrink-0 rounded px-1.5 py-0.5 text-[12px] text-ink-soft hover:bg-ink/[0.05] hover:text-ink ${FOCUS_RING}`}
        >
          {t('st.im.addBinding')}
        </button>
      </div>

      {open ? (
        <div className="pt-2 space-y-3" data-rail-channels-body>
          {/* SendMessage Tool Row */}
          <div
            data-rail-sendmessage-tool=""
            className="rounded-lg border border-hairline bg-ink/[0.02] p-2 space-y-1"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="rounded bg-ink/[0.06] px-1 py-0.5 font-mono text-[10px] text-ink-soft shrink-0">
                  {t('st.im.toolBadge')}
                </span>
                <span className="text-[12px] font-medium text-ink truncate">
                  {t('st.im.sendMessageTitle')}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={smEffective}
                aria-label={t('st.im.sendMessageTitle')}
                disabled={smSwitchDisabled}
                onClick={() => { void toggleSendMessageTool(); }}
                data-rail-sendmessage-switch=""
                className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                  smEffective ? 'bg-selected' : 'bg-hairline-strong'
                } ${smSwitchDisabled ? 'opacity-50 cursor-not-allowed' : ''} ${FOCUS_RING}`}
              >
                <span
                  aria-hidden="true"
                  className={`pointer-events-none inline-block h-2.5 w-2.5 transform rounded-full transition-transform ${
                    smEffective
                      ? 'translate-x-3.5 bg-selected-ink'
                      : 'translate-x-0.5 bg-ink-faint'
                  } mt-0.5`}
                />
              </button>
            </div>
            <div className="text-[11.5px] text-ink-faint leading-normal" data-rail-sm-sub>
              {smStatusText}
            </div>
          </div>

          {/* Group 1: External IM channels */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] font-medium text-ink-faint">
              <span>{t('st.im.group.im')}</span>
              <span>{t('st.im.dir.inOut')}</span>
            </div>

            {bindings.length === 0 ? (
              <p className="py-1 text-[11.5px] text-ink-faint">{t('st.im.noBindings')}</p>
            ) : (
              <ul className="space-y-1" data-rail-im-list>
                {bindings.map((b) => {
                  const isBaseAdmitted = isBindingSessionAdmitted(b, policy, sessionId);
                  const inOn = isBindingAdmittedInbound(b, policy, sessionId);
                  const outOn = isBindingAdmittedOutbound(b, policy, sessionId);
                  const tagType = inOn && outOn ? 'bi' : inOn ? 'in' : outOn ? 'out' : 'off';
                  const identityLabel = formatIdentityVariant(b.identity);
                  const channelInfo = formatIdentityChannel(b.identity.chat_id, b.identity.topic_id);
                  const busy = busyId === b.id;
                  const isBlocked = !policy.allowed || !b.enabled;
                  const isRestricted = !isBaseAdmitted;

                  return (
                    <li
                      key={b.id}
                      data-im-channel-item={b.id}
                      className="group flex flex-col rounded-md px-1.5 py-1 transition-colors hover:bg-ink/[0.035]"
                    >
                      <div className="flex items-center justify-between gap-1.5 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          <span
                            className={`rounded px-1 py-0.2 font-mono text-[10px] shrink-0 ${
                              tagType === 'bi'
                                ? 'bg-selected text-selected-ink'
                                : tagType === 'off'
                                  ? 'bg-ink/[0.06] text-ink-faint'
                                  : 'bg-ink/[0.06] text-ink-soft'
                            }`}
                          >
                            {t(`st.im.tag.${tagType}`)}
                          </span>
                          <span className="text-[12.5px] text-ink truncate" title={identityLabel}>
                            {providerDisplayName(b.provider_kind)} · {identityLabel}
                          </span>
                        </div>

                        {/* IO Capsule buttons */}
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            aria-pressed={inOn}
                            disabled={busy || isBlocked || isRestricted}
                            onClick={() => toggleBindingInput(b)}
                            data-io-pill-in={b.id}
                            title={isBlocked || isRestricted ? t('st.im.channelDisabledHint') : undefined}
                            className={`inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-medium transition-colors ${
                              inOn
                                ? 'border-selected-ink/40 bg-selected text-selected-ink'
                                : 'border-hairline-strong bg-paper text-ink-faint hover:text-ink hover:border-ink-soft'
                            } ${isBlocked || isRestricted ? 'opacity-50 cursor-not-allowed' : ''} ${FOCUS_RING}`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                inOn ? 'bg-selected-ink' : 'bg-ink-faint'
                              }`}
                            />
                            {t('st.im.pill.in')}
                          </button>

                          <button
                            type="button"
                            aria-pressed={outOn}
                            disabled={busy || isBlocked || isRestricted}
                            onClick={() => toggleBindingOutput(b)}
                            data-io-pill-out={b.id}
                            title={isBlocked || isRestricted ? t('st.im.channelDisabledHint') : undefined}
                            className={`inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-medium transition-colors ${
                              outOn
                                ? 'border-selected-ink/40 bg-selected text-selected-ink'
                                : 'border-hairline-strong bg-paper text-ink-faint hover:text-ink hover:border-ink-soft'
                            } ${isBlocked || isRestricted ? 'opacity-50 cursor-not-allowed' : ''} ${FOCUS_RING}`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                outOn ? 'bg-selected-ink' : 'bg-ink-faint'
                              }`}
                            />
                            {t('st.im.pill.out')}
                          </button>
                        </div>
                      </div>

                      {/* Sub row with channel id & unbind action */}
                      <div className="flex items-center justify-between text-[11px] text-ink-faint pt-0.5">
                        <span className="font-mono truncate" title={channelInfo}>
                          {channelInfo}
                          {isRestricted ? (
                            <span className="text-amber-ink ml-1.5">
                              ({t('st.im.channelDisabledHint')})
                            </span>
                          ) : null}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeBinding(b.id)}
                          disabled={busy}
                          className="hover:text-danger hover:underline ml-2"
                        >
                          {t('st.im.unbind')}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Group 2: Outbound Only (Bound Notification channels) */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] font-medium text-ink-faint">
              <span>{t('st.im.group.notify')}</span>
              <span>{t('st.im.dir.out')}</span>
            </div>

            {boundNotifyChannels.length === 0 ? (
              <p className="py-1 text-[11.5px] text-ink-faint">{t('st.im.noNotify')}</p>
            ) : (
              <ul className="space-y-1" data-rail-out-list>
                {boundNotifyChannels.map((c) => {
                  const displayName = getNotifyDisplayName(c.id);
                  const busy = busyId === `notify:${stripNotifyPrefix(c.id)}`;

                  return (
                    <li
                      key={c.id}
                      className="flex items-center justify-between gap-1.5 rounded-md px-1.5 py-1 text-[12px] hover:bg-ink/[0.035]"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className={`rounded px-1 py-0.2 font-mono text-[10px] ${c.enabled ? 'bg-ink/[0.06] text-ink-soft' : 'bg-ink/[0.06] text-ink-faint'}`}>
                          {t(c.enabled ? 'st.im.tag.out' : 'st.im.tag.off')}
                        </span>
                        <span className={`truncate ${c.enabled ? 'text-ink' : 'text-ink-soft'}`}>{displayName}</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => { void toggleNotifyEnabled(c); }}
                          className={`inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-medium transition-colors ${
                            c.enabled
                              ? 'border-selected-ink/40 bg-selected text-selected-ink'
                              : 'border-hairline-strong bg-paper text-ink-faint hover:text-ink'
                          }`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${c.enabled ? 'bg-selected-ink' : 'bg-ink-faint'}`} />
                          {t('st.im.pill.out')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => { void toggleNotifyBinding(c.id, false); }}
                          className="text-[11px] text-ink-faint hover:text-danger hover:underline"
                        >
                          {t('st.im.removeNotify')}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Footer note: internal visible & borrowing status */}
          <div className="flex items-center justify-between text-[11.5px] text-ink-faint pt-1 border-t border-hairline/60">
            <span className="truncate">
              {t('st.im.internalAlwaysOn')} · {t('st.im.borrowing')}:{' '}
              {isBorrowingEnabled ? t('st.im.on') : t('st.im.off')}
            </span>
            {onOpenSettings ? (
              <button
                type="button"
                onClick={onOpenSettings}
                className="hover:text-ink shrink-0 ml-2"
              >
                {t('st.im.settingsLink')}
              </button>
            ) : null}
          </div>

          {/* Inline Candidate Picker */}
          {pickerOpen ? (
            <div
              className="mt-2 rounded-lg border border-dashed border-hairline-strong bg-ink/[0.02] p-2 space-y-2"
              data-rail-channel-picker=""
            >
              <div className="flex items-center justify-between text-[11.5px] font-medium text-ink-soft pb-1 border-b border-hairline">
                <span>{t('st.im.picker.title')}</span>
                <button
                  type="button"
                  onClick={() => setPickerOpen(false)}
                  className="text-ink-faint hover:text-ink text-[11px]"
                >
                  {t('st.im.picker.close')}
                </button>
              </div>

              {candidates.length === 0 && candidateNotifyChannels.length === 0 ? (
                <p className="py-2 text-[12px] text-ink-faint text-center">
                  {t('st.im.picker.empty')}
                </p>
              ) : (
                <ul className="space-y-1.5 max-h-52 overflow-y-auto">
                  {/* IM candidates */}
                  {candidates.map((c) => {
                    const identityText = formatIdentityVariant(c.identity);
                    const channelInfo = formatIdentityChannel(c.identity.chat_id, c.identity.topic_id);
                    const busy = busyId === c.id;

                    return (
                      <li
                        key={c.id}
                        className="flex items-center justify-between gap-2 p-1.5 rounded hover:bg-ink/[0.04]"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] font-medium text-ink truncate">
                            {c.pendingReanchor ? (
                              <span className="text-amber-ink mr-1">
                                [{t('st.im.pendingReanchor')}]
                              </span>
                            ) : null}
                            {providerDisplayName(c.provider_kind)} · {identityText}
                          </p>
                          <p className="text-[11px] font-mono text-ink-faint truncate">
                            {channelInfo}
                            {c.isOccupied ? (
                              <span className="text-amber-ink ml-1.5">
                                ({t('st.im.occupiedBy')}: {c.currentSessionTitle || c.currentSessionId})
                              </span>
                            ) : null}
                          </p>
                        </div>

                        <button
                          type="button"
                          disabled={busy}
                          data-candidate-action={c.isOccupied ? 'rebind' : 'bind'}
                          onClick={() => onConfirmCandidate(c)}
                          className={`shrink-0 rounded px-2 py-0.5 text-[11.5px] font-medium border ${
                            c.isOccupied
                              ? 'border-amber-rule/50 bg-amber-card text-amber-ink hover:bg-amber-rule/20'
                              : 'border-hairline-strong bg-paper text-ink hover:bg-ink/[0.04]'
                          } ${FOCUS_RING}`}
                        >
                          {busy
                            ? t('st.im.railBusy')
                            : c.isOccupied
                              ? t('st.im.rebindButton')
                              : t('st.im.railBind')}
                        </button>
                      </li>
                    );
                  })}

                  {/* Notification channel candidates */}
                  {candidateNotifyChannels.map((nc) => {
                    const displayName = getNotifyDisplayName(nc.id);
                    const busy = busyId === `notify:${stripNotifyPrefix(nc.id)}`;

                    return (
                      <li
                        key={nc.id}
                        className="flex items-center justify-between gap-2 p-1.5 rounded hover:bg-ink/[0.04]"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] font-medium text-ink truncate">
                            {displayName}
                          </p>
                          <p className="text-[11px] text-ink-faint truncate">
                            {t('st.im.notifyCandidate')}
                          </p>
                        </div>

                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => { void toggleNotifyBinding(nc.id, true); }}
                          className={`shrink-0 rounded px-2 py-0.5 text-[11.5px] font-medium border border-hairline-strong bg-paper text-ink hover:bg-ink/[0.04] ${FOCUS_RING}`}
                        >
                          {busy ? t('st.im.railBusy') : t('st.im.bindNotify')}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}

          {/* Action error display */}
          {error ? (
            <p className="text-[11.5px] text-danger pt-1">{error}</p>
          ) : null}
        </div>
      ) : null}

      {/* Cross-session Rebind Confirmation Modal */}
      {rebindModalOpen ? (
        <RebindModal
          open={rebindModalOpen}
          candidate={rebindCandidate}
          conflict={rebindConflict}
          targetSessionId={sessionId}
          targetSessionTitle={sessionTitle}
          onConfirm={() => { void handleExecuteRebind(); }}
          onCancel={() => {
            setRebindModalOpen(false);
            setRebindCandidate(undefined);
            setRebindConflict(undefined);
          }}
        />
      ) : null}
    </section>
  );
}

function providerDisplayName(kind: ImProviderKind): string {
  const map: Record<ImProviderKind, string> = {
    telegram: 'Telegram',
    feishu_app: 'Feishu',
    onebot_v11: 'OneBot',
    wechat_bridge: 'WeChat',
    discord: 'Discord',
    slack: 'Slack',
    matrix: 'Matrix',
  };
  return map[kind] ?? kind;
}
