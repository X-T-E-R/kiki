import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { mcpTimeoutsPatch } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { CapabilityLink } from '../capabilities/CapabilityLink';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { SectionCard } from './SectionCard';
import { NumberField } from './runtimeControls';
import { SettingsDraftFooter } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

function optionalNumberDraft(value: number | null | undefined): string {
  return value === null ? 'null' : value === undefined ? '' : String(value);
}

/**
 * Server-wide MCP timeouts (redesign §8.3): they moved back next to the MCP
 * config they govern. The patch stays scoped to the `mcp` replace-domain so a
 * save here never rewrites the other runtime domains.
 */
function McpTimeoutsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [startupTimeoutMs, setStartupTimeoutMs] = useState('');
  const [toolTimeoutMs, setToolTimeoutMs] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    const config = configQuery.data;
    if (config === undefined || dirty) return;
    setStartupTimeoutMs(optionalNumberDraft(config.mcp?.startupTimeoutMs));
    setToolTimeoutMs(optionalNumberDraft(config.mcp?.toolTimeoutMs));
  }, [configQuery.data, dirty]);

  const save = async () => {
    let patch;
    try {
      patch = mcpTimeoutsPatch(startupTimeoutMs, toolTimeoutMs);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(patch);
      queryClient.setQueryData(['config'], echoed);
      setStartupTimeoutMs(optionalNumberDraft(echoed.mcp?.startupTimeoutMs));
      setToolTimeoutMs(optionalNumberDraft(echoed.mcp?.toolTimeoutMs));
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
      pingSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-mcp-timeouts" title={t('st.mcp.timeoutsTitle')}>
      <div className="space-y-3">
        <Hint>{t('st.mcp.timeoutsHint')}</Hint>
        <fieldset disabled={saving} className="grid gap-3 sm:grid-cols-2 disabled:opacity-60">
          <NumberField
            label={t('st.runtime.mcpStartupTimeout')}
            value={startupTimeoutMs}
            hint={t('st.mcp.startupTimeoutHint')}
            detail={t('st.mcp.startupTimeoutDetail')}
            onChange={(next) => { setStartupTimeoutMs(next); setDirty(true); }}
          />
          <NumberField
            label={t('st.runtime.mcpToolTimeout')}
            value={toolTimeoutMs}
            hint={t('st.mcp.toolTimeoutHint')}
            detail={t('st.mcp.toolTimeoutDetail')}
            onChange={(next) => { setToolTimeoutMs(next); setDirty(true); }}
          />
        </fieldset>
        <SettingsDraftFooter saved={justSaved} id="mcp-timeouts" dirty={dirty} saving={saving} onSave={() => void save()}
          onDiscard={() => { setStartupTimeoutMs(optionalNumberDraft(configQuery.data?.mcp?.startupTimeoutMs)); setToolTimeoutMs(optionalNumberDraft(configQuery.data?.mcp?.toolTimeoutMs)); setDirty(false); setFeedback(null); }} />
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/**
 * MCP leaf: server defaults only (the startup and tool-call timeouts). Adding,
 * editing, reconnecting and inspecting servers happen on the Capabilities
 * page; the first card says what is configured and links there.
 */
export function McpSection() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <SectionCard id="st-card-mcp" title={t('st.mcp.title')}>
        <CapabilityLink kind="mcp" />
      </SectionCard>
      <McpTimeoutsCard />
    </div>
  );
}
