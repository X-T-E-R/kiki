import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { Dialog } from '../Dialog';
import { Icon } from '../icons';
import { agentCapabilitiesErrorText } from './mapCapabilities';
import { PromptEffectiveDetails } from './PromptEffectiveDetails';

export function PromptEffectiveDrawer({ sessionId, agentId, onClose }: {
  sessionId: string;
  agentId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { klient } = useConnection();
  const query = { session_id: sessionId, agent_id: agentId };
  const result = useQuery({
    queryKey: ['agentCapabilities', query],
    queryFn: ({ signal }) => klient.global.agentPanel.read(query, { signal }),
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: false,
  });
  return <Dialog onClose={onClose} ariaLabel={t('agentPanel.prompt.title')} overlayId="prompt-effective-drawer"
    overlayClassName="fixed inset-0 z-50 flex justify-end bg-shell/40 backdrop-blur-[2px]"
    panelClassName="anim-enter flex h-full w-full max-w-full flex-col overflow-hidden bg-panel text-ink outline-none shadow-2xl min-[768px]:max-w-[440px]">
    <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-4" data-prompt-drawer>
      <h2 className="text-[14px] font-medium">{t('agentPanel.prompt.title')}</h2>
      <button type="button" data-autofocus data-prompt-drawer-close aria-label={t('agentPanel.detailClose')} onClick={onClose}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-ink-soft hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40"><Icon name="close" size={14} /></button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 [&>[data-profile-section=prompt]>summary]:hidden">
      {result.isError ? <p role="alert" className="mb-3 text-[12px] leading-5 text-danger">
        {agentCapabilitiesErrorText(result.error, t)} <button type="button" className="rounded underline focus-visible:ring-2 focus-visible:ring-selected-ink/40" onClick={() => void result.refetch()}>{t('common.retry')}</button>
      </p> : null}
      <PromptEffectiveDetails query={query} value={result.data?.prompt} unavailable={result.isError || result.data?.available === false}
        loading={result.isPending} defaultOpen />
    </div>
  </Dialog>;
}
