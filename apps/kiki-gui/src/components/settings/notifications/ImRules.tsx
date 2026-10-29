import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImSessionSnapshot } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Toggle } from '../../controls';
import { DisclosureChevron } from '../../icons';
import { SettingField } from '../fields';
import { useImAction } from './useImSessions';

/**
 * The account-wide conversation policy, folded under the list: the two-way
 * master switch, whether new bindings start on, whether a thread may send to
 * a channel bound elsewhere, and the default for the send-message tool.
 */
export function ImRules({ policy }: { policy: ImSessionSnapshot['policy'] }) {
  const { t } = useI18n();
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();
  const action = useImAction();
  const config = useQuery({ queryKey: ['config', scopeId], queryFn: () => client.getConfig(), staleTime: 30_000 });
  const setPolicy = (next: ImSessionSnapshot['policy']) => { void action.run(() => client.imSessions.setPolicy(next)); };

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
            disabled={action.saving || config.isLoading}
            onChange={(enabled) => {
              void action.run(async () => {
                const res = await client.patchConfig({ optional_capabilities: { defaults: { send_message: enabled } } } as Parameters<typeof client.patchConfig>[0]);
                queryClient.setQueryData(['config', scopeId], res);
                await queryClient.invalidateQueries({ queryKey: ['config'] });
              });
            }} />
        </SettingField>
        <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
      </div>
    </details>
  );
}
