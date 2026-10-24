import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  imSessionAdmitted,
  type ImBinding,
  type ImBindingPatch,
  type ImBindingTestResult,
  type ImCatalog,
  type ImChannelCapability,
  type ImConfirmRequest,
  type ImConnectionDetail,
  type ImDiscovery,
  type ImIdentity,
  type ImPasteResult,
  type ImProviderKind,
  type ImSessionSnapshot,
  type ImSetupCatalog,
  type ImSetupProvider,
  type ImSetupRequest,
} from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Hint, Toggle, type Feedback } from '../../controls';
import { DisclosureChevron, Icon } from '../../icons';
import { SidePanel } from '../../SidePanel';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { AdvancedDetails, SettingField } from '../fields';
import { SectionCard } from '../SectionCard';
import { FORM_LABEL, SettingsSegmented, SettingsSelect } from '../SettingsPrimitives';
import { wechatQrImage } from './wechatQr';

const KEY = ['im-sessions'] as const;
type ImInstanceStatus = ImSessionSnapshot['instances'][number];
type Translator = ReturnType<typeof useI18n>['t'];
type SetupPlatformEntry = ImSetupCatalog['platforms'][number];
type ConnectMode = 'wechat' | 'paste' | ImSetupProvider;

const SETUP_FIELD_KEYS: Readonly<Record<string, I18nKey>> = {
  bot_token: 'st.im.setup.field.bot_token',
  app_token: 'st.im.setup.field.app_token',
  homeserver: 'st.im.setup.field.homeserver',
  access_token: 'st.im.setup.field.access_token',
};

const MEDIA_KIND_KEYS: Readonly<Record<string, I18nKey>> = {
  image: 'message.media.image',
  file: 'message.media.file',
  audio: 'message.media.audio',
  voice: 'message.media.voice',
  video: 'message.media.video',
};

function useImAction() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (work: () => Promise<ImSessionSnapshot | void>): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    try {
      const next = await work();
      if (next !== undefined) queryClient.setQueryData(KEY, next);
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '';
      setError(message.includes('unsupported_wechat_group') ? t('st.im.wechatDirectOnly') : message || t('st.im.error'));
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, run };
}

function isSetupProvider(kind: string | undefined): kind is ImSetupProvider {
  return kind === 'discord' || kind === 'slack' || kind === 'matrix';
}

