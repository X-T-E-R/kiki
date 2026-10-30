import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ImPasteResult } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { FeedbackLine } from '../../controls';
import { INPUT, PRIMARY_BUTTON } from '../../ui';
import { FORM_LABEL } from '../SettingsPrimitives';
import { SetupSteps } from '../SetupSteps';
import { PASTE_FIELDS, pasteText, type PasteKind } from './catalog';
import { IM_KEY } from './imModel';
import { useImAction, useStartListening } from './useImSessions';

const LABEL: Readonly<Record<string, I18nKey>> = {
  token: 'st.channels.field.botToken',
  appId: 'st.channels.field.appId',
  appSecret: 'st.channels.field.appSecret',
  endpoint: 'st.channels.field.onebotEndpoint',
  accessToken: 'st.channels.field.accessToken',
  text: 'st.im.paste',
};

/** Where each pasted credential comes from: the steps a first-time reader follows. */
const PASTE_GUIDE: Readonly<Record<PasteKind, { readonly steps: readonly I18nKey[]; readonly link?: { readonly href: string; readonly label: I18nKey } }>> = {
  telegram: {
    steps: ['st.channels.steps.telegram.1', 'st.channels.steps.telegram.2', 'st.channels.steps.telegram.3'],
    link: { href: 'https://t.me/BotFather', label: 'st.channels.steps.telegram.link' },
  },
  feishu: {
    steps: ['st.channels.steps.feishu.1', 'st.channels.steps.feishu.2', 'st.channels.steps.feishu.3'],
    link: { href: 'https://open.feishu.cn/app', label: 'st.channels.steps.feishu.link' },
  },
  qq: {
    steps: ['st.channels.steps.onebot.1', 'st.channels.steps.onebot.2'],
    link: { href: 'https://napneko.github.io/', label: 'st.channels.steps.onebot.link' },
  },
  raw: { steps: ['st.channels.steps.raw.1'] },
};

const PLACEHOLDER: Readonly<Record<string, string>> = {
  token: '123456789:AA…',
  endpoint: 'ws://127.0.0.1:3001',
};

/**
 * Credential form for a two-way account the server reads from pasted text
 * (Telegram, Feishu, QQ through OneBot, or a raw paste). One action saves,
 * checks, and starts listening; `instanceId` re-authorizes an existing
 * account instead of creating one.
 */
export function PasteSetupForm({ kind, instanceId, onConnected }: {
  kind: PasteKind;
  instanceId?: string;
  onConnected: (instanceId: string) => void;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const action = useImAction();
  const startListening = useStartListening();
  const scope = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState<ImPasteResult>();
  const fields = PASTE_FIELDS[kind];
  const ready = fields.every((field) => !field.required || (values[field.key] ?? '').trim() !== '');

  const submit = () => {
    void action.run(async () => {
      const result = await client.imSessions.paste(pasteText(kind, values), instanceId);
      setNote(result);
      setValues({});
      await queryClient.invalidateQueries({ queryKey: IM_KEY });
      const next = await startListening(result.provider_instance_id);
      onConnected(result.provider_instance_id);
      return next;
    });
  };

  const guide = PASTE_GUIDE[kind];
  return (
    <div className="space-y-4" data-im-paste-panel={kind}>
      {instanceId === undefined ? (
        <SetupSteps data={{ 'data-im-paste-guide': kind }} steps={guide.steps.map((key) => t(key))}
          link={guide.link === undefined ? undefined : { href: guide.link.href, label: t(guide.link.label) }} />
      ) : null}
      {fields.map((field) => {
        const id = `${scope}-${field.key}`;
        return (
          <div key={field.key} className="space-y-1">
            <label htmlFor={id} className={FORM_LABEL}>
              {field.required ? t(LABEL[field.key]!) : `${t(LABEL[field.key]!)} · ${t('st.notify.optional')}`}
            </label>
            {kind === 'raw' ? (
              <textarea id={id} data-im-paste value={values[field.key] ?? ''} rows={4} spellCheck={false}
                placeholder={t('st.im.pastePlaceholder')} className={`${INPUT} font-mono`}
                onChange={(event) => { setValues((current) => ({ ...current, [field.key]: event.target.value })); }} />
            ) : (
              <input id={id} data-im-paste-field={field.key} type={field.secret ? 'password' : 'text'} value={values[field.key] ?? ''}
                spellCheck={false} autoComplete="off" placeholder={PLACEHOLDER[field.key]} className={`${INPUT} font-mono`}
                onChange={(event) => { setValues((current) => ({ ...current, [field.key]: event.target.value })); }} />
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={PRIMARY_BUTTON} data-im-check disabled={action.saving || !ready} onClick={submit}>
          {t(action.saving ? 'st.channels.connecting' : 'st.channels.connect')}
        </button>
      </div>
      {note !== undefined && note.ignored_keys.length > 0 ? <p className="text-[12px] text-ink-soft" data-im-ignored>{t('st.im.ignored')}: {note.ignored_keys.join(', ')}</p> : null}
      <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
    </div>
  );
}
