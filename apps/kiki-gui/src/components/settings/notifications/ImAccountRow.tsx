import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ImCatalog, ImConnectionDetail, ImSessionSnapshot } from '@kiki/protocol';
import { pluginSettingsPath } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Toggle } from '../../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { FORM_LABEL } from '../SettingsPrimitives';
import { brandOfIm } from './catalog';
import { BindingRow, DiscoveryRow, TargetPicker } from './ImBindings';
import {
  defaultTarget, IM_KEY, IM_STATE_KEY, instanceDisplayName, instanceState, isSetupProvider,
  type ImAccountState, type ImInstanceStatus, type SetupPlatformEntry,
} from './imModel';
import { PlatformSetupForm, WechatScan } from './ImSetup';
import { PasteSetupForm } from './PasteSetupForm';
import { ChannelListRow, StatusText, type StatusTone } from './rowParts';
import { useImAction, useStartListening, useWechatQr } from './useImSessions';

const TONE: Record<ImAccountState, StatusTone> = {
  listening: 'ok', starting: 'busy', reconnecting: 'busy', auth_expired: 'warn', stopped: 'error', paused: 'idle',
};

/**
 * One two-way account in "My channels". The row says whether Kiki is
 * listening and how many conversations it carries; underneath sit what needs
 * fixing, the conversations themselves (bound chats and newly heard ones),
 * and the account's own re-authorization.
 */