export function ImSessionCard() {
  const { t } = useI18n();
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();
  const action = useImAction();
  const configQuery = useQuery({
    queryKey: ['config', scopeId],
    queryFn: () => client.getConfig(),
    staleTime: 30_000,
  });
  const snapshot = useQuery({
    queryKey: KEY,
    queryFn: () => client.imSessions.snapshot(),
    placeholderData: (previous) => previous,
    refetchInterval: (query) => query.state.data?.instances.some((item) => item.listening) === true ? 2_000 : false,
  });
  const catalog = useQuery({
    queryKey: [...KEY, 'catalog'],
    queryFn: () => client.imSessions.catalog(),
    enabled: snapshot.data !== undefined,
  });
  const setupCatalog = useQuery({
    queryKey: [...KEY, 'setup-catalog'],
    queryFn: () => client.imSessions.setupCatalog(),
    enabled: snapshot.data !== undefined && typeof client.imSessions.setupCatalog === 'function',
    staleTime: 60_000,
  });
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectMode, setConnectMode] = useState<ConnectMode>('paste');
  const [text, setText] = useState('');
  const [connectInstanceId, setConnectInstanceId] = useState('');
  const [pasteNote, setPasteNote] = useState<ImPasteResult>();
  const [savedSetupInstanceId, setSavedSetupInstanceId] = useState<string>();
  const [preselectedTargets, setPreselectedTargets] = useState<Record<string, string>>({});

  // Lifted WeChat QR state so background polling survives closing the SidePanel unless explicitly cancelled
  const [wechatLoginId, setWechatLoginId] = useState<string>();
  const [wechatImage, setWechatImage] = useState<string>();
  const [wechatStatus, setWechatStatus] = useState<string>();
  const [wechatVerifyCode, setWechatVerifyCode] = useState('');
  const [wechatError, setWechatError] = useState<string>();
  const wechatPolling = wechatLoginId !== undefined && (wechatStatus === undefined || wechatStatus === 'wait' || wechatStatus === 'scaned' || wechatStatus === 'scaned_but_redirect');

  const handleWechatConfirmed = (id?: string) => {
    setConnectOpen(false);
    void action.run(async () => {
      const fresh = await client.imSessions.snapshot();
      queryClient.setQueryData(KEY, fresh);
      const wechat = fresh.instances.find((item) => item.id === id && item.provider_kind === 'wechat_bridge');
      if (wechat === undefined) return fresh;
      if (wechat.listening && wechat.connection !== 'auth_expired' && wechat.connection !== 'stopped' && wechat.adapter !== 'stopped') return fresh;
      const checked = await client.imSessions.check(wechat.id);
      if (!checked.ok) throw new Error(checked.detail ?? t('st.im.error'));
      return client.imSessions.listen(wechat.id, true);
    });
  };

  useEffect(() => {
    if (!wechatPolling || wechatLoginId === undefined) return;
    let stop = false;
    const tick = () => {
      void client.imSessions.pollWechatQr(wechatLoginId).then((result) => {
        if (stop) return;
        setWechatStatus(result.status);
        if (result.status === 'confirmed') {
          void queryClient.invalidateQueries({ queryKey: KEY });
          handleWechatConfirmed(result.provider_instance_id);
        }
      }).catch((caught: unknown) => {
        if (stop) return;
        const message = caught instanceof Error ? caught.message : '';
        if (message === 'wechat_login_cancelled' || message === 'unknown_login') return;
        setWechatError(message.length > 0 ? message : t('st.im.error'));
      });
    };
    const timer = setInterval(tick, 1500);
    return () => { stop = true; clearInterval(timer); };
  }, [client, wechatLoginId, wechatPolling, queryClient, t]);

  const startWechatScan = () => {
    setWechatError(undefined);
    setWechatVerifyCode('');
    setConnectMode('wechat');
    setConnectOpen(true);
    void client.imSessions.startWechatQr().then((started) => {
      setWechatLoginId(started.login_id);
      setWechatImage(started.image);
      setWechatStatus('wait');
    }).catch((caught: unknown) => {
      setWechatError(caught instanceof Error ? caught.message : t('st.im.error'));
    });
  };

  const cancelWechatScan = () => {
    const id = wechatLoginId;
    setWechatLoginId(undefined);
    setWechatImage(undefined);
    setWechatStatus('cancelled');
    if (id !== undefined) void client.imSessions.cancelWechatQr(id);
  };

  const data = snapshot.data;
  const selectedConnectInstance = data?.instances.some((item) => item.id === connectInstanceId) === true ? connectInstanceId : '';
  const checkOnlyInstanceId = selectedConnectInstance || (data?.instances.length === 1 ? data.instances[0]!.id : '');
  const showConnectForm = connectOpen || data?.instances.length === 0;
  const requestedTarget = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('target') ?? '';
  const initialTarget = /^(persona|session):.+/u.test(requestedTarget) ? requestedTarget : '';
  const accounts = useMemo(() => {
    if (data === undefined) return [];
    const result = [...data.instances];
    for (const item of [...data.bindings, ...data.discoveries]) {
      if (!result.some((account) => account.id === item.provider_instance_id)) {
        result.push({ id: item.provider_instance_id, provider_kind: item.provider_kind, account_id: item.account_id, configured: false, listening: false, adapter: 'missing' });
      }
    }
    return result;
  }, [data]);

  const setupPlatforms = setupCatalog.data?.platforms ?? [];
  const activeSetupPlatform = setupPlatforms.find((item) => item.provider_kind === connectMode);
  const matchingInstances = useMemo(() => {
    if (data === undefined) return [];
    if (connectMode === 'paste') return data.instances;
    if (connectMode === 'wechat') return data.instances.filter((item) => item.provider_kind === 'wechat_bridge');
    return data.instances.filter((item) => item.provider_kind === connectMode);
  }, [connectMode, data]);
  const activeSetupInstanceId = matchingInstances.some((item) => item.id === selectedConnectInstance)
    ? selectedConnectInstance
    : undefined;
  const effectiveSavedSetupInstanceId = savedSetupInstanceId !== undefined && savedSetupInstanceId === activeSetupInstanceId
    ? savedSetupInstanceId
    : undefined;

  const connectFormContent = data === undefined ? null : (
    <div className="space-y-4" data-im-connect-drawer>
      <p className="text-[13px] leading-5 text-ink-soft">{t('st.im.hint')}</p>

      <WechatScan
        loginId={wechatLoginId}
        image={wechatImage}
        status={wechatStatus}
        verifyCode={wechatVerifyCode}
        error={wechatError}
        onStart={startWechatScan}
        onCancel={cancelWechatScan}
        onVerifyCodeChange={setWechatVerifyCode}
        onVerifySubmit={() => {
          if (wechatLoginId === undefined) return;
          void client.imSessions.pollWechatQr(wechatLoginId, wechatVerifyCode.trim()).then((result) => {
            setWechatStatus(result.status);
            if (result.status === 'confirmed') {
              void queryClient.invalidateQueries({ queryKey: KEY });
              handleWechatConfirmed(result.provider_instance_id);
            }
          }).catch((caught: unknown) => {
            setWechatError(caught instanceof Error ? caught.message : t('st.im.error'));
          });
        }}
      />

      {setupCatalog.isError ? (
        <div className="flex flex-wrap items-center gap-2" data-im-setup-catalog-error>
          <FeedbackLine feedback={{ tone: 'error', text: t('st.im.setup.catalogError') }} />
          <button type="button" className={SECONDARY_BUTTON} data-im-setup-catalog-retry onClick={() => { void setupCatalog.refetch(); }}>
            {t('st.im.retry')}
          </button>
        </div>
      ) : null}

      {setupPlatforms.length > 0 ? (
        <div className="space-y-2" data-im-setup-platforms>
          <span className={FORM_LABEL}>{t('st.im.setup.platform')}</span>
          <SettingsSegmented
            ariaLabel={t('st.im.setup.platform')}
            value={connectMode}
            onChange={(mode) => {
              setConnectMode(mode);
              setSavedSetupInstanceId(undefined);
              if (mode !== 'paste' && mode !== 'wechat' && selectedConnectInstance !== '') {
                const inst = data.instances.find((item) => item.id === selectedConnectInstance);
                if (inst?.provider_kind !== mode) setConnectInstanceId('');
              }
            }}
            dataAttr="data-im-setup-mode"
            choices={[
              { value: 'wechat', label: t('st.im.provider.wechat_bridge') },
              ...setupPlatforms.map((item) => ({
                value: item.provider_kind,
                label: providerDisplayName(item.provider_kind, t),
              })),
              { value: 'paste', label: t('st.im.setup.pasteMode') },
            ]}
          />
        </div>
      ) : null}

      {matchingInstances.length > 0 ? <SettingField label={t('st.im.instance')} htmlFor="im-instance">
        <SettingsSelect id="im-instance" variant="form" ariaLabel={t('st.im.instance')} value={activeSetupInstanceId ?? ''} emptyText={t('st.im.newAccount')}
          choices={[{ value: '', label: t('st.im.newAccount') }, ...matchingInstances.map((item) => ({ value: item.id, label: `${instanceDisplayName(item, t)} · ${item.account_id ?? item.id}` }))]}
          onChange={(nextId) => {
            setConnectInstanceId(nextId);
            setSavedSetupInstanceId(undefined);
          }} dataAttr="data-im-instance" />
      </SettingField> : null}

      {connectMode === 'wechat' ? null : activeSetupPlatform === undefined ? (
        <div className="space-y-3" data-im-paste-panel>
          <label className="block space-y-1 text-[13px] text-ink-soft">
            <span>{t('st.im.paste')}</span>
            <textarea data-im-paste value={text} rows={2} placeholder={t('st.im.pastePlaceholder')} className={INPUT} onChange={(event) => { setText(event.target.value); }} />
          </label>
          <button type="button" className={SECONDARY_BUTTON} data-im-check disabled={action.saving || (text.trim() === '' && checkOnlyInstanceId === '')}
            onClick={() => { void action.run(async () => {
              let id = checkOnlyInstanceId;
              if (text.trim() !== '') {
                const result = await client.imSessions.paste(text, selectedConnectInstance === '' ? undefined : selectedConnectInstance);
                setPasteNote(result);
                setText('');
                id = result.provider_instance_id;
                setConnectInstanceId(id);
                queryClient.setQueryData(KEY, await client.imSessions.snapshot());
              }
              const checked = await client.imSessions.check(id);
              if (!checked.ok) throw new Error(checked.detail ?? t('st.im.error'));
              const next = await client.imSessions.listen(id, true);
              setConnectOpen(false);
              return next;
            }); }}>{t('st.im.check')}</button>
          {pasteNote !== undefined && pasteNote.ignored_keys.length > 0 ? <p className="text-[13px] text-ink-soft" data-im-ignored>{t('st.im.ignored')}: {pasteNote.ignored_keys.join(', ')}</p> : null}
          {pasteNote?.chat_hint_ignored === true ? <p className="text-[13px] text-ink-soft" data-im-chat-hint>{t('st.im.chatHint')}</p> : null}
        </div>
      ) : (
        <PlatformSetupForm
          key={activeSetupPlatform.provider_kind}
          platform={activeSetupPlatform}
          instanceId={activeSetupInstanceId}
          savedInstanceId={effectiveSavedSetupInstanceId}
          onSaved={async (result) => {
            setPasteNote(result);
            setConnectInstanceId(result.provider_instance_id);
            setSavedSetupInstanceId(result.provider_instance_id);
            queryClient.setQueryData(KEY, await client.imSessions.snapshot());
          }}
          onCheckAndListen={(id) => {
            void action.run(async () => {
              const checked = await client.imSessions.check(id);
              if (!checked.ok) throw new Error(checked.detail ?? t('st.im.error'));
              const next = await client.imSessions.listen(id, true);
              setConnectOpen(false);
              return next;
            });
          }}
          busy={action.saving}
        />
      )}
    </div>
  );

  return (
    <SectionCard
      id="st-card-im-session"
      title={t('st.im.title')}
      actions={accounts.length > 0 ? (
        <button
          type="button"
          className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
          data-im-connect-toggle
          aria-expanded={showConnectForm}
          onClick={() => { setConnectOpen((open) => !open); }}
        >
          <Icon name="plus" size={12} />
          {t(showConnectForm ? 'st.im.connectHide' : 'st.im.connectNew')}
        </button>
      ) : undefined}
    >
      <div className="min-w-0 space-y-5 [&_button]:min-h-9 [&_button]:text-[13px] max-md:[&_button]:min-h-11" data-im-session>
        {snapshot.isError ? <div className="flex flex-wrap items-center gap-2">
          <FeedbackLine feedback={{ tone: 'error', text: t('st.im.loadError') }} />
          <button type="button" className={SECONDARY_BUTTON} data-im-retry onClick={() => { void snapshot.refetch(); }}>{t('st.im.retry')}</button>
        </div> : null}
        {data === undefined ? <p data-im-loading aria-busy="true" className="py-4 text-[13px] text-ink-soft">{t('st.im.loading')}</p> : <>
          <div className="space-y-1">
            <SettingField label={t('st.im.allowed')} htmlFor="im-allowed">
              <Toggle id="im-allowed" layout="bare" label={t('st.im.allowed')} checked={data.policy.allowed} disabled={action.saving}
                onChange={(allowed) => { void action.run(() => client.imSessions.setPolicy({ ...data.policy, allowed })); }} />
            </SettingField>
            <SettingField label={t('st.im.default')} htmlFor="im-default">
              <Toggle id="im-default" layout="bare" label={t('st.im.default')} checked={data.policy.default_enabled} disabled={action.saving}
                onChange={(default_enabled) => { void action.run(() => client.imSessions.setPolicy({ ...data.policy, default_enabled })); }} />
            </SettingField>
            <SettingField label={t('st.im.allowBorrowing' as any)} htmlFor="im-allow-borrowing">
              <Toggle
                id="im-allow-borrowing"
                layout="bare"
                label={t('st.im.allowBorrowing' as any)}
                checked={data.policy.allow_channel_borrowing ?? false}
                disabled={action.saving}
                onChange={(allow_channel_borrowing) => {
                  void action.run(() => client.imSessions.setPolicy({
                    ...data.policy,
                    allow_channel_borrowing,
                  }));
                }}
              />
            </SettingField>
            <SettingField label={t('st.im.defaultSendMessage' as any)} htmlFor="im-default-send-message">
              <Toggle
                id="im-default-send-message"
                layout="bare"
                label={t('st.im.defaultSendMessage' as any)}
                checked={configQuery.data?.optional_capabilities?.send_message?.default_on ?? false}
                disabled={action.saving || configQuery.isLoading}
                onChange={(enabled) => {
                  void action.run(async () => {
                    const res = await client.patchConfig({
                      optional_capabilities: {
                        defaults: { send_message: enabled },
                      },
                    } as any);
                    queryClient.setQueryData(['config', scopeId], res);
                    await queryClient.invalidateQueries({ queryKey: ['config'] });
                  });
                }}
              />
            </SettingField>
          </div>
          <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
          {catalog.isError ? <div className="flex flex-wrap items-center gap-2" data-im-catalog-error>
            <FeedbackLine feedback={{ tone: 'error', text: t('st.im.catalogError') }} />
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { void catalog.refetch(); }}>{t('st.im.retry')}</button>
          </div> : null}

          {accounts.length === 0 ? (
            <div className="space-y-4 border-y border-hairline py-4">
              <p data-im-empty className="text-[13px] text-ink-soft">{t('st.im.empty')}</p>
              {connectFormContent}
            </div>
          ) : connectOpen ? (
            <SidePanel
              title={t('st.im.connectNew')}
              overlayId="settings-im-connect"
              onClose={() => { setConnectOpen(false); }}
            >
              {connectFormContent}
            </SidePanel>
          ) : null}

          <div className="space-y-6" data-im-accounts>
            {accounts.map((account) => (
              <AccountChannels
                key={account.id}
                account={account}
                data={data}
                catalog={catalog.data}
                setupPlatform={setupPlatforms.find((item) => item.provider_kind === account.provider_kind)}
                initialTarget={initialTarget}
                preselectedTarget={preselectedTargets[account.id]}
                onPreselectTarget={(targetVal) => {
                  setPreselectedTargets((prev) => ({ ...prev, [account.id]: targetVal }));
                }}
                refresh={() => { void snapshot.refetch(); }}
                reauthorize={() => {
                  setConnectInstanceId(account.id);
                  setSavedSetupInstanceId(undefined);
                  if (account.provider_kind === 'wechat_bridge') {
                    setConnectMode('wechat');
                  } else if (isSetupProvider(account.provider_kind) && setupPlatforms.some((item) => item.provider_kind === account.provider_kind)) {
                    setConnectMode(account.provider_kind);
                  } else {
                    setConnectMode('paste');
                  }
                  setConnectOpen(true);
                }}
              />
            ))}
          </div>
          {data.strangers.length > 0 || data.voice_fallbacks > 0 ? (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-faint">
              {data.strangers.length > 0 ? <span data-im-strangers>{t('st.im.strangers')}: {data.strangers.reduce((sum, item) => sum + item.count, 0)}</span> : null}
              {data.strangers.length > 0 && data.voice_fallbacks > 0 ? <span aria-hidden>·</span> : null}
              {data.voice_fallbacks > 0 ? <span data-im-voice>{t('st.im.voice')}: {data.voice_fallbacks}</span> : null}
            </p>
          ) : null}
        </>}
      </div>
    </SectionCard>
  );
}

