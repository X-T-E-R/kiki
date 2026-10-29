import { useEffect, useState } from 'react';
import type { ImPasteResult, ImSetupRequest } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { FeedbackLine } from '../../controls';
import { Icon } from '../../icons';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { AdvancedDetails } from '../fields';
import { FORM_LABEL, SettingsSegmented } from '../SettingsPrimitives';
import { SETUP_FIELD_KEYS, wechatStatusKey, type SetupPlatformEntry } from './imModel';
import { imErrorText, type WechatQr } from './useImSessions';
import { wechatQrImage } from './wechatQr';

/**
 * How one two-way account is set up: a bot platform's own form (Discord,
 * Slack, Matrix), the WeChat QR, and the WeChat image. Used to create a new
 * account from the add panel and to re-authorize an existing one in its row.
 */

export function PlatformSetupForm({ platform, instanceId, savedInstanceId, onSaved, onCheckAndListen, busy }: {
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
      setError(imErrorText(t, caught instanceof Error ? caught.message : ''));
    } finally {
      setSubmitting(false);
    }
  };

  const canSaveDirect = platform.fields.every((field) => !field.required || (fields[field.key]?.trim() ?? '').length > 0);
  const checkTargetId = savedInstanceId ?? instanceId;

  return (
    <div className="space-y-3" data-im-platform-setup={platform.provider_kind}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-soft">
        {platform.provider_kind === 'matrix' && !platform.capabilities.encrypted_rooms ? (
          <span className="text-amber-ink" data-im-cap-matrix-unencrypted>{t('st.im.cap.matrixUnencrypted')}</span>
        ) : <span />}
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
                  <div className="space-y-2 pt-2" data-im-slack-oauth-complete-form>
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
                <div className="space-y-2 pt-2" data-im-matrix-sso-complete-form>
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
        <p className="text-[13px] text-success" data-im-setup-saved-notice>
          {t('st.im.setup.savedNotice')}
        </p>
      ) : null}
      <FeedbackLine feedback={error === undefined ? null : { tone: 'error', text: error }} />
    </div>
  );
}

/**
 * The WeChat QR as the step's one object: the code in a framed tile, its
 * state under it, and the verification code when WeChat asks for one. The
 * code is requested as soon as the step opens.
 */
export function WechatScan({ qr }: { qr: WechatQr }) {
  const { t } = useI18n();
  const { start } = qr;
  const idle = !qr.active && !qr.requesting && qr.status === undefined && qr.error === undefined;
  useEffect(() => { if (idle) start(); }, [idle, start]);
  const ended = qr.status === 'expired' || qr.status === 'verify_code_blocked' || qr.status === 'cancelled' || (qr.error !== undefined && !qr.active);
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center" data-im-wechat>
      <div className="flex h-52 w-52 items-center justify-center rounded-xl border border-hairline bg-paper p-3 shadow-[var(--kiki-sheet-shadow)]">
        {qr.image !== undefined && qr.status !== 'cancelled' && !ended
          ? <WechatImage image={qr.image} />
          : <Icon name={ended ? 'refresh' : 'dot'} size={16} className={ended ? 'text-ink-faint' : 'text-ink-faint status-dot-busy'} />}
      </div>
      <p className="min-h-5 text-[13px] text-ink-soft" data-im-wechat-status>
        {qr.status !== undefined && qr.status !== 'confirmed' ? t(wechatStatusKey(qr.status)) : qr.active ? t('st.im.wechatWaiting') : qr.error === undefined ? t('st.channels.wechat.preparing') : null}
      </p>
      {qr.status === 'need_verifycode' ? (
        <div className="flex w-full max-w-xs items-center gap-2">
          <input data-im-wechat-verify value={qr.verifyCode} className={INPUT} aria-label={t('st.im.wechatVerify')}
            onChange={(event) => { qr.setVerifyCode(event.target.value); }} />
          <button type="button" className={PRIMARY_BUTTON} data-im-wechat-verify-submit disabled={qr.verifyCode.trim() === ''}
            onClick={qr.submitCode}>{t('st.channels.wechat.verify')}</button>
        </div>
      ) : null}
      {qr.error !== undefined ? <FeedbackLine feedback={{ tone: 'error', text: qr.error }} /> : null}
      <div className="flex flex-wrap justify-center gap-2">
        {ended ? <button type="button" className={SECONDARY_BUTTON} data-im-wechat-retry onClick={qr.start}>{t('st.channels.wechat.newCode')}</button> : null}
        {qr.active ? <button type="button" className={SECONDARY_BUTTON} data-im-wechat-cancel onClick={qr.cancel}>{t('st.im.wechatCancel')}</button> : null}
      </div>
    </div>
  );
}

function WechatImage({ image }: { image: string }) {
  const src = image.startsWith('data:image') ? image : wechatQrImage(image);
  if (src === undefined) return <input readOnly data-im-wechat-code value={image} className={INPUT} aria-label="QR" />;
  return <img alt="" src={src} data-im-wechat-image className="h-full w-full" />;
}
