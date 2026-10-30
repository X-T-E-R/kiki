import { useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  imSessionAdmitted,
  type ImBinding,
  type ImBindingPatch,
  type ImBindingTestResult,
  type ImBusyDelivery,
  type ImCatalog,
  type ImChannelCapability,
  type ImConfirmRequest,
  type ImDiscovery,
  type ImGroupPolicy,
  type ImIdentity,
  type ImProviderKind,
  type ImSessionSnapshot,
} from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { copyTextToClipboard } from '../../../lib/clipboard';
import { pushUndoToast } from '../../../lib/toasts';
import { FeedbackLine, type Feedback } from '../../controls';
import { Icon } from '../../icons';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { AnchoredPopover, usePopover } from '../../overlays/AnchoredPopover';
import { AdvancedDetails } from '../fields';
import { StatusText } from './rowParts';
import { FORM_LABEL, SettingsSegmented, SettingsSelect, type SettingsChoice } from '../SettingsPrimitives';
import {
  bindingTargetChoices, bindingTargetName, bindingTargetValue, defaultTarget, IM_KEY as KEY, identityLabel, liveText, MEDIA_KIND_KEYS, parseTarget,
  type SetupPlatformEntry, type Translator,
} from './imModel';
import { useImAction } from './useImSessions';

/**
 * The conversations that hang off one two-way account: each bound chat,
 * contact, group or topic with its target and options, and each newly heard
 * one waiting to be bound.
 */

type ImBindingScope = NonNullable<ImBinding['binding_scope']>;
type ImWakeMode = NonNullable<ImGroupPolicy['wake']>;

const SCOPE_RANK: Record<ImBindingScope, number> = {
  sender: 1,
  topic: 2,
  chat: 3,
};

function groupScopeChoices(t: Translator, topicDisabled = false): readonly SettingsChoice<ImBindingScope>[] {
  return [
    { value: 'sender', label: t('st.im.groupScope.sender') },
    { value: 'topic', label: t('st.im.groupScope.topic'), disabled: topicDisabled },
    { value: 'chat', label: t('st.im.groupScope.chat') },
  ];
}

function groupWakeChoices(t: Translator): readonly SettingsChoice<ImWakeMode>[] {
  return [
    { value: 'mention_or_reply', label: t('st.im.wake.mention_or_reply') },
    { value: 'always', label: t('st.im.wake.always') },
    { value: 'manual', label: t('st.im.wake.manual') },
  ];
}