function PlatformSetupForm({ platform, instanceId, savedInstanceId, onSaved, onCheckAndListen, busy }: {
  platform: SetupPlatformEntry;
  instanceId?: string;
  savedInstanceId?: string;
  onSaved: (result: ImPasteResult) => Promise<void>;
  onCheckAndListen: (instanceId: string) => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [generatedLink, setGeneratedLink] = useState<string>();

  // Discord helper state
  const [discordAppId, setDiscordAppId] = useState('');
  const [discordGuildId, setDiscordGuildId] = useState('');

  // Slack helper state
  const [slackAppName, setSlackAppName] = useState('');
  const [slackClientId, setSlackClientId] = useState('');
  const [slackClientSecret, setSlackClientSecret] = useState('');
  const [slackRedirectUri, setSlackRedirectUri] = useState('http://127.0.0.1/slack-callback');
  const [slackAttemptId, setSlackAttemptId] = useState<string>();
  const [slackCode, setSlackCode] = useState('');
  const [slackState, setSlackState] = useState('');

  // Matrix helper state
  const [matrixMethod, setMatrixMethod] = useState<'token' | 'password' | 'sso'>('token');
  const [matrixServerInput, setMatrixServerInput] = useState('');
  const [matrixDiscovery, setMatrixDiscovery] = useState<{ homeserver: string; login_types: string[]; sso: boolean }>();
  const [matrixUser, setMatrixUser] = useState('');
  const [matrixPassword, setMatrixPassword] = useState('');
  const [matrixRedirectUri, setMatrixRedirectUri] = useState('http://127.0.0.1/matrix-callback');
  const [matrixIdpId, setMatrixIdpId] = useState('');
  const [matrixAttemptId, setMatrixAttemptId] = useState<string>();
  const [matrixCallbackUri, setMatrixCallbackUri] = useState('');
  const [matrixLoginToken, setMatrixLoginToken] = useState('');

  useEffect(() => {
    setFields((prev) => {
      if (platform.provider_kind === 'matrix' && matrixDiscovery?.homeserver !== undefined) {
        return { homeserver: matrixDiscovery.homeserver };
      }
      if (Object.keys(prev).length === 0) return prev;
      return {};
    });
    setError(undefined);
    setGeneratedLink(undefined);
    setSlackClientSecret('');
    setSlackAttemptId(undefined);
    setSlackCode('');
    setSlackState('');
    setMatrixPassword('');
    setMatrixAttemptId(undefined);
    setMatrixCallbackUri('');
    setMatrixLoginToken('');
  }, [instanceId, matrixDiscovery?.homeserver, platform.provider_kind]);

  const runSetup = async (request: ImSetupRequest) => {
    setSubmitting(true);
    setError(undefined);
    try {
      const res = await client.imSessions.setup(request);
      if (res.kind === 'saved') {
        setFields((prev) => {
          const next: Record<string, string> = {};
          for (const field of platform.fields) {
            if (!field.secret && prev[field.key] !== undefined) {
              next[field.key] = prev[field.key]!;
            }
          }
          return next;
        });
        setSlackClientSecret('');
        setSlackAttemptId(undefined);
        setSlackCode('');
        setSlackState('');
        setMatrixPassword('');
        setMatrixAttemptId(undefined);
        setMatrixCallbackUri('');
        setMatrixLoginToken('');
        await onSaved(res.result);
      } else if (res.kind === 'link') {
        setGeneratedLink(res.url);
        if (request.action === 'slack_oauth_begin') {
          setSlackAttemptId(res.attempt_id);
        } else if (request.action === 'matrix_sso_begin') {
          setMatrixAttemptId(res.attempt_id);
          if (res.callback_uri !== undefined) setMatrixCallbackUri(res.callback_uri);
        }
      } else if (res.kind === 'discovery') {
        setMatrixDiscovery({ homeserver: res.homeserver, login_types: res.login_types, sso: res.sso });
        setFields((prev) => ({ ...prev, homeserver: res.homeserver }));
      }
    } catch (caught) {
      setError(caught instanceof Error && caught.message.length > 0 ? caught.message : t('st.im.error'));
    } finally {
      setSubmitting(false);
    }
  };

  const canSaveDirect = platform.fields.every((field) => !field.required || (fields[field.key]?.trim() ?? '').length > 0);
  const checkTargetId = savedInstanceId ?? instanceId;

  return (
    <div className="space-y-3" data-im-platform-setup={platform.provider_kind}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-soft">
        <CapabilitySummary capabilities={platform.capabilities} providerKind={platform.provider_kind} />
        <a
          href={platform.portal_url}
          target="_blank"
          rel="noreferrer"
          data-im-setup-portal={platform.provider_kind}
          className="underline-offset-2 hover:text-ink hover:underline"
        >
          {t('st.im.setup.portalLink')}
        </a>
      </div>

      {platform.provider_kind === 'discord' && platform.methods.includes('oauth_install') ? (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" data-im-discord-install>
          <label className="block space-y-1">
            <span className={FORM_LABEL}>{t('st.im.setup.discord.appId')}</span>
            <input
              data-im-discord-app-id
              value={discordAppId}
              placeholder="123456789012345678"
              className={`${INPUT} font-mono`}
              onChange={(event) => { setDiscordAppId(event.target.value); }}
            />
          </label>
          <label className="block space-y-1">
            <span className={FORM_LABEL}>{t('st.im.setup.discord.guildId')}</span>
            <input
              data-im-discord-guild-id
              value={discordGuildId}
              className={`${INPUT} font-mono`}
              onChange={(event) => { setDiscordGuildId(event.target.value); }}
            />
          </label>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            data-im-discord-install-btn
            disabled={submitting || !/^\d{1,22}$/u.test(discordAppId.trim())}
            onClick={() => {
              const guild = discordGuildId.trim();
              void runSetup({
                action: 'discord_install',
                application_id: discordAppId.trim(),
                ...(guild === '' ? {} : { guild_id: guild }),
              });
            }}
          >
            {t('st.im.setup.discord.installLink')}
          </button>
        </div>
      ) : null}

      {platform.provider_kind === 'slack' ? (
        <div className="space-y-3" data-im-slack-helpers>
          {platform.methods.includes('manifest') ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-[12rem] flex-1 space-y-1">
                <span className={FORM_LABEL}>{t('st.im.setup.slack.appName')}</span>
                <input
                  data-im-slack-app-name
                  value={slackAppName}
                  placeholder="Kiki"
                  className={INPUT}
                  onChange={(event) => { setSlackAppName(event.target.value); }}
                />
              </label>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                data-im-slack-manifest-btn
                disabled={submitting}
                onClick={() => {
                  const name = slackAppName.trim();
                  void runSetup({ action: 'slack_manifest', ...(name === '' ? {} : { name }) });
                }}
              >
                {t('st.im.setup.slack.manifestLink')}
              </button>
            </div>
          ) : null}

          {platform.methods.includes('oauth_install') ? (
            <AdvancedDetails summary={t('st.im.setup.slack.oauthToggle')} data-im-slack-oauth>
              <div className="space-y-3 pt-1">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span className={FORM_LABEL}>{t('st.im.setup.slack.clientId')}</span>
                    <input
                      data-im-slack-client-id
                      value={slackClientId}
                      className={`${INPUT} font-mono`}
                      onChange={(event) => { setSlackClientId(event.target.value); }}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className={FORM_LABEL}>{t('st.im.setup.slack.redirectUri')}</span>
                    <input
                      data-im-slack-redirect-uri
                      value={slackRedirectUri}
                      className={`${INPUT} font-mono`}
                      onChange={(event) => { setSlackRedirectUri(event.target.value); }}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  data-im-slack-oauth-begin
                  disabled={submitting || slackClientId.trim() === '' || slackRedirectUri.trim() === ''}
                  onClick={() => {
                    void runSetup({
                      action: 'slack_oauth_begin',
                      client_id: slackClientId.trim(),
                      redirect_uri: slackRedirectUri.trim(),
                      ...(instanceId === undefined ? {} : { instance_id: instanceId }),
                    });
                  }}
                >
                  {t('st.im.setup.slack.oauthBegin')}
                </button>
                {slackAttemptId !== undefined ? (
                  <div className="space-y-2 border-t border-hairline pt-2" data-im-slack-oauth-complete-form>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="block space-y-1">
                        <span className={FORM_LABEL}>{t('st.im.setup.slack.clientSecret')}</span>
                        <input
                          type="password"
                          data-im-slack-client-secret
                          value={slackClientSecret}
                          className={`${INPUT} font-mono`}
                          onChange={(event) => { setSlackClientSecret(event.target.value); }}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className={FORM_LABEL}>{t('st.im.setup.field.app_token')}</span>
                        <input
                          type="password"
                          data-im-slack-oauth-app-token
                          value={fields['app_token'] ?? ''}
                          className={`${INPUT} font-mono`}
                          onChange={(event) => { setFields((prev) => ({ ...prev, app_token: event.target.value })); }}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className={FORM_LABEL}>{t('st.im.setup.slack.code')}</span>
                        <input
                          data-im-slack-oauth-code
                          value={slackCode}
                          className={`${INPUT} font-mono`}
                          onChange={(event) => { setSlackCode(event.target.value); }}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className={FORM_LABEL}>{t('st.im.setup.slack.state')}</span>
                        <input
                          data-im-slack-oauth-state
                          value={slackState}
                          className={`${INPUT} font-mono`}
                          onChange={(event) => { setSlackState(event.target.value); }}
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      className={PRIMARY_BUTTON}
                      data-im-slack-oauth-complete
                      disabled={submitting || slackClientSecret.trim() === '' || (fields['app_token']?.trim() ?? '') === '' || slackCode.trim() === '' || slackState.trim() === ''}
                      onClick={() => {
                        void runSetup({
                          action: 'slack_oauth_complete',
                          attempt_id: slackAttemptId,
                          state: slackState.trim(),
                          code: slackCode.trim(),
                          client_secret: slackClientSecret.trim(),
                          app_token: fields['app_token']!.trim(),
                        });
                      }}
                    >
                      {t('st.im.setup.slack.oauthComplete')}
                    </button>
                  </div>
                ) : null}
              </div>
            </AdvancedDetails>
          ) : null}
        </div>
      ) : null}

      {platform.provider_kind === 'matrix' ? (
        <div className="space-y-3" data-im-matrix-helpers>
          {platform.methods.includes('discovery') ? (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[14rem] flex-1 space-y-1">
                  <span className={FORM_LABEL}>{t('st.im.setup.matrix.server')}</span>
                  <input
                    data-im-matrix-server
                    value={matrixServerInput}
                    placeholder="@bot:example.org / matrix.org"
                    className={`${INPUT} font-mono`}
                    onChange={(event) => { setMatrixServerInput(event.target.value); }}
                  />
                </label>
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  data-im-matrix-discover-btn
                  disabled={submitting || matrixServerInput.trim() === ''}
                  onClick={() => {
                    void runSetup({ action: 'matrix_discover', server: matrixServerInput.trim() });
                  }}
                >
                  {t('st.im.setup.matrix.discover')}
                </button>
              </div>
              {matrixDiscovery !== undefined ? (
                <p className="font-mono text-[12px] text-ink-soft" data-im-matrix-discovery-result>
                  {t('st.im.setup.matrix.discovered', {
                    homeserver: matrixDiscovery.homeserver,
                    flows: matrixDiscovery.login_types.join(', '),
                  })}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <span className={FORM_LABEL}>{t('st.im.setup.matrix.authMethod')}</span>
            <SettingsSegmented
              ariaLabel={t('st.im.setup.matrix.authMethod')}
              value={matrixMethod}
              onChange={setMatrixMethod}
              dataAttr="data-im-matrix-method"
              choices={[
                { value: 'token', label: t('st.im.setup.matrix.methodToken') },
                ...(platform.methods.includes('password') ? [{ value: 'password' as const, label: t('st.im.setup.matrix.methodPassword') }] : []),
                ...(platform.methods.includes('sso') ? [{ value: 'sso' as const, label: t('st.im.setup.matrix.methodSso') }] : []),
              ]}
            />
          </div>

          {matrixMethod === 'password' ? (
            <div className="space-y-2" data-im-matrix-password-form>
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="block space-y-1">
                  <span className={FORM_LABEL}>{t('st.im.setup.field.homeserver')}</span>
                  <input
                    data-im-matrix-field="homeserver"
                    value={fields['homeserver'] ?? ''}
                    placeholder="https://matrix.example.org"
                    className={`${INPUT} font-mono`}
                    onChange={(event) => { setFields((prev) => ({ ...prev, homeserver: event.target.value })); }}
                  />
                </label>
                <label className="block space-y-1">
                  <span className={FORM_LABEL}>{t('st.im.setup.matrix.user')}</span>
                  <input
                    data-im-matrix-user
                    value={matrixUser}
                    className={`${INPUT} font-mono`}
                    onChange={(event) => { setMatrixUser(event.target.value); }}
                  />
                </label>
                <label className="block space-y-1">
                  <span className={FORM_LABEL}>{t('st.im.setup.matrix.password')}</span>
                  <input
                    type="password"
                    data-im-matrix-password
                    value={matrixPassword}
                    className={INPUT}
                    onChange={(event) => { setMatrixPassword(event.target.value); }}
                  />
                </label>
              </div>
              <button
                type="button"
                className={PRIMARY_BUTTON}
                data-im-matrix-password-submit
                disabled={submitting || (fields['homeserver']?.trim() ?? '') === '' || matrixUser.trim() === '' || matrixPassword === ''}
                onClick={() => {
                  void runSetup({
                    action: 'matrix_password',
                    homeserver: fields['homeserver']!.trim(),
                    user: matrixUser.trim(),
                    password: matrixPassword,
                    ...(instanceId === undefined ? {} : { instance_id: instanceId }),
                  });
                }}
              >
                {t('st.im.setup.matrix.passwordSubmit')}
              </button>
            </div>
          ) : null}

          {matrixMethod === 'sso' ? (
            <div className="space-y-2" data-im-matrix-sso-form>
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="block space-y-1">
                  <span className={FORM_LABEL}>{t('st.im.setup.field.homeserver')}</span>
                  <input
                    data-im-matrix-field="homeserver"
                    value={fields['homeserver'] ?? ''}
                    placeholder="https://matrix.example.org"
                    className={`${INPUT} font-mono`}
                    onChange={(event) => { setFields((prev) => ({ ...prev, homeserver: event.target.value })); }}
                  />
                </label>
                <label className="block space-y-1">
                  <span className={FORM_LABEL}>{t('st.im.setup.matrix.redirectUri')}</span>
                  <input
                    data-im-matrix-redirect-uri
                    value={matrixRedirectUri}
                    className={`${INPUT} font-mono`}
                    onChange={(event) => { setMatrixRedirectUri(event.target.value); }}
                  />
                </label>
                <label className="block space-y-1">
                  <span className={FORM_LABEL}>{t('st.im.setup.matrix.idpId')}</span>
                  <input
                    data-im-matrix-idp-id
                    value={matrixIdpId}
                    className={`${INPUT} font-mono`}
                    onChange={(event) => { setMatrixIdpId(event.target.value); }}
                  />
                </label>
              </div>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                data-im-matrix-sso-begin
                disabled={submitting || (fields['homeserver']?.trim() ?? '') === '' || matrixRedirectUri.trim() === ''}
                onClick={() => {
                  const idp = matrixIdpId.trim();
                  void runSetup({
                    action: 'matrix_sso_begin',
                    homeserver: fields['homeserver']!.trim(),
                    redirect_uri: matrixRedirectUri.trim(),
                    ...(idp === '' ? {} : { idp_id: idp }),
                    ...(instanceId === undefined ? {} : { instance_id: instanceId }),
                  });
                }}
              >
                {t('st.im.setup.matrix.ssoBegin')}
              </button>
              {matrixAttemptId !== undefined ? (
                <div className="space-y-2 border-t border-hairline pt-2" data-im-matrix-sso-complete-form>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="block space-y-1">
                      <span className={FORM_LABEL}>{t('st.im.setup.matrix.callbackUri')}</span>
                      <input
                        data-im-matrix-callback-uri
                        value={matrixCallbackUri}
                        className={`${INPUT} font-mono`}
                        onChange={(event) => { setMatrixCallbackUri(event.target.value); }}
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className={FORM_LABEL}>{t('st.im.setup.matrix.loginToken')}</span>
                      <input
                        type="password"
                        data-im-matrix-login-token
                        value={matrixLoginToken}
                        className={`${INPUT} font-mono`}
                        onChange={(event) => { setMatrixLoginToken(event.target.value); }}
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    className={PRIMARY_BUTTON}
                    data-im-matrix-sso-complete
                    disabled={submitting || matrixCallbackUri.trim() === '' || matrixLoginToken.trim() === ''}
                    onClick={() => {
                      void runSetup({
                        action: 'matrix_sso_complete',
                        attempt_id: matrixAttemptId,
                        callback_uri: matrixCallbackUri.trim(),
                        login_token: matrixLoginToken.trim(),
                      });
                    }}
                  >
                    {t('st.im.setup.matrix.ssoComplete')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {generatedLink !== undefined ? (
        <div className="flex flex-wrap items-center gap-2" data-im-setup-link>
          <input readOnly value={generatedLink} aria-label={t('st.im.setup.generatedLink')} className={`${INPUT} min-w-0 flex-1 font-mono`} data-im-setup-link-input />
          <a href={generatedLink} target="_blank" rel="noreferrer" className={SECONDARY_BUTTON} data-im-setup-link-open>
            {t('st.im.setup.openLink')}
          </a>
        </div>
      ) : null}

      {platform.provider_kind !== 'matrix' || matrixMethod === 'token' ? (
        <div className="space-y-3" data-im-setup-token-fields>
          <div className={`grid gap-2 ${platform.fields.length > 1 ? 'sm:grid-cols-2' : ''}`}>
            {platform.fields.map((field) => {
              const labelKey = SETUP_FIELD_KEYS[field.key];
              return (
                <label key={field.key} className="block space-y-1">
                  <span className={FORM_LABEL}>{labelKey === undefined ? field.label : t(labelKey)}</span>
                  <input
                    type={field.secret ? 'password' : 'text'}
                    data-im-setup-field={field.key}
                    value={fields[field.key] ?? ''}
                    spellCheck={false}
                    autoComplete="off"
                    className={`${INPUT} font-mono`}
                    onChange={(event) => {
                      const val = event.target.value;
                      setFields((prev) => ({ ...prev, [field.key]: val }));
                    }}
                  />
                </label>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={PRIMARY_BUTTON}
              data-im-setup-save
              disabled={submitting || busy || !canSaveDirect}
              onClick={() => {
                const payload: Record<string, string> = {};
                for (const field of platform.fields) {
                  const val = fields[field.key]?.trim() ?? '';
                  if (val !== '') payload[field.key] = val;
                }
                void runSetup({
                  action: 'save',
                  provider_kind: platform.provider_kind,
                  ...(instanceId === undefined ? {} : { instance_id: instanceId }),
                  fields: payload,
                });
              }}
            >
              {t('st.im.setup.saveSlot')}
            </button>
            {checkTargetId !== undefined && checkTargetId !== '' ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                data-im-check
                disabled={submitting || busy}
                onClick={() => { onCheckAndListen(checkTargetId); }}
              >
                {t('st.im.check')}
              </button>
            ) : null}
          </div>
        </div>
      ) : checkTargetId !== undefined && checkTargetId !== '' ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={SECONDARY_BUTTON}
            data-im-check
            disabled={submitting || busy}
            onClick={() => { onCheckAndListen(checkTargetId); }}
          >
            {t('st.im.check')}
          </button>
        </div>
      ) : null}

      {savedInstanceId !== undefined ? (
        <p className="text-[13px] text-ink-soft" data-im-setup-saved-notice>
          {t('st.im.setup.savedNotice', { id: savedInstanceId })}
        </p>
      ) : null}
      <FeedbackLine feedback={error === undefined ? null : { tone: 'error', text: error }} />
    </div>
  );
}

function CapabilitySummary({ capabilities, providerKind }: {
  capabilities: SetupPlatformEntry['capabilities'];
  providerKind: ImProviderKind;
}) {
  const { t } = useI18n();
  const mediaLabels = capabilities.outbound
    .filter((kind) => kind !== 'text')
    .map((kind) => (MEDIA_KIND_KEYS[kind] !== undefined ? t(MEDIA_KIND_KEYS[kind]!) : kind));
  return (
    <div className="space-y-1 text-[12px] text-ink-soft" data-im-platform-capabilities={providerKind}>
      {mediaLabels.length > 0 || capabilities.voice_rendering === 'unsupported' ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {mediaLabels.length > 0 ? <span>{t('st.im.cap.outboundMedia', { kinds: mediaLabels.join(' / ') })}</span> : null}
          {mediaLabels.length > 0 && capabilities.voice_rendering === 'unsupported' ? <span aria-hidden>·</span> : null}
          {capabilities.voice_rendering === 'unsupported' ? (
            <span data-im-cap-voice={providerKind}>
              {t('st.im.cap.voiceUnsupported', { rendering: capabilities.audio_rendering })}
            </span>
          ) : null}
        </p>
      ) : null}
      {providerKind === 'matrix' && !capabilities.encrypted_rooms ? (
        <p className="text-amber-ink" data-im-cap-matrix-unencrypted>
          {t('st.im.cap.matrixUnencrypted')}
        </p>
      ) : null}
    </div>
  );
}

function AccountChannels({ account, data, catalog, setupPlatform, initialTarget, preselectedTarget, onPreselectTarget, refresh, reauthorize }: {
  account: ImInstanceStatus;
  data: ImSessionSnapshot;
  catalog: ImCatalog | undefined;
  setupPlatform?: SetupPlatformEntry;
  initialTarget: string;
  preselectedTarget?: string;
  onPreselectTarget: (target: string) => void;
  refresh: () => void;
  reauthorize: () => void;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const action = useImAction();
  const [adding, setAdding] = useState(false);
  const bindings = data.bindings.filter((item) => item.provider_instance_id === account.id);
  const discoveries = data.discoveries.filter((item) => item.provider_instance_id === account.id);
  const state = instanceStateInfo(account, t);
  const showAdd = adding || bindings.length === 0;
  const startListening = () => action.run(async () => {
    const checked = await client.imSessions.check(account.id);
    if (!checked.ok) throw new Error(checked.detail ?? t('st.im.error'));
    return client.imSessions.listen(account.id, true);
  });
  const listen = () => { void (account.listening ? action.run(() => client.imSessions.listen(account.id, false)) : startListening()); };

  const defaultTarget = initialTarget || (catalog?.personas[0] !== undefined ? `persona:${catalog.personas[0].id}` : catalog?.sessions[0] !== undefined ? `session:${catalog.sessions[0].id}` : '');
  const effectivePreselect = preselectedTarget ?? defaultTarget;

  return <section data-im-account={account.id} className="min-w-0 border-t border-hairline pt-4">
    <div data-im-instance-row={account.id} className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="text-[14px] font-medium text-ink">{instanceDisplayName(account, t)}</h3>
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft" data-im-instance-state={state.state} data-im-connection={account.connection}>
            <span aria-hidden className={`h-2 w-2 rounded-full ${state.dotClass}`} />
            {state.label}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-soft">
          <span className="break-all font-mono" data-im-adapter={account.adapter}>{account.account_id ?? account.id}</span>
          {account.provider_kind === 'matrix' && setupPlatform?.capabilities.encrypted_rooms === false ? (
            <>
              <span aria-hidden>·</span>
              <span className="text-ink-soft" data-im-account-matrix-unencrypted title={t('st.im.cap.matrixUnencrypted')}>
                {t('st.im.cap.matrixUnencrypted')}
              </span>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {bindings.length > 0 ? <button type="button" className={SECONDARY_BUTTON} data-im-start-bind={account.id} aria-expanded={showAdd}
          onClick={() => { setAdding((open) => !open); }}>{t(showAdd ? 'st.im.closeBindFlow' : 'st.im.bindAction')}</button> : null}
        {state.state === 'auth_expired' ? <button type="button" className={PRIMARY_BUTTON} data-im-reauthorize={account.id} onClick={reauthorize}>{t('st.im.reauthorize')}</button> : null}
        {state.state === 'stopped' && account.listening ? <button type="button" className={PRIMARY_BUTTON} data-im-retry-connection={account.id} disabled={action.saving || account.adapter === 'missing'} onClick={() => { void startListening(); }}>{t('st.im.retryConnection')}</button> : null}
        {account.listening || bindings.length > 0 ? <button type="button" className={SECONDARY_BUTTON} data-im-listen={account.id} disabled={action.saving || account.adapter === 'missing'} onClick={listen}>{t(account.listening ? 'st.im.stop' : 'st.im.listen')}</button> : null}
      </div>
    </div>
    {account.connection_detail !== undefined ? <ConnectionFailure detail={account.connection_detail} /> : state.state === 'auth_expired' ? <p className="mt-2 text-[13px] text-amber-ink">{t('st.im.authExpiredHint')}</p> : null}
    {account.conflict === 'webhook' ? <p data-im-webhook className="mt-2 text-[13px] text-amber-ink">{t('st.im.webhook')}</p> : null}
    {account.adapter === 'missing' ? <p data-im-missing className="mt-2 text-[13px] text-ink-soft">{t('st.im.missing')}</p> : null}
    <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />

    {discoveries.length > 0 ? <div className="mt-3 space-y-2.5" data-im-discoveries={account.id}>
      {discoveries.map((discovery) => (
        <DiscoveryRow
          key={discovery.id}
          discovery={discovery}
          catalog={catalog}
          setupPlatform={setupPlatform}
          initialTarget={preselectedTarget ?? initialTarget}
        />
      ))}
    </div> : null}

    {bindings.length > 0 ? <div data-im-bindings-list className="mt-3 divide-y divide-hairline">
      {bindings.map((binding) => <BindingRow key={binding.id} binding={binding} policy={data.policy} catalog={catalog} setupPlatform={setupPlatform} />)}
    </div> : null}

    {showAdd ? <div data-im-bind-flow={account.id} className="mt-3 space-y-3 rounded-lg border border-hairline bg-ink/[0.025] p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <h4 className="text-[13px] font-medium text-ink">{t('st.im.bindTitle')}</h4>
          <p className="text-[11.5px] text-ink-faint" data-im-bind-steps>{t('st.im.bindSteps')}</p>
        </div>
        <button type="button" className={SECONDARY_BUTTON} data-im-refresh-discovery onClick={refresh}>{t('st.im.refreshDiscovery')}</button>
      </div>
      <p className="text-[13px] leading-5 text-ink-soft" data-im-awaiting-discovery>
        {t(account.provider_kind === 'wechat_bridge' ? account.listening ? 'st.im.wechatDiscover' : 'st.im.wechatAwaitingListen' : account.listening ? 'st.im.waitingBody' : 'st.im.awaitingListenBody')}
      </p>
      {!account.listening && account.adapter !== 'missing' ? (
        <button type="button" data-im-bind-listen className={PRIMARY_BUTTON} disabled={action.saving} onClick={listen}>{t('st.im.startListenNow')}</button>
      ) : null}
      {account.listening && discoveries.length === 0 && bindings.length === 0 && catalog !== undefined ? (
        <div className="space-y-1.5 border-t border-hairline/70 pt-3" data-im-preselect-flow={account.id}>
          <span className={FORM_LABEL}>{t('st.im.preselectTarget')}</span>
          <TargetPicker
            id={`im-preselect-${account.id}`}
            value={effectivePreselect}
            onChange={onPreselectTarget}
            catalog={catalog}
            disabled={action.saving}
            attrPrefix="data-im-preselect"
          />
          <p className="text-[12px] text-ink-faint" data-im-preselect-pending-hint>{t('st.im.pendingStepHint')}</p>
        </div>
      ) : null}
    </div> : null}
  </section>;
}

function BindingRow({ binding, policy, catalog, setupPlatform }: {
  binding: ImBinding;
  policy: ImSessionSnapshot['policy'];
  catalog: ImCatalog | undefined;
  setupPlatform?: SetupPlatformEntry;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const action = useImAction();
  const [expanded, setExpanded] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [search, setSearch] = useState('');
  const [testing, setTesting] = useState(false);
  const [testFeedback, setTestFeedback] = useState<Feedback>(null);

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
  const on = binding.enabled && imSessionAdmitted({ allowed: policy.allowed, defaultEnabled: policy.default_enabled, sessionEnabled: binding.session_enabled });
  const blocked = !policy.allowed || !binding.enabled;
  const update = (patch: ImBindingPatch) => {
    setTestFeedback(null);
    void action.run(() => client.imSessions.updateBinding(binding.id, patch));
  };
  const targetValue = binding.persona_id !== undefined
    ? `persona:${binding.persona_id}`
    : binding.session_id !== undefined
      ? `session:${binding.session_id}`
      : 'unassigned';
  const boundChannelView = targetChannelsQuery.data?.channels.find((ch) => ch.id === `im:${binding.id}`);

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
        const deliveredCount = res.message_ids.length;
        const msg = res.detail ?? (deliveredCount > 0 ? t('st.im.testBinding.partial' as any, { delivered: deliveredCount, pending: 1 }) : t('st.im.error'));
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

  return <div data-im-binding={binding.id} aria-busy={action.saving || testing} className="space-y-3 py-3.5">
    <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(180px,1fr)_auto] md:items-center">
      <div className="min-w-0 space-y-0.5">
        <p className="break-words text-[14px] font-medium text-ink" data-im-binding-identity>{identity}</p>
        <IdentityIds identity={binding.identity} singleLine={!expanded} />
      </div>
      <div className="min-w-0">
        <SettingsSelect id={`im-binding-target-${binding.id}`} variant="form" ariaLabel={`${identity}: ${t('st.im.target')}`} value={targetValue}
          choices={bindingTargetChoices(targetCatalog, binding, t)} emptyText={binding.session_id} disabled={action.saving}
          onChange={(value) => { update({ target: parseTarget(value) }); }} dataAttr="data-im-binding-target" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
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
          <span>{t('st.im.sessionSwitch')}</span>
          <span className="sr-only">: {t(on ? 'st.im.on' : 'st.im.off')}</span>
        </button>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          data-im-test-binding={binding.id}
          disabled={action.saving || testing}
          onClick={() => { void runTestBinding(); }}
        >
          {t(testing ? 'st.im.testingBinding' : 'st.im.testBinding')}
        </button>
        <button
          type="button"
          className={`${SECONDARY_BUTTON} inline-flex items-center gap-1 px-2.5`}
          data-im-binding-options-toggle={binding.id}
          aria-label={t('st.im.bindingOptions')}
          aria-expanded={expanded}
          onClick={() => { setExpanded((open) => !open); setRemoving(false); }}
        >
          <DisclosureChevron open={expanded} />
          <span className="sr-only">{t('st.im.bindingOptions')}</span>
        </button>
      </div>
    </div>
    {blocked ? <p className="text-[13px] text-ink-soft" data-im-binding-blocked>{t(!policy.allowed ? 'st.im.railOffAllowed' : 'st.im.railOffBinding')}</p> : null}
    {testFeedback !== null ? (
      <div data-im-test-binding-result={binding.id}>
        <FeedbackLine feedback={testFeedback} />
      </div>
    ) : null}
    {expanded ? <div data-im-binding-details={binding.id} className="space-y-3 border-t border-hairline/60 pt-3">
      <IdentityIds identity={binding.identity} singleLine={false} />
      <label className="block max-w-sm space-y-1">
        <span className={FORM_LABEL}>{t('st.im.searchTarget')}</span>
        <input type="search" data-im-binding-target-search value={search} aria-label={t('st.im.searchTarget')} placeholder={t('st.im.searchTarget')} className={INPUT} onChange={(event) => { setSearch(event.target.value); }} />
      </label>
      {sessions.isError ? <p role="alert" className="text-[13px] text-danger">{t('st.im.searchError')}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-ink-soft">{t('st.im.sessionSwitch')}</span>
        <SettingsSegmented ariaLabel={`${identity}: ${t('st.im.sessionSwitch')}`} value={binding.session_enabled === undefined ? 'default' : binding.session_enabled ? 'on' : 'off'} disabled={action.saving}
          dataAttr="data-im-binding-policy" choices={[{ value: 'default', label: t('st.im.followDefault') }, { value: 'on', label: t('st.im.on') }, { value: 'off', label: t('st.im.off') }]}
          onChange={(value) => { update({ session_enabled: value === 'default' ? null : value === 'on' }); }} />
      </div>
      {targetChannelsQuery.data !== undefined ? (
        <div className="space-y-1.5" data-im-internal-channel={binding.session_id}>
          <SettingField label={t('st.im.internalChannel')} htmlFor={`im-internal-${binding.id}`}>
            <Toggle
              id={`im-internal-${binding.id}`}
              layout="bare"
              label={t('st.im.internalChannel')}
              checked={targetChannelsQuery.data.internal_enabled}
              disabled={action.saving}
              onChange={(enabled) => {
                if (binding.session_id === undefined) return;
                void action.run(async () => {
                  await client.imSessions.setInternalChannel(binding.session_id!, enabled);
                  await queryClient.invalidateQueries({ queryKey: [...KEY, 'target-channels', binding.session_id] });
                });
              }}
            />
          </SettingField>
          <Hint>{t('st.im.internalChannelHint')}</Hint>
        </div>
      ) : null}
      <BindingOptions kind={binding.provider_kind} setupPlatform={setupPlatform} capabilities={boundChannelView?.capabilities} busy={binding.busy} reply={binding.reply} actions={binding.mobile_interactions} disabled={action.saving} prefix="data-im-binding"
        onBusy={(busy) => { update({ busy }); }} onReply={(reply) => { update({ reply }); }} onActions={(mobile_interactions) => { update({ mobile_interactions }); }} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={SECONDARY_BUTTON} data-im-enabled={binding.id} disabled={action.saving} onClick={() => { update({ enabled: !binding.enabled }); }}>{t(binding.enabled ? 'st.im.disable' : 'st.im.enable')}</button>
        {removing ? <>
          <span className="text-[13px] text-ink-soft">{t('st.im.removeConfirm', { name: identity })}</span>
          <button type="button" className={DANGER_GHOST_BUTTON} data-im-remove-confirm={binding.id} disabled={action.saving} onClick={() => { void action.run(() => client.imSessions.removeBinding(binding.id)); }}>{t('st.im.remove')}</button>
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { setRemoving(false); }}>{t('common.cancel')}</button>
        </> : <button type="button" className={DANGER_GHOST_BUTTON} data-im-remove={binding.id} onClick={() => { setRemoving(true); }}>{t('st.im.remove')}</button>}
      </div>
    </div> : null}
    <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
  </div>;
}

function DiscoveryRow({ discovery, catalog, setupPlatform, initialTarget }: {
  discovery: ImDiscovery;
  catalog: ImCatalog | undefined;
  setupPlatform?: SetupPlatformEntry;
  initialTarget: string;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const action = useImAction();
  const [target, setTarget] = useState(initialTarget);
  const [alsoHome, setAlsoHome] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<'queue' | 'steer'>('queue');
  const [reply, setReply] = useState<'final' | 'edit'>('final');
  const [actions, setActions] = useState(true);

  useEffect(() => {
    if (initialTarget !== '') setTarget(initialTarget);
  }, [initialTarget]);

  const unsupported = discovery.provider_kind === 'wechat_bridge' && (discovery.identity.chat_kind === 'group' || discovery.identity.topic_id !== '0');
  const selected = target || (catalog?.personas[0] !== undefined ? `persona:${catalog.personas[0].id}` : catalog?.sessions[0] !== undefined ? `session:${catalog.sessions[0].id}` : '');
  return <div data-im-discovery={discovery.id} className="space-y-3 rounded-lg border border-amber-rule/40 bg-amber-card p-3.5">
    <div className="space-y-1">
      <p className="text-[11.5px] font-medium text-amber-ink">{t('st.im.discovery')}</p>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <p className="break-words text-[14px] font-medium text-ink">{identityLabel(discovery.identity, t)}</p>
        {discovery.preview !== '' ? <p className="min-w-0 truncate text-[13px] text-ink-soft" title={discovery.preview}>“{discovery.preview}”</p> : null}
      </div>
      <IdentityIds identity={discovery.identity} singleLine />
    </div>
    {unsupported ? <p data-im-unsupported className="text-[13px] leading-5 text-ink-soft">{t('st.im.wechatDirectOnly')}</p> : <TargetPicker id={`im-target-${discovery.id}`} value={selected} onChange={setTarget} catalog={catalog} disabled={action.saving} />}
    {!unsupported && selected.startsWith('persona:') ? <label className="flex min-h-8 items-center gap-2 text-[13px] text-ink-soft">
      <input type="checkbox" data-im-also-home checked={alsoHome} disabled={action.saving} onChange={(event) => { setAlsoHome(event.target.checked); }} />{t('st.im.alsoHome')}
    </label> : null}
    {expanded ? <BindingOptions kind={discovery.provider_kind} setupPlatform={setupPlatform} busy={busy} reply={reply} actions={actions} disabled={action.saving} prefix="data-im"
      onBusy={setBusy} onReply={setReply} onActions={setActions} /> : null}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={PRIMARY_BUTTON} data-im-confirm={discovery.id} disabled={unsupported || selected.length <= 8 || catalog === undefined || action.saving}
        onClick={() => { void action.run(async () => {
          const next = await client.imSessions.confirm(discovery.id, { target: parseTarget(selected), busy, reply: liveText(discovery.provider_kind, setupPlatform) ? reply : 'final', mobile_interactions: actions, also_home: selected.startsWith('persona:') && alsoHome });
          void queryClient.invalidateQueries({ queryKey: [...KEY, 'catalog'] });
          return next;
        }); }}>{t('st.im.confirm')}</button>
      <button type="button" className={SECONDARY_BUTTON} data-im-dismiss={discovery.id} disabled={action.saving} onClick={() => { void action.run(() => client.imSessions.dismiss(discovery.id)); }}>{t('st.im.dismiss')}</button>
      {!unsupported ? <button type="button" className={SECONDARY_BUTTON} data-im-advanced-toggle aria-expanded={expanded} onClick={() => { setExpanded((open) => !open); }}>{t('st.im.advancedOptions')}</button> : null}
    </div>
    <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
  </div>;
}

function TargetPicker({ id, value, onChange, catalog, disabled, attrPrefix = 'data-im-target' }: {
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
  busy: 'queue' | 'steer';
  reply: 'final' | 'edit';
  actions: boolean;
  disabled: boolean;
  prefix: string;
  onBusy: (value: 'queue' | 'steer') => void;
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
        <SettingsSegmented ariaLabel={t('st.im.busy')} value={busy} onChange={onBusy} disabled={disabled} dataAttr={`${prefix}-busy`} choices={[{ value: 'queue', label: t('st.im.queue') }, { value: 'steer', label: t('st.im.steer') }]} />
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
    {setupPlatform?.capabilities.voice_rendering === 'unsupported' ? (
      <p className="text-[12px] text-ink-soft" data-im-binding-voice-note>
        {t('st.im.cap.voiceUnsupported', { rendering: setupPlatform.capabilities.audio_rendering })}
      </p>
    ) : null}
  </div>;
}

function IdentityIds({ identity, singleLine = false }: { identity: ImIdentity; singleLine?: boolean }) {
  const { t } = useI18n();
  const full = `${t('st.im.chatId')}: ${identity.chat_id} · ${t('st.im.senderId')}: ${identity.sender_id}${identity.topic_id !== '0' ? ` · ${t('st.im.topicId')}: ${identity.topic_id}` : ''}`;
  return (
    <p
      className={`font-mono text-[12px] leading-5 text-ink-soft ${singleLine ? 'truncate' : 'break-all'}`}
      title={singleLine ? full : undefined}
      data-im-identity-ids
    >
      {full}
    </p>
  );
}

function identityLabel(identity: ImIdentity, t: Translator): string {
  return [identity.chat_title ?? identity.sender_name ?? identity.chat_id,
    identity.chat_title !== undefined ? identity.sender_name : undefined,
    identity.topic_id !== '0' ? identity.topic_title ?? `${t('st.im.topicId')} ${identity.topic_id}` : undefined].filter(Boolean).join(' · ');
}

function parseTarget(value: string): ImConfirmRequest['target'] {
  return value.startsWith('persona:') ? { kind: 'persona', persona_id: value.slice(8) } : { kind: 'session', session_id: value.slice(8) };
}

function bindingTargetChoices(catalog: ImCatalog | undefined, binding: ImBinding, t: Translator): { value: string; label: string }[] {
  const choices = [
    ...(catalog?.personas ?? []).map((item) => ({ value: `persona:${item.id}`, label: `${t('st.im.kindPersona')} · ${item.name}` })),
    ...(catalog?.sessions ?? []).map((item) => ({ value: `session:${item.id}`, label: `${t('st.im.kindSession')} · ${item.title}` })),
  ];
  const current = binding.persona_id !== undefined
    ? `persona:${binding.persona_id}`
    : binding.session_id !== undefined
      ? `session:${binding.session_id}`
      : 'unassigned';
  const fallbackLabel = binding.persona_id ?? binding.session_id ?? t('st.im.pendingReanchor' as any);
  if (!choices.some((choice) => choice.value === current)) choices.unshift({ value: current, label: fallbackLabel });
  return choices;
}

function providerDisplayName(kind: ImProviderKind, t: Translator): string {
  return t(`st.im.provider.${kind}`);
}

function instanceDisplayName(item: ImInstanceStatus, t: Translator): string {
  const platform = providerDisplayName(item.provider_kind, t);
  return item.label !== undefined && item.label.trim() !== '' && item.label !== item.provider_kind ? `${item.label} (${platform})` : platform;
}

function instanceStateInfo(item: ImInstanceStatus, t: Translator): { state: 'listening' | 'starting' | 'reconnecting' | 'auth_expired' | 'stopped'; label: string; dotClass: string } {
  const connection: string | undefined = item.connection;
  if (connection === 'auth_expired') return { state: 'auth_expired', label: t('st.im.stateAuthExpired'), dotClass: 'bg-amber-ink' };
  if (!item.listening) return { state: 'stopped', label: t('st.im.stateStopped'), dotClass: 'bg-ink/[0.25]' };
  if (connection === 'starting') return { state: 'starting', label: t('st.im.stateStarting'), dotClass: 'bg-amber-ink status-dot-busy' };
  if (connection === 'reconnecting') return { state: 'reconnecting', label: t('st.im.stateReconnecting'), dotClass: 'bg-amber-ink status-dot-busy' };
  if (connection === 'stopped' || item.adapter === 'stopped' || item.adapter === 'missing') return { state: 'stopped', label: t('st.im.stateListenerStopped'), dotClass: 'bg-ink/[0.25]' };
  return { state: 'listening', label: t('st.im.stateListening'), dotClass: 'bg-success' };
}

function ConnectionFailure({ detail }: { detail: ImConnectionDetail }) {
  const { t } = useI18n();
  const values = [detail.http_status === undefined ? undefined : `HTTP ${detail.http_status}`, detail.ret === undefined ? undefined : `ret ${detail.ret}`, detail.errcode === undefined ? undefined : `errcode ${detail.errcode}`].filter(Boolean);
  if (values.length === 0 && detail.failure_count === undefined && detail.retry_in_ms === undefined) return <p data-im-connection-detail className="mt-2 text-[13px] leading-5 text-ink-soft">{t(`st.im.failure.${detail.code}`)}</p>;
  return <details data-im-connection-detail className="mt-2 text-[13px] leading-5 text-ink-soft">
    <summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-selected-ink">{t(`st.im.failure.${detail.code}`)}</summary>
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 pl-4 font-mono">
      {values.length > 0 ? <span>{values.join(' · ')}</span> : null}
      {detail.failure_count !== undefined ? <span>{t('st.im.failureCount', { count: detail.failure_count })}</span> : null}
      {detail.retry_in_ms !== undefined ? <span>{t('st.im.retryDelay', { seconds: Math.ceil(detail.retry_in_ms / 1000) })}</span> : null}
    </div>
  </details>;
}

function liveText(kind: ImProviderKind, setupPlatform?: SetupPlatformEntry): boolean {
  if (setupPlatform !== undefined) return setupPlatform.capabilities.edit_text;
  return kind === 'telegram' || kind === 'feishu_app' || kind === 'discord' || kind === 'slack' || kind === 'matrix';
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
  if (!liveText(kind, setupPlatform)) return <div className="max-w-sm space-y-1 text-[13px] leading-5 text-ink-soft">
    <span className="text-ink" data-im-text-fixed={kind}>{t('st.im.final')}</span>
    <p data-im-text-note>{t(kind === 'onebot_v11' ? 'st.im.qqText' : 'st.im.wechatText')}</p>
    {kind === 'onebot_v11' ? <p data-im-file-note>{t('st.im.fileNote')}</p> : null}
  </div>;
  return <SettingsSegmented ariaLabel={t('st.im.text')} value={value} onChange={onChange} disabled={disabled} dataAttr={dataAttr} choices={[{ value: 'final', label: t('st.im.final') }, { value: 'edit', label: t('st.im.edit') }]} />;
}

function WechatScan({ loginId, image, status, verifyCode, error, onStart, onCancel, onVerifyCodeChange, onVerifySubmit }: {
  loginId?: string;
  image?: string;
  status?: string;
  verifyCode: string;
  error?: string;
  onStart: () => void;
  onCancel: () => void;
  onVerifyCodeChange: (code: string) => void;
  onVerifySubmit: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-2" data-im-wechat>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={SECONDARY_BUTTON} data-im-wechat-scan onClick={onStart}>{t('st.im.wechatScan')}</button>
        {loginId !== undefined ? <button type="button" className={SECONDARY_BUTTON} data-im-wechat-cancel onClick={onCancel}>{t('st.im.wechatCancel')}</button> : null}
        {status === 'expired' || status === 'verify_code_blocked' ? <button type="button" className={SECONDARY_BUTTON} data-im-wechat-retry onClick={onStart}>{t('st.im.retry')}</button> : null}
      </div>
      {image !== undefined && status !== 'cancelled' ? <WechatImage image={image} /> : null}
      {status !== undefined && status !== 'confirmed' ? <p className="text-[13px] text-ink-soft" data-im-wechat-status>{t(wechatStatusKey(status))}</p> : null}
      {status === 'need_verifycode' ? (
        <div className="flex flex-wrap items-center gap-2">
          <input data-im-wechat-verify value={verifyCode} className={INPUT} aria-label={t('st.im.wechatVerify')}
            onChange={(event) => { onVerifyCodeChange(event.target.value); }} />
          <button type="button" className={SECONDARY_BUTTON} data-im-wechat-verify-submit disabled={verifyCode.trim() === ''}
            onClick={onVerifySubmit}>{t('st.im.check')}</button>
        </div>
      ) : null}
      {error !== undefined ? <FeedbackLine feedback={{ tone: 'error', text: error }} /> : null}
    </div>
  );
}

function WechatImage({ image }: { image: string }) {
  if (image.startsWith('data:image')) return <img alt="" src={image} data-im-wechat-image className="h-40 w-40 bg-paper" />;
  const drawn = wechatQrImage(image);
  if (drawn !== undefined) {
    return (
      <div className="space-y-1">
        <img alt="" src={drawn} data-im-wechat-image className="h-40 w-40 bg-paper" />
        {image.startsWith('https://') ? <input readOnly data-im-wechat-code value={image} className={INPUT} /> : null}
      </div>
    );
  }
  return <input readOnly data-im-wechat-code value={image} className={INPUT} />;
}

function wechatStatusKey(status: string): 'st.im.wechatWaiting' | 'st.im.wechatScanned' | 'st.im.wechatExpired' | 'st.im.wechatVerify' | 'st.im.wechatBlocked' | 'st.im.wechatBound' | 'st.im.wechatCancel' | 'st.im.error' {
  if (status === 'wait') return 'st.im.wechatWaiting';
  if (status === 'scaned' || status === 'scaned_but_redirect') return 'st.im.wechatScanned';
  if (status === 'expired') return 'st.im.wechatExpired';
  if (status === 'need_verifycode') return 'st.im.wechatVerify';
  if (status === 'verify_code_blocked') return 'st.im.wechatBlocked';
  if (status === 'binded_redirect') return 'st.im.wechatBound';
  if (status === 'cancelled') return 'st.im.wechatCancel';
  return 'st.im.error';
}
