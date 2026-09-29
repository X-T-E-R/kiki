import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PermissionMode } from '@kiki/protocol';

import { errorText } from '@kiki/session-core/i18n';
import { writeSettings } from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '@kiki/session-core/transport';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, InlineError, SavedTick, type Feedback } from '../controls';
import { ToolPolicyCard } from './AutomationSection';
import { mergeConfigEcho } from './configEcho';
import { PermissionRulesSettings } from './PermissionRulesSettings';
import { ReviewerSettings } from './ReviewerSettings';
import { SectionCard } from './SectionCard';
import { SettingsSegmented } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

const MODES: readonly PermissionMode[] = ['manual', 'auto', 'review', 'yolo'];

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'manual' || value === 'auto' || value === 'review' || value === 'yolo';
}

/** The mode new sessions start in. One segmented choice, saved on click. */
function PermissionDefaultCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const [mode, setMode] = useState<PermissionMode>('auto');
  const [dangerousBash, setDangerousBash] = useState<'default' | 'on' | 'off'>('default');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();

  useEffect(() => {
    const next = configQuery.data?.default_permission_mode;
    if (!saving && isPermissionMode(next)) setMode(next);
    if (!saving) setDangerousBash(configQuery.data?.permission?.dangerousBash ?? 'default');
  }, [configQuery.data, saving]);

  const apply = async (next: PermissionMode) => {
    const previous = mode;
    setMode(next);
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ default_permission_mode: next });
      const merged = mergeConfigEcho(queryClient.getQueryData<KikiConfigResponse>(['config']) ?? configQuery.data, echoed);
      queryClient.setQueryData(['config'], merged);
      const echoedMode = merged.default_permission_mode;
      if (isPermissionMode(echoedMode)) {
        setMode(echoedMode);
        writeSettings({ defaultPermissionMode: echoedMode });
      }
      ping();
    } catch (error) {
      setMode(previous);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const applyDangerousBash = async (next: 'default' | 'on' | 'off') => {
    const previous = dangerousBash;
    setDangerousBash(next);
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ permission: { dangerous_bash: next } });
      const baseline = queryClient.getQueryData<KikiConfigResponse>(['config']) ?? configQuery.data;
      queryClient.setQueryData(['config'], {
        ...mergeConfigEcho(baseline, echoed),
        permission: echoed.permission ?? baseline?.permission,
      });
      ping();
    } catch (error) {
      setDangerousBash(previous);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-permission-defaults" title={t('st.perm.defaultTitle')} effect="newSessions">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SettingsSegmented<PermissionMode>
            ariaLabel={t('st.defaults.permissionMode')}
            value={mode}
            disabled={saving || configQuery.data === undefined}
            onChange={(next) => void apply(next)}
            choices={MODES.map((value) => ({ value, label: t(`st.defaults.permission.${value}`), caution: value === 'yolo' }))}
          />
          <SavedTick show={saved} />
        </div>
        <p data-permission-mode-hint className={`max-w-[62ch] text-[12px] leading-snug ${mode === 'yolo' ? 'text-amber-ink' : 'text-ink-soft'}`}>
          {t(`st.defaults.permission.${mode}Hint`)}
        </p>
        <div className="space-y-1 border-t border-hairline pt-3">
          <span className="block text-[13px] font-medium text-ink">{t('st.perm.dangerousBash')}</span>
          <SettingsSegmented ariaLabel={t('st.perm.dangerousBash')} value={dangerousBash}
            disabled={saving || configQuery.data === undefined} onChange={(next) => void applyDangerousBash(next)}
            choices={(['default', 'on', 'off'] as const).map((value) => ({ value, label: t(`st.perm.dangerousBash.${value}`) }))} />
          <p className="max-w-[62ch] text-[12px] leading-snug text-ink-soft">{t('st.perm.dangerousBashHint')}</p>
        </div>
        <FeedbackLine feedback={feedback} />
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
      </div>
    </SectionCard>
  );
}

/**
 * Permissions: every answer to "what may an agent do without asking me".
 * The default mode comes first; configured rules control individual tools,
 * the reviewer handles approvals, and tool policy controls available tools.
 */
export function PermissionsSection() {
  return (
    <>
      <PermissionDefaultCard />
      <PermissionRulesSettings />
      <ReviewerSettings />
      <ToolPolicyCard />
    </>
  );
}