function GroupBindingOptions({
  scope,
  wake,
  prefixes,
  topicDisabled = false,
  showWake = false,
  disabled,
  prefix,
  onScope,
  onWake,
  onPrefixes,
}: {
  scope: ImBindingScope;
  wake: ImWakeMode;
  prefixes?: readonly string[];
  topicDisabled?: boolean;
  showWake?: boolean;
  disabled: boolean;
  prefix: string;
  onScope: (scope: ImBindingScope) => void;
  onWake: (wake: ImWakeMode) => void;
  onPrefixes?: (prefixes: string[]) => void;
}) {
  const { t } = useI18n();
  const prefixesId = useId();
  const prefixesValue = (prefixes ?? []).join(', ');
  const policyVisible = scope !== 'sender' || showWake;

  return (
    <div className="space-y-3" data-im-group-options>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="space-y-1">
          <p className="text-[13px] text-ink-soft">{t('st.im.groupScope')}</p>
          <SettingsSegmented
            ariaLabel={t('st.im.groupScope')}
            value={scope}
            disabled={disabled}
            dataAttr={`${prefix}-scope`}
            choices={groupScopeChoices(t, topicDisabled)}
            onChange={onScope}
          />
        </div>
        {policyVisible ? (
          <div className="space-y-1">
            <p className="text-[13px] text-ink-soft">{t('st.im.groupPolicy')}</p>
            <SettingsSegmented
              ariaLabel={t('st.im.groupPolicy')}
              value={wake}
              disabled={disabled}
              dataAttr={`${prefix}-wake`}
              choices={groupWakeChoices(t)}
              onChange={onWake}
            />
          </div>
        ) : null}
      </div>
      {policyVisible && wake === 'mention_or_reply' && onPrefixes ? (
        <div className="space-y-1 max-w-sm">
          <label className="text-[13px] text-ink-soft block" htmlFor={prefixesId}>
            {t('st.im.wake.prefixes')}
          </label>
          <input
            id={prefixesId}
            key={prefixesValue}
            type="text"
            defaultValue={prefixesValue}
            placeholder={t('st.im.wake.prefixesPlaceholder')}
            disabled={disabled}
            className={`${INPUT} text-[13px]`}
            data-im-prefixes={prefix}
            onBlur={(event) => {
              const list = event.currentTarget.value.split(',').map((s) => s.trim()).filter(Boolean);
              if (list.join(',') !== (prefixes ?? []).join(',')) onPrefixes(list);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One conversation as a row inside its channel's body: name, a facts line
 * (bound thread, IM 对话 on/off), the switch and a ⋯ menu (test, unbind). A
 * click opens the editor inline; the parent keeps one open at a time, and a
 * row with unsaved edits keeps its editor next to the next click (rule 13).
 * Chat/sender ids live once, in the 高级 fold with a copy action (rule 14).
 */
export function BindingRow({ binding, policy, catalog, setupPlatform, inbound = true, expanded, onToggle }: {
  binding: ImBinding;
  policy: ImSessionSnapshot['policy'];
  catalog: ImCatalog | undefined;
  setupPlatform?: SetupPlatformEntry;
  inbound?: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const action = useImAction();
  const [removing, setRemoving] = useState(false);
  const menu = usePopover();
  const [search, setSearch] = useState('');
  const [testing, setTesting] = useState(false);
  const [testFeedback, setTestFeedback] = useState<Feedback>(null);

  const isGroup = binding.identity.chat_kind === 'group' && binding.provider_kind !== 'wechat_bridge';
  const topicDisabled = binding.identity.topic_id === '0' || setupPlatform?.capabilities.threads === false;
  const currentScope: ImBindingScope = binding.binding_scope ?? 'sender';
  const currentWake: ImWakeMode = binding.group_policy?.wake ?? 'mention_or_reply';

  const sessions = useQuery({
    queryKey: [...KEY, 'session-search', search.trim()],
    queryFn: async () => (await client.listSessions({ q: search.trim(), page_size: 20 })).items,
    enabled: expanded && search.trim() !== '',
  });
  const targetChannelsQuery = useQuery({
    queryKey: [...KEY, 'target-channels', binding.session_id],
    queryFn: () => client.imSessions.channelViews(binding.session_id!),
    enabled: expanded && binding.session_id !== undefined && typeof client.imSessions.channelViews === 'function',
  });
  const targetCatalog = catalog === undefined ? undefined : { ...catalog, sessions: [...new Map([...catalog.sessions, ...(sessions.data ?? []).map((item) => ({ id: item.id, title: item.title?.trim() || item.id }))].map((item) => [item.id, item])).values()] };
  const identity = identityLabel(binding.identity, t);
  const on = binding.enabled && !binding.pending_reanchor && imSessionAdmitted({ allowed: policy.allowed, defaultEnabled: policy.default_enabled, sessionEnabled: binding.session_enabled });
  const blocked = !policy.allowed || !binding.enabled || binding.pending_reanchor;

  const update = (patch: ImBindingPatch) => {
    setTestFeedback(null);
    void action.run(() => client.imSessions.updateBinding(binding.id, patch));
  };
  const targetValue = bindingTargetValue(binding);
  const boundChannelView = targetChannelsQuery.data?.channels.find((ch) => ch.id === `im:${binding.id}`);

  // A rebind is reversible with the same call, so it runs at once and the
  // toast offers the inverse: rebind back to the target captured before the
  // change. Only a landed write gets an undo — a failed one never announces
  // itself as done.
  const onSelectTarget = (value: string) => {
    if (value === targetValue || action.saving) return;
    const priorTarget = targetValue;
    void (async () => {
      const done = await action.run(() => client.imSessions.updateBinding(binding.id, { target: parseTarget(value), rebind: true }));
      if (!done) return;
      pushUndoToast({
        text: t('st.im.rebind.transferred'),
        undoFailedText: t('toast.undoFailed'),
        undo: async () => {
          await client.imSessions.updateBinding(binding.id, { target: parseTarget(priorTarget), rebind: true });
        },
      });
    })();
  };

  const selectScope = (scope: ImBindingScope) => {
    if (scope === currentScope) return;
    // Sender is the narrowest answer; returning to it never re-anchors the
    // binding, so it stays a plain write like any reduction.
    if (SCOPE_RANK[scope] > SCOPE_RANK[currentScope] && scope !== 'sender') {
      // Widening who lands here is reversible too: run it, then offer to put
      // the captured scope (and its group policy) back.
      const priorScope = currentScope;
      const priorPolicy = binding.group_policy;
      void (async () => {
        const done = await action.run(() => client.imSessions.updateBinding(binding.id, {
          binding_scope: scope,
          group_policy: priorPolicy ?? { wake: 'mention_or_reply' },
          rebind: true,
        }));
        if (!done) return;
        pushUndoToast({
          text: t('st.im.scopeExpand.expanded'),
          undoFailedText: t('toast.undoFailed'),
          undo: async () => {
            await client.imSessions.updateBinding(binding.id, priorPolicy === undefined
              ? { binding_scope: priorScope, group_policy: { wake: 'mention_or_reply' } }
              : { binding_scope: priorScope, group_policy: priorPolicy });
          },
        });
      })();
      return;
    }
    update({ binding_scope: scope });
  };

  const runTestBinding = async () => {
    if (testing || typeof client.imSessions.testBinding !== 'function') return;
    setTesting(true);
    setTestFeedback(null);
    try {
      const res: ImBindingTestResult = await client.imSessions.testBinding(binding.id);
      if (res.status === 'delivered') {
        setTestFeedback({ tone: 'success', text: t('st.im.testBinding.delivered') });
      } else if (res.status === 'unknown') {
        setTestFeedback({ tone: 'info', text: t('st.im.testBinding.unknown') });
      } else if (res.status === 'partial') {
        const msg = res.detail ?? (res.message_ids.length > 0 ? t('st.im.testBinding.partial') : t('st.im.error'));
        setTestFeedback({ tone: 'info', text: msg });
      } else {
        const text = res.detail === 'binding_disabled'
          ? t('st.im.testBinding.failed.binding_disabled')
          : res.detail === 'channel_not_connected'
            ? t('st.im.testBinding.failed.channel_not_connected')
            : t('st.im.testBinding.failed', { detail: res.detail ?? t('st.im.error') });
        setTestFeedback({ tone: 'error', text });
      }
    } catch (caught) {
      const msg = caught instanceof Error && caught.message.length > 0 ? caught.message : t('st.im.error');
      setTestFeedback({ tone: 'error', text: t('st.im.testBinding.failed', { detail: msg }) });
    } finally {
      setTesting(false);
    }
  };



  return <div data-im-binding={binding.id} data-open={expanded ? 'true' : undefined} aria-busy={action.saving || testing}>
    <div className={`flex min-h-11 items-center gap-2 py-1.5 transition-colors ${expanded ? 'bg-ink/[0.03] rounded-lg' : ''}`}>
      <button type="button" data-im-binding-options-toggle={binding.id} aria-expanded={expanded} aria-controls={`im-binding-editor-${binding.id}`}
        aria-label={t('st.notify.expandAria', { name: identity })} onClick={onToggle}
        className="group/row flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40">
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[13px] font-medium text-ink" data-im-binding-identity>{identity}</span>
            {!binding.enabled ? <span className="shrink-0 rounded-[4px] border border-hairline px-1.5 py-px text-[11px] leading-4 text-ink-faint">{t('st.im.disabled')}</span> : null}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px]">
            <StatusText tone={blocked ? (binding.pending_reanchor ? 'warn' : 'idle') : on ? 'ok' : 'idle'}>
              {blocked ? t(binding.pending_reanchor ? 'st.im.pendingReanchor' : !policy.allowed ? 'st.im.railOffAllowed' : 'st.im.railOffBinding') : on ? t('st.im.on') : t('st.im.off')}
            </StatusText>
            <span aria-hidden className="text-ink-faint">·</span>
            <span className="min-w-0 truncate text-ink-faint">{bindingTargetName(targetCatalog, binding, t)}</span>
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1.5 pl-1">
        <button type="button" role="switch" aria-checked={on} aria-label={`${identity}: ${t('st.im.sessionSwitch')}`}
          className="inline-flex min-h-8 items-center gap-2 rounded-md px-2 py-1 text-[13px] text-ink transition-colors hover:bg-ink/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          data-im-session-switch={binding.id} disabled={action.saving || blocked}
          onClick={() => { update({ session_enabled: !on }); }}>
          <span aria-hidden className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full ring-1 transition-colors ${
            on ? 'bg-selected ring-selected-ink/45' : 'bg-hairline ring-hairline-strong'
          }`}>
            <span className={`inline-block h-3 w-3 transform rounded-full transition-transform ${
              on ? 'translate-x-[16px] bg-selected-ink' : 'translate-x-[3px] bg-ink-faint'
            }`} />
          </span>
          <span className="sr-only">{t('st.im.sessionSwitch')}: {t(on ? 'st.im.on' : 'st.im.off')}</span>
        </button>
        <button type="button" data-im-binding-menu={binding.id} {...menu.triggerProps}
          aria-label={t('st.im.bindingMenuAria', { name: identity })}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink">
          <Icon name="more" size={14} />
        </button>
      </div>
    </div>
    {blocked ? (
      <p className="sr-only" data-im-binding-blocked>
        {t(binding.pending_reanchor ? 'st.im.pendingReanchor' : !policy.allowed ? 'st.im.railOffAllowed' : 'st.im.railOffBinding')}
      </p>
    ) : null}
    {testFeedback !== null ? (
      <div className="py-1" data-im-test-binding-result={binding.id}>
        <FeedbackLine feedback={testFeedback} />
      </div>
    ) : null}
    <AnchoredPopover {...menu.popoverProps} role="menu" align="end" widthClassName="w-44"
      label={t('st.im.bindingMenuAria', { name: identity })} data={{ 'data-im-binding-menu-panel': binding.id }}>
      <div className="-m-1.5 flex flex-col p-1">
        <button type="button" role="menuitem" data-im-test-binding={binding.id} disabled={action.saving || testing}
          onClick={() => { menu.setOpen(false); void runTestBinding(); }}
          className="flex min-h-9 w-full items-center rounded-md px-3 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper disabled:cursor-not-allowed disabled:opacity-50">
          {t(testing ? 'st.im.testingBinding' : 'st.im.testBinding')}
        </button>
        <button type="button" role="menuitem" data-im-remove={binding.id}
          onClick={() => { menu.setOpen(false); setRemoving(true); if (!expanded) onToggle(); }}
          className="flex min-h-9 w-full items-center rounded-md px-3 py-1.5 text-left text-[13px] text-danger outline-none transition-colors hover:bg-paper focus-visible:bg-paper">
          {t('st.im.unbind')}
        </button>
      </div>
    </AnchoredPopover>
    <div id={`im-binding-editor-${binding.id}`} hidden={!expanded} data-im-binding-details={binding.id} className="space-y-4 pl-1 pb-3 pt-2">
      <div className="max-w-md space-y-1.5">
        <span className={FORM_LABEL}>{t('st.im.target')}</span>
        <SettingsSelect id={`im-binding-target-${binding.id}`} variant="form" ariaLabel={`${identity}: ${t('st.im.target')}`} value={targetValue}
          choices={bindingTargetChoices(targetCatalog, binding, t)} emptyText={binding.session_id} disabled={action.saving}
          onChange={onSelectTarget} dataAttr="data-im-binding-target" />
        <input type="search" data-im-binding-target-search value={search} aria-label={t('st.im.searchTarget')} placeholder={t('st.im.searchTarget')} className={INPUT} onChange={(event) => { setSearch(event.target.value); }} />
        {sessions.isError ? <p role="alert" className="text-[13px] text-danger">{t('st.im.searchError')}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-ink-soft">{t('st.im.sessionSwitch')}</span>
        <SettingsSegmented ariaLabel={`${identity}: ${t('st.im.sessionSwitch')}`} value={binding.session_enabled === undefined ? 'default' : binding.session_enabled ? 'on' : 'off'} disabled={action.saving || binding.pending_reanchor}
          dataAttr="data-im-binding-policy" choices={[{ value: 'default', label: t('st.im.followDefault') }, { value: 'on', label: t('st.im.on') }, { value: 'off', label: t('st.im.off') }]}
          onChange={(value) => { update({ session_enabled: value === 'default' ? null : value === 'on' }); }} />
      </div>
      {isGroup && inbound ? <GroupBindingOptions
        scope={currentScope}
        wake={currentWake}
        prefixes={binding.group_policy?.prefixes}
        showWake={binding.group_policy !== undefined}
        topicDisabled={topicDisabled}
        disabled={action.saving}
        prefix="data-im-binding"
        onScope={selectScope}
        onWake={(wake) => { update({ group_policy: { ...binding.group_policy, wake } }); }}
        onPrefixes={(prefixes) => {
          if (prefixes.join(',') !== (binding.group_policy?.prefixes ?? []).join(',')) update({ group_policy: { ...binding.group_policy, wake: currentWake, prefixes } });
        }}
      /> : null}
      <BindingOptions kind={binding.provider_kind} setupPlatform={setupPlatform} capabilities={boundChannelView?.capabilities} busy={binding.busy} reply={binding.reply} actions={binding.mobile_interactions} disabled={action.saving} prefix="data-im-binding"
        onBusy={(busy) => { update({ busy }); }} onReply={(reply) => { update({ reply }); }} onActions={(mobile_interactions) => { update({ mobile_interactions }); }} />
      <AdvancedDetails summary={t('st.section.advanced')} data-im-binding-advanced={binding.id}>
        <IdentityIds identity={binding.identity} />
        <button type="button" className={SECONDARY_BUTTON} data-im-enabled={binding.id} disabled={action.saving}
          onClick={() => { update({ enabled: !binding.enabled }); }}>
          {t(binding.enabled ? 'st.im.disable' : 'st.im.enable')}
        </button>
      </AdvancedDetails>
      {removing ? <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-ink-soft">{t('st.im.removeConfirm', { name: identity })}</span>
        <button type="button" className={DANGER_GHOST_BUTTON} data-im-remove-confirm={binding.id} disabled={action.saving} onClick={() => { void action.run(() => client.imSessions.removeBinding(binding.id)); }}>{t('st.im.unbind')}</button>
        <button type="button" className={SECONDARY_BUTTON} onClick={() => { setRemoving(false); }}>{t('common.cancel')}</button>
      </div> : null}
      <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
    </div>
  </div>;
}

/** Raw chat/sender ids, once, with a copy action: the 高级 fold's content. */
function IdentityIds({ identity }: { identity: ImIdentity }) {
  const { t } = useI18n();
  const parts = [
    { label: t('st.im.chatId'), value: identity.chat_id },
    { label: t('st.im.senderId'), value: identity.sender_id },
    ...(identity.topic_id !== '0' ? [{ label: t('st.im.topicId'), value: identity.topic_id }] : []),
  ];
  return (
    <p data-im-identity-ids className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      {parts.map((part, index) => (
        <span key={part.label} className="inline-flex min-w-0 items-baseline gap-1">
          {index > 0 ? <span aria-hidden className="text-ink-faint">·</span> : null}
          <span>{part.label}:</span>
          <button type="button" data-im-copy-id={part.value} title={t('st.channels.copyHint', { value: part.value })}
            onClick={() => { void copyTextToClipboard(part.value); }}
            className="min-w-0 break-all font-mono text-[11.5px] text-ink-soft underline decoration-dotted decoration-ink-faint/60 underline-offset-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink">
            {part.value}
          </button>
        </span>
      ))}
    </p>
  );
}

export function DiscoveryRow({ discovery, catalog, setupPlatform, initialTarget, inbound = true }: {
  discovery: ImDiscovery;
  catalog: ImCatalog | undefined;
  setupPlatform?: SetupPlatformEntry;
  initialTarget: string;
  inbound?: boolean;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const action = useImAction();
  const [target, setTarget] = useState(initialTarget);
  const [alsoHome, setAlsoHome] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<ImBusyDelivery>('immediate');
  const [reply, setReply] = useState<'final' | 'edit'>('final');
  const [actions, setActions] = useState(true);

  const isGroup = discovery.identity.chat_kind === 'group' && discovery.provider_kind !== 'wechat_bridge';
  const topicDisabled = discovery.identity.topic_id === '0' || setupPlatform?.capabilities.threads === false;
  const [scope, setScope] = useState<ImBindingScope>('sender');
  const [wake, setWake] = useState<ImWakeMode>('mention_or_reply');
  const [prefixes, setPrefixes] = useState<string[]>([]);

  useEffect(() => {
    if (initialTarget !== '') setTarget(initialTarget);
  }, [initialTarget]);

  const unsupported = discovery.provider_kind === 'wechat_bridge' && (discovery.identity.chat_kind === 'group' || discovery.identity.topic_id !== '0');
  const selected = target || defaultTarget(catalog);
  return <div data-im-discovery={discovery.id} className="space-y-3 rounded-lg border border-amber-rule/40 bg-amber-card p-3.5">
    <div className="space-y-1">
      <p className="text-[11.5px] font-medium text-amber-ink">{t('st.im.discovery')}</p>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <p className="break-words text-[14px] font-medium text-ink">{identityLabel(discovery.identity, t)}</p>
        {discovery.preview !== '' ? <p className="min-w-0 truncate text-[13px] text-ink-soft" title={discovery.preview}>“{discovery.preview}”</p> : null}
      </div>
      <IdentityIds identity={discovery.identity} />
    </div>
    {unsupported ? <p data-im-unsupported className="text-[13px] leading-5 text-ink-soft">{t('st.im.wechatDirectOnly')}</p> : <TargetPicker id={`im-target-${discovery.id}`} value={selected} onChange={setTarget} catalog={catalog} disabled={action.saving} />}
    {!unsupported && selected.startsWith('persona:') ? <label className="flex min-h-8 items-center gap-2 text-[13px] text-ink-soft">
      <input type="checkbox" data-im-also-home checked={alsoHome} disabled={action.saving} onChange={(event) => { setAlsoHome(event.target.checked); }} />{t('st.im.alsoHome')}
    </label> : null}
    {isGroup && inbound ? <GroupBindingOptions
      scope={scope}
      wake={wake}
      prefixes={prefixes}
      topicDisabled={topicDisabled}
      disabled={action.saving}
      prefix="data-im-discovery"
      onScope={setScope}
      onWake={setWake}
      onPrefixes={setPrefixes}
    /> : null}
    {expanded ? <BindingOptions kind={discovery.provider_kind} setupPlatform={setupPlatform} busy={busy} reply={reply} actions={actions} disabled={action.saving} prefix="data-im"
      onBusy={setBusy} onReply={setReply} onActions={setActions} /> : null}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={PRIMARY_BUTTON} data-im-confirm={discovery.id} disabled={unsupported || selected.length <= 8 || catalog === undefined || action.saving}
        onClick={() => { void action.run(async () => {
          const request: ImConfirmRequest = {
            target: parseTarget(selected),
            busy,
            reply: liveText(discovery.provider_kind, setupPlatform) ? reply : 'final',
            mobile_interactions: actions,
            also_home: selected.startsWith('persona:') && alsoHome,
          };
          if (isGroup && inbound && scope !== 'sender') {
            request.binding_scope = scope;
            request.group_policy = { wake, prefixes: prefixes.length > 0 ? prefixes : undefined };
          }
          const next = await client.imSessions.confirm(discovery.id, request);
          void queryClient.invalidateQueries({ queryKey: [...KEY, 'catalog'] });
          return next;
        }); }}>{t('st.im.confirm')}</button>
      <button type="button" className={SECONDARY_BUTTON} data-im-dismiss={discovery.id} disabled={action.saving} onClick={() => { void action.run(() => client.imSessions.dismiss(discovery.id)); }}>{t('st.im.dismiss')}</button>
      {!unsupported ? <button type="button" className={SECONDARY_BUTTON} data-im-advanced-toggle aria-expanded={expanded} onClick={() => { setExpanded((open) => !open); }}>{t('st.im.advancedOptions')}</button> : null}
    </div>
    <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
  </div>;
}

export function TargetPicker({ id, value, onChange, catalog, disabled, attrPrefix = 'data-im-target' }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  catalog: ImCatalog | undefined;
  disabled: boolean;
  attrPrefix?: 'data-im-target' | 'data-im-preselect';
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const [search, setSearch] = useState('');
  const kind = value.startsWith('session:') ? 'session' : 'persona';
  const query = search.trim();
  const sessions = useQuery({
    queryKey: [...KEY, 'session-search', query],
    queryFn: async () => (await client.listSessions({ q: query, page_size: 20 })).items,
    enabled: query !== '' && kind === 'session',
  });
  const choices = [...(catalog?.personas ?? []).map((item) => ({ value: `persona:${item.id}`, label: `${t('st.im.kindPersona')} · ${item.name}` })),
    ...[...new Map([...(catalog?.sessions ?? []), ...(sessions.data ?? []).map((item) => ({ id: item.id, title: item.title?.trim() || item.id }))].map((item) => [item.id, item])).values()]
      .map((item) => ({ value: `session:${item.id}`, label: `${t('st.im.kindSession')} · ${item.title}` }))];
  if (value.length > 8 && !choices.some((item) => item.value === value)) choices.unshift({ value, label: value.slice(8) });
  const filtered = choices.filter((item) => item.value === value || (item.value.startsWith(`${kind}:`) && item.label.toLowerCase().includes(query.toLowerCase())));
  return <div className="space-y-2" {...{ [`${attrPrefix}-editor`]: id }}>
    <div className="flex flex-wrap items-center gap-2">
      <SettingsSegmented ariaLabel={t('st.im.target')} value={kind} disabled={disabled} dataAttr={`${attrPrefix}-kind`}
        choices={[{ value: 'persona', label: t('st.im.kindPersona') }, { value: 'session', label: t('st.im.kindSession') }]}
        onChange={(next) => { setSearch(''); onChange(choices.find((item) => item.value.startsWith(`${next}:`))?.value ?? `${next}:`); }} />
      {kind === 'session' || choices.length > 6 ? <input type="search" value={search} {...{ [`${attrPrefix}-search`]: '' }} placeholder={t('st.im.searchTarget')} aria-label={t('st.im.searchTarget')} className={`${INPUT} min-w-0 flex-1`} onChange={(event) => { setSearch(event.target.value); }} /> : null}
    </div>
    <SettingsSelect id={id} variant="form" ariaLabel={t('st.im.target')} value={value} choices={filtered} onChange={onChange} disabled={disabled || filtered.length === 0} emptyText={t('st.im.noTargetsYet')} dataAttr={attrPrefix} />
    {sessions.isError ? <p role="alert" className="text-[13px] text-danger">{t('st.im.searchError')}</p> : null}
  </div>;
}

function BindingOptions({ kind, setupPlatform, capabilities, busy, reply, actions, disabled, prefix, onBusy, onReply, onActions }: {
  kind: ImProviderKind;
  setupPlatform?: SetupPlatformEntry;
  capabilities?: readonly ImChannelCapability[];
  busy: ImBusyDelivery;
  reply: 'final' | 'edit';
  actions: boolean;
  disabled: boolean;
  prefix: string;
  onBusy: (value: ImBusyDelivery) => void;
  onReply: (value: 'final' | 'edit') => void;
  onActions: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const mediaLabels = (capabilities ?? [])
    .map((cap) => cap.kind)
    .filter((k) => k !== 'text')
    .map((k) => (MEDIA_KIND_KEYS[k] !== undefined ? t(MEDIA_KIND_KEYS[k]!) : k));
  return <div className="space-y-2" data-im-bind-advanced>
    <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
      <div className="space-y-1"><p className="text-[13px] text-ink-soft">{t('st.im.busy')}</p>
        <SettingsSegmented ariaLabel={t('st.im.busy')} value={busy} onChange={onBusy} disabled={disabled} dataAttr={`${prefix}-busy`} choices={[{ value: 'immediate', label: t('st.im.immediate') }, { value: 'queue', label: t('st.im.queue') }, { value: 'steer', label: t('st.im.steer') }]} />
      </div>
      <div className="space-y-1"><p className="text-[13px] text-ink-soft">{t('st.im.text')}</p>
        <ReplyMode kind={kind} setupPlatform={setupPlatform} value={reply} onChange={onReply} disabled={disabled} dataAttr={`${prefix}-text`} />
      </div>
      <div className="space-y-1"><p className="text-[13px] text-ink-soft">{t('st.im.actions')}</p>
        <SettingsSegmented ariaLabel={t('st.im.actions')} value={actions ? 'on' : 'off'} disabled={disabled} dataAttr={`${prefix}-actions`} onChange={(value) => { onActions(value === 'on'); }} choices={[{ value: 'on', label: t('st.im.on') }, { value: 'off', label: t('st.im.off') }]} />
      </div>
    </div>
    {mediaLabels.length > 0 ? (
      <p className="text-[12px] text-ink-soft" data-im-binding-media>
        {t('st.im.cap.outboundMedia', { kinds: mediaLabels.join(' / ') })}
      </p>
    ) : null}
  </div>;
}

function ReplyMode({ kind, setupPlatform, value, onChange, disabled, dataAttr }: {
  kind: ImProviderKind;
  setupPlatform?: SetupPlatformEntry;
  value: 'final' | 'edit';
  onChange: (value: 'final' | 'edit') => void;
  disabled: boolean;
  dataAttr: string;
}) {
  const { t } = useI18n();
  if (!liveText(kind, setupPlatform)) return <p className="flex h-7 items-center text-[13px] text-ink" data-im-text-fixed={kind}>{t('st.im.final')}</p>;
  return <SettingsSegmented ariaLabel={t('st.im.text')} value={value} onChange={onChange} disabled={disabled} dataAttr={dataAttr} choices={[{ value: 'final', label: t('st.im.final') }, { value: 'edit', label: t('st.im.edit') }]} />;
}
