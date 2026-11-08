import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImSessionSnapshot, SendMessageConfigPatch, SendMessageVoiceMode } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useMediaManagedSources } from '../../../lib/mediaSources';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Toggle } from '../../controls';
import { DisclosureChevron } from '../../icons';
import { INPUT_BOX } from '../../ui';
import { SettingField } from '../fields';
import { SettingsSegmented, type SettingsChoice } from '../SettingsPrimitives';
import { useImAction } from './useImSessions';

function formatOptionsText(options: Readonly<Record<string, unknown>> | undefined): string {
  if (options === undefined || Object.keys(options).length === 0) return '';
  return JSON.stringify(options);
}

/**
 * The account-wide conversation policy, folded under the list: the two-way
 * master switch, whether new bindings start on, whether a thread may send to
 * a channel bound elsewhere, the default for the send-message tool, and its
 * default native voice (TTS) synthesis mode and parameters.
 */
export function ImRules({ policy }: { policy: ImSessionSnapshot['policy'] }) {
  const { t } = useI18n();
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();
  const action = useImAction();
  const [sampleRateError, setSampleRateError] = useState<string | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const config = useQuery({ queryKey: ['config', scopeId], queryFn: () => client.getConfig(), staleTime: 30_000 });
  const managedSources = useMediaManagedSources(client);
  const setPolicy = (next: ImSessionSnapshot['policy']) => { void action.run(() => client.imSessions.setPolicy(next)); };
  const sendMessageConfig = config.data?.send_message;
  const voiceMode: SendMessageVoiceMode = sendMessageConfig?.voiceMode ?? 'none';
  const ttsProvider = sendMessageConfig?.ttsProvider ?? '';
  const ttsVoice = sendMessageConfig?.ttsVoice ?? '';
  const ttsModel = sendMessageConfig?.ttsModel ?? '';
  const ttsLanguage = sendMessageConfig?.ttsLanguage ?? '';
  const ttsFormat = sendMessageConfig?.ttsFormat ?? '';
  const ttsSampleRateHz = sendMessageConfig?.ttsSampleRateHz !== undefined ? String(sendMessageConfig.ttsSampleRateHz) : '';
  const ttsOptionsText = formatOptionsText(sendMessageConfig?.ttsOptions);
  const disabled = action.saving || config.isLoading;

  const installedTtsProviders = (managedSources.data ?? [])
    .filter((source) => !source.removed)
    .flatMap((source) =>
      source.definitions
        .filter((def) => def.kinds.includes('tts'))
        .map((def) => ({
          id: `${source.pluginId}/${def.id}`,
          label: `${source.label} (${source.pluginId}/${def.id})`,
          shortLabel: source.label,
        })),
    );

  const patchSendMessage = (patch: SendMessageConfigPatch) => {
    void action.run(async () => {
      const res = await client.patchConfig({ send_message: patch } as Parameters<typeof client.patchConfig>[0]);
      queryClient.setQueryData(['config', scopeId], res);
      await queryClient.invalidateQueries({ queryKey: ['config'] });
    });
  };

  const voiceChoices: readonly SettingsChoice<SendMessageVoiceMode>[] = [
    { value: 'none', label: t('st.im.tts.mode.none') },
    { value: 'append', label: t('st.im.tts.mode.append') },
    { value: 'only', label: t('st.im.tts.mode.only') },
  ];

  const hasAdvancedValues =
    ttsLanguage.length > 0 ||
    ttsFormat.length > 0 ||
    ttsSampleRateHz.length > 0 ||
    ttsOptionsText.length > 0;

  return (
    <details className="group rounded-lg" data-im-rules>
      <summary className="flex min-h-10 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-[12.5px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink [&::-webkit-details-marker]:hidden">
        <DisclosureChevron open={false} className="text-ink-faint transition-transform group-open:rotate-90" />
        {t('st.channels.rules')}
        {!policy.allowed ? <span className="text-amber-ink">· {t('st.channels.twoWayOff')}</span> : null}
      </summary>
      <div className="mt-2 space-y-1 rounded-lg border border-hairline bg-panel px-4 py-3">
        <SettingField label={t('st.im.allowed')} htmlFor="im-allowed">
          <Toggle id="im-allowed" layout="bare" label={t('st.im.allowed')} checked={policy.allowed} disabled={action.saving}
            onChange={(allowed) => { setPolicy({ ...policy, allowed }); }} />
        </SettingField>
        <SettingField label={t('st.im.default')} htmlFor="im-default">
          <Toggle id="im-default" layout="bare" label={t('st.im.default')} checked={policy.default_enabled} disabled={action.saving}
            onChange={(default_enabled) => { setPolicy({ ...policy, default_enabled }); }} />
        </SettingField>
        <SettingField label={t('st.im.allowBorrowing')} htmlFor="im-allow-borrowing">
          <Toggle id="im-allow-borrowing" layout="bare" label={t('st.im.allowBorrowing')} checked={policy.allow_channel_borrowing ?? false}
            disabled={action.saving} onChange={(allow_channel_borrowing) => { setPolicy({ ...policy, allow_channel_borrowing }); }} />
        </SettingField>
        <SettingField label={t('st.im.defaultSendMessage')} htmlFor="im-default-send-message">
          <Toggle id="im-default-send-message" layout="bare" label={t('st.im.defaultSendMessage')}
            checked={config.data?.optional_capabilities?.send_message?.default_on ?? false}
            disabled={disabled}
            onChange={(enabled) => {
              void action.run(async () => {
                const res = await client.patchConfig({ optional_capabilities: { defaults: { send_message: enabled } } } as Parameters<typeof client.patchConfig>[0]);
                queryClient.setQueryData(['config', scopeId], res);
                await queryClient.invalidateQueries({ queryKey: ['config'] });
              });
            }} />
        </SettingField>
        <div className="space-y-1 border-t border-hairline pt-2" data-im-tts-rules>
          <SettingField label={t('st.im.tts.mode')} labelId="im-tts-mode-label" help={t('st.im.tts.modeHint')}>
            <SettingsSegmented
              ariaLabel={t('st.im.tts.mode')}
              value={voiceMode}
              disabled={disabled}
              dataAttr="data-im-tts-mode"
              choices={voiceChoices}
              onChange={(nextMode) => { patchSendMessage({ voice_mode: nextMode }); }}
            />
          </SettingField>
          <SettingField label={t('st.im.tts.provider')} htmlFor="im-tts-provider">
            <div className="flex w-full flex-col items-start gap-1.5 sm:w-auto sm:items-end">
              <input
                id="im-tts-provider"
                key={`provider:${ttsProvider}`}
                type="text"
                list={installedTtsProviders.length > 0 ? 'im-tts-provider-options' : undefined}
                defaultValue={ttsProvider}
                placeholder={t('st.im.tts.providerPlaceholder')}
                disabled={disabled}
                data-im-tts-provider
                className={`w-full sm:w-64 ${INPUT_BOX}`}
                onBlur={(event) => {
                  const next = event.currentTarget.value.trim();
                  if (next !== ttsProvider) patchSendMessage({ tts_provider: next === '' ? null : next });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
              {installedTtsProviders.length > 0 ? (
                <>
                  <datalist id="im-tts-provider-options">
                    {installedTtsProviders.map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </datalist>
                  <div className="flex flex-wrap justify-start gap-1 sm:justify-end" data-im-tts-provider-suggestions>
                    <button
                      type="button"
                      disabled={disabled}
                      data-im-tts-provider-option=""
                      aria-pressed={ttsProvider === ''}
                      onClick={() => {
                        if (ttsProvider !== '') patchSendMessage({ tts_provider: null });
                      }}
                      className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                        ttsProvider === ''
                          ? 'border-selected-border bg-selected text-selected-ink font-medium'
                          : 'border-hairline bg-surface text-ink-soft hover:bg-hover hover:text-ink'
                      }`}
                    >
                      {t('st.im.tts.providerDefault')}
                    </button>
                    {installedTtsProviders.map((item) => {
                      const active = ttsProvider === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          disabled={disabled}
                          data-im-tts-provider-option={item.id}
                          aria-pressed={active}
                          onClick={() => {
                            if (!active) patchSendMessage({ tts_provider: item.id });
                          }}
                          className={`rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                            active
                              ? 'border-selected-border bg-selected text-selected-ink font-medium'
                              : 'border-hairline bg-surface text-ink-soft hover:bg-hover hover:text-ink'
                          }`}
                        >
                          {item.shortLabel}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : null}
            </div>
          </SettingField>
          <SettingField label={t('st.im.tts.voice')} htmlFor="im-tts-voice">
            <input
              id="im-tts-voice"
              key={`voice:${ttsVoice}`}
              type="text"
              defaultValue={ttsVoice}
              placeholder={t('st.im.tts.voicePlaceholder')}
              disabled={disabled}
              data-im-tts-voice
              className={`w-full sm:w-64 ${INPUT_BOX}`}
              onBlur={(event) => {
                const next = event.currentTarget.value.trim();
                if (next !== ttsVoice) patchSendMessage({ tts_voice: next === '' ? null : next });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </SettingField>
          <SettingField label={t('st.im.tts.model')} htmlFor="im-tts-model">
            <input
              id="im-tts-model"
              key={`model:${ttsModel}`}
              type="text"
              defaultValue={ttsModel}
              placeholder={t('st.im.tts.modelPlaceholder')}
              disabled={disabled}
              data-im-tts-model
              className={`w-full sm:w-64 ${INPUT_BOX}`}
              onBlur={(event) => {
                const next = event.currentTarget.value.trim();
                if (next !== ttsModel) patchSendMessage({ tts_model: next === '' ? null : next });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </SettingField>
          <details className="group/more pt-1" data-im-tts-more open={hasAdvancedValues || undefined}>
            <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-[12px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink [&::-webkit-details-marker]:hidden">
              <DisclosureChevron open={false} className="text-ink-faint transition-transform group-open/more:rotate-90" />
              {t('st.im.tts.more')}
            </summary>
            <div className="mt-1 space-y-1 border-l border-hairline pl-3">
              <SettingField label={t('st.im.tts.language')} htmlFor="im-tts-language">
                <input
                  id="im-tts-language"
                  key={`language:${ttsLanguage}`}
                  type="text"
                  defaultValue={ttsLanguage}
                  placeholder={t('st.im.tts.languagePlaceholder')}
                  disabled={disabled}
                  data-im-tts-language
                  className={`w-full sm:w-64 ${INPUT_BOX}`}
                  onBlur={(event) => {
                    const next = event.currentTarget.value.trim();
                    if (next !== ttsLanguage) patchSendMessage({ tts_language: next === '' ? null : next });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
              </SettingField>
              <SettingField label={t('st.im.tts.format')} htmlFor="im-tts-format">
                <input
                  id="im-tts-format"
                  key={`format:${ttsFormat}`}
                  type="text"
                  defaultValue={ttsFormat}
                  placeholder={t('st.im.tts.formatPlaceholder')}
                  disabled={disabled}
                  data-im-tts-format
                  className={`w-full sm:w-64 ${INPUT_BOX}`}
                  onBlur={(event) => {
                    const next = event.currentTarget.value.trim();
                    if (next !== ttsFormat) patchSendMessage({ tts_format: next === '' ? null : next });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
              </SettingField>
              <SettingField label={t('st.im.tts.sampleRate')} htmlFor="im-tts-sample-rate">
                <input
                  id="im-tts-sample-rate"
                  key={`sampleRate:${ttsSampleRateHz}`}
                  type="text"
                  inputMode="numeric"
                  defaultValue={ttsSampleRateHz}
                  placeholder={t('st.im.tts.sampleRatePlaceholder')}
                  disabled={disabled}
                  data-im-tts-sample-rate
                  className={`w-full sm:w-64 ${INPUT_BOX}`}
                  onBlur={(event) => {
                    const next = event.currentTarget.value.trim();
                    if (next === '') {
                      setSampleRateError(null);
                      if (ttsSampleRateHz !== '') patchSendMessage({ tts_sample_rate_hz: null });
                      return;
                    }
                    const parsed = Number(next);
                    if (!Number.isInteger(parsed) || parsed <= 0) {
                      setSampleRateError(t('st.im.tts.sampleRateInvalid'));
                      return;
                    }
                    setSampleRateError(null);
                    if (String(parsed) !== ttsSampleRateHz) {
                      patchSendMessage({ tts_sample_rate_hz: parsed });
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
              </SettingField>
              <SettingField label={t('st.im.tts.options')} htmlFor="im-tts-options">
                <input
                  id="im-tts-options"
                  key={`options:${ttsOptionsText}`}
                  type="text"
                  defaultValue={ttsOptionsText}
                  placeholder={t('st.im.tts.optionsPlaceholder')}
                  disabled={disabled}
                  data-im-tts-options
                  className={`w-full sm:w-64 font-mono ${INPUT_BOX}`}
                  onBlur={(event) => {
                    const next = event.currentTarget.value.trim();
                    if (next === '') {
                      setOptionsError(null);
                      if (ttsOptionsText !== '') patchSendMessage({ tts_options: null });
                      return;
                    }
                    try {
                      const parsed: unknown = JSON.parse(next);
                      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                        setOptionsError(t('st.im.tts.optionsInvalid'));
                        return;
                      }
                      setOptionsError(null);
                      const normalized = JSON.stringify(parsed);
                      if (normalized !== ttsOptionsText) {
                        patchSendMessage({ tts_options: parsed as Record<string, unknown> });
                      }
                    } catch {
                      setOptionsError(t('st.im.tts.optionsInvalid'));
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
              </SettingField>
              {sampleRateError !== null ? <FeedbackLine feedback={{ tone: 'error', text: sampleRateError }} /> : null}
              {optionsError !== null ? <FeedbackLine feedback={{ tone: 'error', text: optionsError }} /> : null}
            </div>
          </details>
        </div>
        <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
      </div>
    </details>
  );
}
