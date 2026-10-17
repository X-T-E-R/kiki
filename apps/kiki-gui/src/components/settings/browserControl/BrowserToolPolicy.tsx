import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { readLastSessionId } from '@kiki/session-core/settings';

import { useConnection } from '../../../state/connection';
import { useI18n } from '../../../i18n';
import { ConfirmDialog } from '../../ConfirmDialog';
import { FeedbackLine } from '../../controls';
import { SECONDARY_BUTTON } from '../../ui';
import { useInstantSave } from '../useInstantSave';

export function BrowserToolPolicy({ enabled }: { readonly enabled: boolean }) {
  const { client, scopeId } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const save = useInstantSave();
  const [confirming, setConfirming] = useState(false);
  const sessionId = readLastSessionId();
  const key = ['browser-tool-policy', scopeId, sessionId];
  const query = useQuery({
    queryKey: key,
    enabled: sessionId !== undefined && enabled,
    retry: false,
    queryFn: async () => {
      const agent = client.klient.session(sessionId!).agent('main');
      const [policy, connections, tabs] = await Promise.all([
        agent.inspectToolPolicy(), agent.isToolEnabled('BrowserConnections'), agent.isToolEnabled('BrowserTabs'),
      ]);
      return { policy, connections, tabs };
    },
  });
  if (!enabled || sessionId === undefined) return null;
  if (query.isError) return <p className="text-[12px] text-ink-soft" data-browser-toolpolicy-unavailable>{t('st.browser.sessionPolicyUnavailable')}</p>;
  if (query.data === undefined) return null;
  const { policy, connections, tabs } = query.data;
  const pending = policy.canRefresh && policy.revision !== undefined && JSON.stringify(policy.activeTools) !== JSON.stringify(policy.currentTools);
  if (!pending && connections && tabs) return null;
  const apply = () => {
    const revision = policy.revision;
    if (revision === undefined) return;
    void save.run(async () => {
      await client.klient.session(sessionId).agent('main').refreshToolPolicy(revision);
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: key });
    });
  };
  return <div className="space-y-2" data-browser-session-tool-policy>
    <p className="text-[12px] text-amber-ink">{t(pending ? 'st.browser.sessionPolicyPending' : 'st.browser.sessionPolicyRestricted')}</p>
    {pending ? <button type="button" className={SECONDARY_BUTTON} disabled={save.saving} data-browser-refresh-tool-policy
      onClick={() => { setConfirming(true); }}>{t('st.browser.refreshToolPolicy')}</button> : null}
    <FeedbackLine feedback={save.error} />
    <ConfirmDialog open={confirming} title={t('st.browser.refreshToolPolicy')} body={t('st.browser.refreshToolPolicyBody')}
      tone="default" busy={save.saving} confirmLabel={t('st.browser.refreshToolPolicy')} onConfirm={apply}
      onCancel={() => { setConfirming(false); }}>
      <p className="break-all font-mono text-[11px] text-ink-soft">{sessionId}</p>
    </ConfirmDialog>
  </div>;
}