export function ImAccountRow({ account, data, catalog, setupPlatform, initialTarget, preselectedTarget, onPreselectTarget, defaultOpen }: {
  account: ImInstanceStatus;
  data: ImSessionSnapshot;
  catalog: ImCatalog | undefined;
  setupPlatform?: SetupPlatformEntry;
  initialTarget: string;
  preselectedTarget?: string;
  onPreselectTarget: (target: string) => void;
  defaultOpen: boolean;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const action = useImAction();
  const startListening = useStartListening();
  const bindings = data.bindings.filter((item) => item.provider_instance_id === account.id);
  const discoveries = data.discoveries.filter((item) => item.provider_instance_id === account.id);
  const state = instanceState(account);
  const [open, setOpen] = useState(defaultOpen || discoveries.length > 0 || state === 'auth_expired');
  const [reauthorizing, setReauthorizing] = useState(false);
  const name = instanceDisplayName(account, t);
  const brand = brandOfIm(account.provider_kind);
  const qqPlugin = account.provider_kind.startsWith('plugin:kiki-qq/') || account.id.startsWith('plugin:kiki-qq/');
  const bodyId = `im-account-${account.id.replace(/[^A-Za-z0-9_-]/gu, '-')}`;
  const canListen = account.adapter !== 'missing';
  const listen = (on: boolean) => { void action.run(() => on ? startListening(account.id) : client.imSessions.listen(account.id, false)); };
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: IM_KEY }); };
  const effectivePreselect = preselectedTarget ?? (initialTarget || defaultTarget(catalog));

  const status = discoveries.length > 0
    ? <StatusText tone="warn" data={{ 'data-im-instance-state': state, 'data-im-connection': account.connection }}>{t('st.channels.newMessages', { count: discoveries.length })}</StatusText>
    : <StatusText tone={TONE[state]} data={{ 'data-im-instance-state': state, 'data-im-connection': account.connection }}>{t(IM_STATE_KEY[state])}</StatusText>;
  const meta = bindings.length === 0 ? t('st.channels.noConversations') : bindings.length === 1 ? t('st.channels.conversationCount.one') : t('st.channels.conversationCount', { count: bindings.length });

  return (
    <ChannelListRow
      data={{ 'data-im-account': account.id, 'data-im-instance-row': account.id, 'data-channel-row': `im:${account.id}` }}
      brand={brand} twoWay name={name} status={status} meta={meta}
      open={open} onToggle={() => { setOpen((value) => !value); }} bodyId={bodyId}
      expandLabel={t('st.notify.expandAria', { name })}
      control={canListen ? (
        <span data-im-listen={account.id} className="contents">
          <Toggle layout="bare" label={t('st.channels.listenToggle', { name })} checked={account.listening}
            disabled={action.saving} onChange={listen} />
        </span>
      ) : undefined}
    >
      <h3 className="sr-only">{name}</h3>
      <AccountProblems account={account} state={state} busy={action.saving}
        onRetry={() => { void action.run(() => startListening(account.id)); }}
        onReauthorize={() => { setReauthorizing(true); }} />
      <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />

      {state === 'auth_expired' && bindings.length === 0 && discoveries.length === 0 ? null : <section className="space-y-2" data-im-conversations={account.id}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] font-medium text-ink">{t('st.channels.conversations')}</p>
          {account.listening ? (
            <button type="button" className="rounded-md px-2 py-1 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink" data-im-refresh-discovery onClick={refresh}>
              {t('st.im.refreshDiscovery')}
            </button>
          ) : null}
        </div>
        {discoveries.length > 0 ? <div className="space-y-2.5" data-im-discoveries={account.id}>
          {discoveries.map((discovery) => (
            <DiscoveryRow key={discovery.id} discovery={discovery} catalog={catalog} setupPlatform={setupPlatform}
              initialTarget={preselectedTarget ?? initialTarget} inbound={account.inbound !== false} />
          ))}
        </div> : null}
        {bindings.length > 0 ? <div data-im-bindings-list className="divide-y divide-hairline rounded-lg border border-hairline bg-panel px-3">
          {bindings.map((binding) => <BindingRow key={binding.id} binding={binding} policy={data.policy} catalog={catalog} setupPlatform={setupPlatform} inbound={account.inbound !== false} />)}
        </div> : null}
        {state === 'auth_expired' ? null : <div data-im-bind-flow={account.id} className="space-y-3 rounded-lg border border-dashed border-hairline-strong px-3.5 py-3">
          <p className="text-[12.5px] leading-5 text-ink-soft" data-im-awaiting-discovery>
            {t(account.listening
              ? account.provider_kind === 'wechat_bridge' ? 'st.channels.addConversation.wechat' : 'st.channels.addConversation'
              : 'st.channels.addConversation.paused')}
          </p>
          {!account.listening && canListen ? (
            <button type="button" data-im-bind-listen className={PRIMARY_BUTTON} disabled={action.saving} onClick={() => { listen(true); }}>{t('st.im.startListenNow')}</button>
          ) : null}
          {account.listening && discoveries.length === 0 && bindings.length === 0 && catalog !== undefined ? (
            <div className="max-w-md space-y-1.5" data-im-preselect-flow={account.id}>
              <span className={FORM_LABEL}>{t('st.channels.preselect')}</span>
              <TargetPicker id={`im-preselect-${account.id}`} value={effectivePreselect} onChange={onPreselectTarget}
                catalog={catalog} disabled={action.saving} attrPrefix="data-im-preselect" />
            </div>
          ) : null}
        </div>}
      </section>}

      <section className="space-y-3 pt-4" data-im-account-settings={account.id}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px]">
          <span className="text-ink-faint">{t('st.channels.accountId')}</span>
          <span className="min-w-0 break-all font-mono text-ink-soft" data-im-adapter={account.adapter}>{account.account_id ?? account.id}</span>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {qqPlugin ? (
              <Link to={pluginSettingsPath('kiki-qq')} className="text-selected-ink hover:underline" data-im-plugin-settings="kiki-qq">
                {t('st.im.configureAccount')}
              </Link>
            ) : state === 'auth_expired' && !reauthorizing ? null : (
              <button type="button" className={SECONDARY_BUTTON} data-im-reauthorize={account.id} aria-expanded={reauthorizing}
                onClick={() => { setReauthorizing((value) => !value); }}>
                {t(reauthorizing ? 'st.im.closeBindFlow' : 'st.im.reauthorize')}
              </button>
            )}
          </span>
        </div>
        {reauthorizing && !qqPlugin ? (
          <div className="rounded-lg border border-hairline bg-panel p-4" data-im-connect-drawer data-im-instance={account.id}>
            <Reauthorize account={account} setupPlatform={setupPlatform}
              onDone={() => { setReauthorizing(false); }} />
          </div>
        ) : null}
      </section>
    </ChannelListRow>
  );
}

