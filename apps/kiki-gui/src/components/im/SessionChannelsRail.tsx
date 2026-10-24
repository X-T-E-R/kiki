import { memo, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  imSessionAdmitted,
  type ImBinding,
  type ImDiscovery,
  type ImProviderKind,
  type ImSessionSnapshot,
} from '@kiki/protocol';
import type { OptionalCapabilitySessionResponse } from '@kiki/protocol';

import { useChannelsI18n as useI18n } from './channelsI18n';
import { useOptionalConnection } from '../../state/connection';
import { Icon } from '../icons';
import { FOCUS_RING } from '../rail-variants/shell';
import { INSPECTOR_HEAD, InspectorChevron } from '../agent-panel/InspectorSection';
import { RebindModal } from './RebindModal';
import {
  extractConflictDetails,
  formatIdentityChannel,
  formatIdentityVariant,
  isIdentityAlreadyBoundError,
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

export const SessionChannelsRail = memo(function SessionChannelsRail({
  sessionId,
  sessionTitle,
  personaId,
  personaName,
  onOpenSettings,
}: SessionChannelsRailProps) {
  const connection = useOptionalConnection();
  if (connection === null) return null;
  return (
    <SessionChannelsRailBody
      key={sessionId}
      sessionId={sessionId}
      sessionTitle={sessionTitle}
      personaId={personaId}
      personaName={personaName}
      onOpenSettings={onOpenSettings}
    />
  );
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

  const [open, setOpen] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Rebind dialog state
  const [rebindCandidate, setRebindCandidate] = useState<RebindCandidate | undefined>();
  const [rebindConflict, setRebindConflict] = useState<RebindConflictDetails | undefined>();
  const [rebindModalOpen, setRebindModalOpen] = useState(false);

  // Queries
  const snapshotQuery = useQuery({
    queryKey: ['im-sessions'],
    queryFn: () => connection!.client.imSessions.snapshot(),
    enabled: connection !== null,
    placeholderData: (previous) => previous,
    refetchInterval: (query) => query.state.data?.instances.some((item) => item.listening) === true ? 2_000 : false,
  });

  const sessionCapQuery = useQuery({
    queryKey: ['optional-capabilities', connection?.scopeId, sessionId],
    queryFn: () => connection!.client.getSessionOptionalCapabilities(sessionId),
    enabled: connection !== null && typeof connection.client.getSessionOptionalCapabilities === 'function',
    staleTime: 5_000,
  });

  const configQuery = useQuery({
    queryKey: ['config', connection?.scopeId],
    queryFn: () => connection!.client.getConfig(),
    enabled: connection !== null && typeof connection.client.getConfig === 'function',
    staleTime: 30_000,
  });

  const notifySettingsQuery = useQuery({
    queryKey: ['notifications', 'settings'],
    queryFn: () => connection!.client.notifications.getSettings(),
    enabled: connection !== null && typeof connection.client.notifications?.getSettings === 'function',
    staleTime: 15_000,
  });

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
      if (b.session_id !== sessionId) {
        list.push({
          id: b.id,
          source: 'binding',
          provider_instance_id: b.provider_instance_id,
          provider_kind: b.provider_kind,
          account_id: b.account_id,
          identity: b.identity,
          isOccupied: true,
          currentSessionId: b.session_id,
          pendingReanchor: (b as unknown as { pending_reanchor?: boolean })?.pending_reanchor,
        });
      }
    }
    return list;
  }, [snapshotQuery.data, sessionId]);

  const data = snapshotQuery.data;
  const policy = data?.policy;
  const instances = data?.instances;
  const bindings = useMemo(() => data?.bindings.filter((b) => b.session_id === sessionId) ?? [], [data?.bindings, sessionId]);

  // SendMessage tool state
  const smCapRow = sessionCapQuery.data?.rows.find((r) => r.id === 'send_message');
  const smDefaultOn = configQuery.data?.optional_capabilities?.['send_message']?.default_on ?? false;
  const hasPersona = personaId !== undefined && personaId !== '';
  const smChoice = smCapRow?.choice ?? 'inherit';
  const smToolActive = hasPersona
    ? smChoice !== 'off'
    : (smChoice === 'on' || (smChoice === 'inherit' && smDefaultOn));

  // Compute active counts
  const inboundCount = useMemo(() => policy ? bindings.filter((b) => isBindingAdmittedInbound(b, policy)).length : 0, [bindings, policy]);
  const outboundImCount = useMemo(() => policy ? bindings.filter((b) => isBindingAdmittedOutbound(b, policy)).length : 0, [bindings, policy]);

  // Single-direction notify channels (outbound only)
  const notifyChannels = useMemo(() => (notifySettingsQuery.data?.channels ?? []).filter((c) => c.enabled), [notifySettingsQuery.data?.channels]);
  const outboundTotal = 1 + outboundImCount + notifyChannels.length; // internal (always 1) + IM outbound + Notify

  const isBorrowingEnabled = (policy as unknown as { allow_channel_borrowing?: boolean })?.allow_channel_borrowing ?? false;

  const runAction = async (id: string, work: () => Promise<unknown>) => {
    setBusyId(id);
    setError(undefined);
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: ['im-sessions'] });
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
    if (typeof connection.client.setSessionOptionalCapability !== 'function') return;
    const nextChoice = smToolActive ? 'off' : 'on';
    setBusyId('send_message_tool');
    try {
      const view = await connection.client.setSessionOptionalCapability(sessionId, {
        id: 'send_message',
        choice: nextChoice,
      });
      queryClient.setQueryData(['optional-capabilities', connection.scopeId, sessionId], view);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('st.im.error'));
    } finally {
      setBusyId(undefined);
    }
  };

  // Toggle Input pill on IM binding
  const toggleBindingInput = (binding: ImBinding) => {
    if (!policy) return;
    const current = isBindingAdmittedInbound(binding, policy);
    const next = !current;
    runAction(binding.id, () =>
      connection.client.imSessions.updateBinding(binding.id, {
        input_enabled: next,
        ...(binding.session_enabled === undefined ? { session_enabled: true } : {}),
      } as unknown as Parameters<typeof connection.client.imSessions.updateBinding>[1])
    );
  };

  // Toggle Output pill on IM binding
  const toggleBindingOutput = (binding: ImBinding) => {
    if (!policy) return;
    const current = isBindingAdmittedOutbound(binding, policy);
    const next = !current;
    runAction(binding.id, () =>
      connection.client.imSessions.updateBinding(binding.id, {
        output_enabled: next,
        ...(binding.session_enabled === undefined ? { session_enabled: true } : {}),
      } as unknown as Parameters<typeof connection.client.imSessions.updateBinding>[1])
    );
  };

  // Unbind / Remove
  const removeBinding = (bindingId: string) => {
    runAction(bindingId, () => connection.client.imSessions.removeBinding(bindingId));
  };

  if (connection === null || snapshotQuery.data === undefined || policy === undefined) return null;

  const onConfirmCandidate = (candidate: RebindCandidate) => {
    if (candidate.isOccupied) {
      setRebindCandidate(candidate);
      setRebindConflict(undefined);
      setRebindModalOpen(true);
      return;
    }
    runAction(candidate.id, () =>
      connection.client.imSessions.confirm(candidate.id, {
        target: { kind: 'session', session_id: sessionId },
      })
    );
  };

  const handleExecuteRebind = async () => {
    const candidateId = rebindConflict?.existing_binding_id || rebindCandidate?.id;
    if (!candidateId) return;
    setRebindModalOpen(false);
    await runAction(candidateId, async () => {
      if (rebindCandidate?.source === 'binding' || rebindConflict?.existing_binding_id) {
        return connection.client.imSessions.updateBinding(candidateId, {
          session_id: sessionId,
          rebind: true,
          input_enabled: true,
          output_enabled: true,
        } as unknown as Parameters<typeof connection.client.imSessions.updateBinding>[1]);
      }
      return connection.client.imSessions.confirm(candidateId, {
        target: { kind: 'session', session_id: sessionId },
        rebind: true,
      } as unknown as Parameters<typeof connection.client.imSessions.confirm>[1]);
    });
  };

  const smStatusText = hasPersona
    ? t('st.im.sm.personaActive', { count: outboundTotal, name: personaName || t('st.im.personaDefault') })
    : smToolActive
      ? t('st.im.sm.sessionActive', { count: outboundTotal })
      : t('st.im.sm.defaultOff');

  return (
    <section data-rail-channels="" className="border-t border-hairline py-3">
      {/* Header */}
      <div className="flex items-center justify-between min-h-7 gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => { setOpen((v) => !v); }}
          className={SECTION_BUTTON}
        >
          <span className={`${INSPECTOR_HEAD} transition-colors group-hover:text-ink`}>
            {t('st.im.channels')}
          </span>
          <span className="text-[12px] text-ink-faint tabular-nums" data-rail-channels-count>
            {bindings.length + notifyChannels.length}
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
          aria-expanded={pickerOpen}
          onClick={() => { setPickerOpen((v) => !v); }}
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
                <span className="rounded bg-ink/[0.06] px-1 py-0.5 text-[10.5px] font-mono text-ink-soft">
                  {t('st.im.toolBadge')}
                </span>
                <span className="text-[12.5px] font-medium text-ink truncate">
                  {t('st.im.sendMessageTitle')}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={smToolActive}
                aria-label={t('st.im.sendMessageTitle')}
                disabled={busyId === 'send_message_tool'}
                onClick={toggleSendMessageTool}
                data-rail-sm-switch=""
                className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border transition-colors ${
                  smToolActive ? 'border-selected-ink/40 bg-selected' : 'border-hairline-strong bg-hairline'
                } ${FOCUS_RING}`}
              >
                <span
                  aria-hidden="true"
                  className={`pointer-events-none inline-block h-2.5 w-2.5 transform rounded-full transition-transform ${
                    smToolActive
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
                  const inOn = isBindingAdmittedInbound(b, policy);
                  const outOn = isBindingAdmittedOutbound(b, policy);
                  const tagType = inOn && outOn ? 'bi' : inOn ? 'in' : outOn ? 'out' : 'off';
                  const identityLabel = formatIdentityVariant(b.identity);
                  const channelInfo = formatIdentityChannel(b.identity.chat_id, b.identity.topic_id);
                  const busy = busyId === b.id;

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
                            {providerDisplayName(b.provider_kind, t)} · {identityLabel}
                          </span>
                        </div>

                        {/* IO Capsule buttons */}
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            aria-pressed={inOn}
                            disabled={busy}
                            onClick={() => toggleBindingInput(b)}
                            data-io-pill-in={b.id}
                            className={`inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-medium transition-colors ${
                              inOn
                                ? 'border-selected-ink/40 bg-selected text-selected-ink'
                                : 'border-hairline-strong bg-paper text-ink-faint hover:text-ink hover:border-ink-soft'
                            } ${FOCUS_RING}`}
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
                            disabled={busy}
                            onClick={() => toggleBindingOutput(b)}
                            data-io-pill-out={b.id}
                            className={`inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-medium transition-colors ${
                              outOn
                                ? 'border-selected-ink/40 bg-selected text-selected-ink'
                                : 'border-hairline-strong bg-paper text-ink-faint hover:text-ink hover:border-ink-soft'
                            } ${FOCUS_RING}`}
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

          {/* Group 2: Outbound Only (Notify / Webhook) */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] font-medium text-ink-faint">
              <span>{t('st.im.group.notify')}</span>
              <span>{t('st.im.dir.out')}</span>
            </div>

            {notifyChannels.length === 0 ? (
              <p className="py-1 text-[11.5px] text-ink-faint">{t('st.im.noNotify')}</p>
            ) : (
              <ul className="space-y-1" data-rail-out-list>
                {notifyChannels.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-1.5 rounded-md px-1.5 py-1 text-[12px] hover:bg-ink/[0.035]"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="rounded bg-ink/[0.06] px-1 py-0.2 font-mono text-[10px] text-ink-soft">
                        {t('st.im.tag.out')}
                      </span>
                      <span className="truncate text-ink">{c.name}</span>
                    </div>
                    <span className="inline-flex h-5 items-center gap-1 rounded border border-selected-ink/40 bg-selected px-1.5 text-[11px] font-medium text-selected-ink">
                      <span className="h-1.5 w-1.5 rounded-full bg-selected-ink" />
                      {t('st.im.pill.out')}
                    </span>
                  </li>
                ))}
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
              className="mt-2 rounded-lg border border-dashed border-hairline-strong bg-ink/[0.02] p-2 space-y-1.5"
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

              {candidates.length === 0 ? (
                <p className="py-2 text-[12px] text-ink-faint text-center">
                  {t('st.im.picker.empty')}
                </p>
              ) : (
                <ul className="space-y-1 max-h-48 overflow-y-auto">
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
                            {providerDisplayName(c.provider_kind, t)} · {identityText}
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
                </ul>
              )}
            </div>
          ) : null}

          {error ? (
            <p className="text-[11.5px] text-danger pt-1">{error}</p>
          ) : null}
        </div>
      ) : null}

      {/* Rebind Secondary Confirmation Modal */}
      <RebindModal
        open={rebindModalOpen}
        candidate={rebindCandidate}
        conflict={rebindConflict}
        targetSessionId={sessionId}
        targetSessionTitle={sessionTitle}
        busy={busyId !== undefined}
        onCancel={() => {
          setRebindModalOpen(false);
          setRebindCandidate(undefined);
          setRebindConflict(undefined);
        }}
        onConfirm={handleExecuteRebind}
      />
    </section>
  );
}

