import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { errorText, issueText } from '@kiki/session-core/i18n';
import { sortWorkspacesByRecency } from '@kiki/session-core/sessions';
import {
  appendExtraSkillDirs,
  markRestartRequired,
  validateExtraSkillDirs,
} from '@kiki/session-core/settings';
import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { pickWorkspace } from '../../lib/capabilities';
import { useConnection } from '../../state/connection';
import { CapabilityLink } from '../capabilities/CapabilityLink';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';
import { SettingsDraftFooter } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

/**
 * Skills defaults (redesign §10.3): the old capabilities skills card plus the
 * builtin product-skills switch from the dissolved sidecar card. All three
 * fields patch the server config file; the builtin switch needs a restart to
 * take effect.
 */
function SkillsDefaultsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [mergeSkills, setMergeSkills] = useState(true);
  const [builtinProductSkills, setBuiltinProductSkills] = useState(true);
  const [extraDirs, setExtraDirs] = useState('');
  const [baseline, setBaseline] = useState<{ merge: boolean; builtin: boolean; dirs: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectingDirs, setSelectingDirs] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const host = useHost();
  const canPickDirs = host.pickDirectories !== undefined;
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  const dirty = baseline !== null
    && (mergeSkills !== baseline.merge || builtinProductSkills !== baseline.builtin || extraDirs !== baseline.dirs);

  useEffect(() => {
    const config = configQuery.data;
    if (config === undefined || dirty) return;
    const merge = config.merge_all_available_skills !== false;
    const builtin = config.builtin_product_skills !== false;
    const dirs = (config.extra_skill_dirs ?? []).join('\n');
    setMergeSkills(merge);
    setBuiltinProductSkills(builtin);
    setExtraDirs(dirs);
    setBaseline({ merge, builtin, dirs });
  }, [configQuery.data, dirty]);

  const selectExtraDirs = async () => {
    setSelectingDirs(true);
    setFeedback(null);
    try {
      const selected = await host.pickDirectories?.();
      if (selected !== undefined && selected !== null) {
        setExtraDirs((current) => appendExtraSkillDirs(current, selected));
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSelectingDirs(false);
    }
  };

  const save = async () => {
    const pathError = validateExtraSkillDirs(extraDirs);
    if (pathError !== null) {
      setFeedback({ tone: 'error', text: issueText(locale, pathError) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({
        merge_all_available_skills: mergeSkills,
        extra_skill_dirs: extraDirs.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean),
        builtin_product_skills: builtinProductSkills,
      });
      queryClient.setQueryData(['config'], echoed);
      const merge = echoed.merge_all_available_skills !== false;
      const builtin = echoed.builtin_product_skills !== false;
      const dirs = (echoed.extra_skill_dirs ?? []).join('\n');
      setMergeSkills(merge);
      setBuiltinProductSkills(builtin);
      setExtraDirs(dirs);
      setBaseline({ merge, builtin, dirs });
      // Extra dirs feed the catalog above; refresh it so newly added folders show up.
      await queryClient.invalidateQueries({ queryKey: ['workspace-skills'] });
      if (builtin !== (configQuery.data?.builtin_product_skills !== false)) {
        markRestartRequired(['builtin_product_skills']);
        setFeedback({ tone: 'success', text: t('st.caps.savedRestart') });
      } else {
        pingSaved();
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-caps" title={t('st.caps.title')}>
      <div className="space-y-4">
        <div className="space-y-1">
          <SettingField label={t('st.caps.mergeSkills')} help={t('st.caps.mergeSkillsHint')}>
            <Toggle layout="bare" label={t('st.caps.mergeSkills')} checked={mergeSkills} onChange={setMergeSkills} />
          </SettingField>
          <SettingField label={t('st.sidecar.builtinSkills')} help={t('st.caps.builtinSkillsHint')}>
            <Toggle layout="bare" label={t('st.sidecar.builtinSkills')} checked={builtinProductSkills} onChange={setBuiltinProductSkills} />
          </SettingField>
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="settings-extra-skill-dirs" className="text-[11px] font-medium text-ink-soft">{t('st.caps.extraDirs')}</label>
            {canPickDirs ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={selectingDirs}
                onClick={() => void selectExtraDirs()}
              >
                {t('st.caps.selectDirs')}
              </button>
            ) : null}
          </div>
          <textarea id="settings-extra-skill-dirs" className={`${INPUT} mt-1 min-h-24 font-mono`} value={extraDirs} onChange={(event) => { setExtraDirs(event.target.value); }} placeholder={t('st.caps.extraDirsPlaceholder')} />
          <Hint>{t('st.caps.extraDirsHint')}</Hint>
        </div>
        <SettingsDraftFooter saved={justSaved} id="skill-defaults" dirty={dirty} saving={saving} saveLabel={t('st.caps.save')} onSave={() => void save()}
          onDiscard={() => { if (baseline !== null) { setMergeSkills(baseline.merge); setBuiltinProductSkills(baseline.builtin); setExtraDirs(baseline.dirs); } setFeedback(null); }} />
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/**
 * Skills leaf: the discovery defaults (where skills are loaded from). The
 * catalog itself is browsed on the Capabilities page; the first card counts
 * what the most recent workspace sees and links there.
 */
export function SkillsSection() {
  const { client } = useConnection();
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  const sorted = useMemo(() => sortWorkspacesByRecency(workspacesQuery.data?.items ?? []), [workspacesQuery.data]);
  const workspace = pickWorkspace(sorted, searchParams.get('workspace') ?? undefined);
  return (
    <div className="space-y-6">
      <SectionCard id="st-card-skill-catalog" title={t('st.skills.catalogTitle')}>
        <CapabilityLink kind="skills" workspaceId={workspace?.id} />
      </SectionCard>
      <SkillsDefaultsCard />
    </div>
  );
}