function AccountProblems({ account, state, busy, onRetry, onReauthorize }: {
  account: ImInstanceStatus;
  state: ImAccountState;
  busy: boolean;
  onRetry: () => void;
  onReauthorize: () => void;
}) {
  const { t } = useI18n();
  if (state === 'auth_expired') {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] leading-5" data-im-problems={account.id}>
        <p className="min-w-0 flex-1 text-amber-ink" data-im-connection-detail>{t('st.im.authExpiredHint')}</p>
        <button type="button" className={SECONDARY_BUTTON} data-im-reauthorize-now={account.id} onClick={onReauthorize}>{t('st.im.reauthorize')}</button>
        {(account.inbound_diagnostics?.length ?? 0) > 0 ? <div className="basis-full"><InboundFailures diagnostics={account.inbound_diagnostics!} /></div> : null}
      </div>
    );
  }
  const lines = [
    account.connection_detail !== undefined ? <ConnectionFailure key="detail" detail={account.connection_detail} /> : null,
    (account.inbound_diagnostics?.length ?? 0) > 0 ? <InboundFailures key="inbound" diagnostics={account.inbound_diagnostics!} /> : null,
    account.conflict === 'webhook' ? <p key="webhook" data-im-webhook className="text-amber-ink">{t('st.im.webhook')}</p> : null,
    account.adapter === 'missing' ? <p key="missing" data-im-missing className="text-ink-soft">{t('st.im.missing')}</p> : null,
  ].filter(Boolean);
  const fix = state === 'stopped' && account.listening
    ? <button type="button" className={PRIMARY_BUTTON} data-im-retry-connection={account.id} disabled={busy || account.adapter === 'missing'} onClick={onRetry}>{t('st.im.retryConnection')}</button>
    : null;
  if (lines.length === 0 && fix === null) return null;
  return (
    <div className="space-y-2 rounded-lg bg-amber-card/60 px-3.5 py-3 text-[13px] leading-5" data-im-problems={account.id}>
      {lines}
      {fix}
    </div>
  );
}

/** Replace this account's credential in place; nothing here creates a second account. */
function Reauthorize({ account, setupPlatform, onDone }: {
  account: ImInstanceStatus;
  setupPlatform?: SetupPlatformEntry;
  onDone: () => void;
}) {
  const action = useImAction();
  const startListening = useStartListening();
  const [savedId, setSavedId] = useState<string>();
  const queryClient = useQueryClient();
  const finish = (id: string | undefined) => {
    if (id === undefined) return;
    void action.run(async () => {
      const next = await startListening(id);
      onDone();
      return next;
    });
  };
  const qr = useWechatQr(finish);
  if (account.provider_kind === 'wechat_bridge') return <><WechatScan qr={qr} /><FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} /></>;
  if (isSetupProvider(account.provider_kind) && setupPlatform !== undefined) {
    return <>
      <PlatformSetupForm platform={setupPlatform} instanceId={account.id} savedInstanceId={savedId} busy={action.saving}
        onSaved={async (result) => { setSavedId(result.provider_instance_id); await queryClient.invalidateQueries({ queryKey: IM_KEY }); }}
        onCheckAndListen={finish} />
      <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
    </>;
  }
  return <PasteSetupForm kind="raw" instanceId={account.id} onConnected={() => { onDone(); }} />;
}

function InboundFailures({ diagnostics }: { diagnostics: NonNullable<ImInstanceStatus['inbound_diagnostics']> }) {
  const { t } = useI18n();
  return <details data-im-inbound-diagnostics className="text-amber-ink">
    <summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-selected-ink">{t('st.im.inboundFailureCount', { count: diagnostics.length })}</summary>
    <ul className="mt-1 max-h-64 space-y-2 overflow-y-auto pl-4">
      {diagnostics.map((diagnostic) => <li key={`${diagnostic.source_id}:${diagnostic.code}`} data-im-inbound-code={diagnostic.code}>
        <p>{t(`st.im.inboundFailure.${diagnostic.code}`)}</p>
        <p className="break-all font-mono text-[11px] text-ink-soft">{diagnostic.source_id} · <time dateTime={diagnostic.at}>{new Date(diagnostic.at).toLocaleString()}</time></p>
      </li>)}
    </ul>
  </details>;
}

function ConnectionFailure({ detail }: { detail: ImConnectionDetail }) {
  const { t } = useI18n();
  const values = [detail.http_status === undefined ? undefined : `HTTP ${detail.http_status}`, detail.ret === undefined ? undefined : `ret ${detail.ret}`, detail.errcode === undefined ? undefined : `errcode ${detail.errcode}`].filter(Boolean);
  if (values.length === 0 && detail.failure_count === undefined && detail.retry_in_ms === undefined) return <p data-im-connection-detail className="text-amber-ink">{t(`st.im.failure.${detail.code}`)}</p>;
  return <details data-im-connection-detail className="text-amber-ink">
    <summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-selected-ink">{t(`st.im.failure.${detail.code}`)}</summary>
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 pl-4 font-mono text-[12px] text-ink-soft">
      {values.length > 0 ? <span>{values.join(' · ')}</span> : null}
      {detail.failure_count !== undefined ? <span>{t('st.im.failureCount', { count: detail.failure_count })}</span> : null}
      {detail.retry_in_ms !== undefined ? <span>{t('st.im.retryDelay', { seconds: Math.ceil(detail.retry_in_ms / 1000) })}</span> : null}
    </div>
  </details>;
}