function isBindingAdmittedInbound(
  binding: ImBinding,
  policy: ImSessionSnapshot['policy'],
): boolean {
  if (!policy.allowed || !binding.enabled) return false;
  const base = imSessionAdmitted({
    allowed: policy.allowed,
    defaultEnabled: policy.default_enabled,
    sessionEnabled: binding.session_enabled,
  });
  if (!base) return false;
  const inputEnabled = (binding as unknown as { input_enabled?: boolean }).input_enabled;
  return inputEnabled ?? true;
}

function isBindingAdmittedOutbound(
  binding: ImBinding,
  policy: ImSessionSnapshot['policy'],
): boolean {
  if (!policy.allowed || !binding.enabled) return false;
  const base = imSessionAdmitted({
    allowed: policy.allowed,
    defaultEnabled: policy.default_enabled,
    sessionEnabled: binding.session_enabled,
  });
  if (!base) return false;
  const outputEnabled = (binding as unknown as { output_enabled?: boolean }).output_enabled;
  return outputEnabled ?? true;
}

function providerDisplayName(kind: ImProviderKind, t: ReturnType<typeof useI18n>['t']): string {
  if (kind === 'wechat_bridge') return t('st.im.provider.wechat_bridge');
  if (kind === 'telegram') return t('st.im.provider.telegram');
  if (kind === 'feishu_app') return t('st.im.provider.feishu_app');
  if (kind === 'onebot_v11') return t('st.im.provider.onebot_v11');
  return kind;
}
