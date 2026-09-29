import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import type { KikiConfigPatch, KikiConfigResponse } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SaveStatus, Toggle } from '../controls';
import { INPUT } from '../ui';
import { AdvancedDetails, SettingField, SettingsGroup } from './fields';
import { CommitInput, SettingsSegmented } from './SettingsPrimitives';
import { useInstantSave } from './useInstantSave';

type Worktree = NonNullable<KikiConfigResponse['worktree']>;
type WorktreePatch = NonNullable<KikiConfigPatch['worktree']>;

// Mirrors the engine schema: lowercase segments, ending in a slash.
const BRANCH_PREFIX = /^[a-z0-9][a-z0-9/-]*\/$/;

/** Reads the worktree policy; the echo is camelCase with engine defaults filled in. */
export function useWorktreePolicy() {
  const { client } = useConnection();
  return useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
    select: (config: KikiConfigResponse) => config.worktree,
  });
}

function useWriteWorktree() {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  return async (worktree: WorktreePatch) => {
    const echoed = await client.patchConfig({ worktree });
    queryClient.setQueryData(['config'], echoed);
  };
}

/** One instant row: the switch, choice or number saves on its own. */
function InstantRow({ label, help, children }: {
  label: string;
  help?: string;
  children: (run: ReturnType<typeof useInstantSave>) => React.ReactNode;
}) {
  const save = useInstantSave();
  return (
    <>
      <SettingField label={label} help={help}>
        <SaveStatus saving={save.saving} saved={save.saved} />
        {children(save)}
      </SettingField>
      <FeedbackLine feedback={save.error} />
    </>
  );
}

/**
 * Ignored-file names that clean up may delete, one per line. Saved on blur
 * like the other fields here; Escape restores the stored list.
 */
function DisposableIgnoredEditor({ stored }: { stored: readonly string[] }) {
  const { t } = useI18n();
  const write = useWriteWorktree();
  const save = useInstantSave();
  const joined = stored.join('\n');
  const [text, setText] = useState(joined);
  useEffect(() => { setText(joined); }, [joined]);
  const commit = () => {
    const entries = [...new Set(text.split('\n').map((line) => line.trim()).filter((line) => line !== ''))];
    if (entries.join('\n') === joined) { setText(joined); return; }
    void save.run(() => write({ cleanup: { disposable_ignored: entries } }));
  };
  return (
    <div className="space-y-1.5 py-1">
      <div className="flex items-center justify-between gap-3">
        <label className="text-[13px] text-ink" htmlFor="worktree-disposable-ignored">{t('st.worktreePolicy.disposable')}</label>
        <SaveStatus saving={save.saving} saved={save.saved} />
      </div>
      <Hint>{t('st.worktreePolicy.disposableHelp')}</Hint>
      <textarea id="worktree-disposable-ignored" data-worktree-disposable rows={4} spellCheck={false} disabled={save.saving}
        className={`${INPUT} h-auto py-1.5 font-mono text-[12px] leading-5`}
        value={text}
        onChange={(event) => { setText(event.target.value); }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Escape') setText(joined); }} />
      <FeedbackLine feedback={save.error} />
    </div>
  );
}

/**
 * Workspaces → Worktrees → Policy: whether new sessions may use a worktree,
 * how branches are named and based, and when clean up runs. Each value saves
 * on its own; the storage root, git timeout and disposable list are Advanced.
 */
export function WorktreePolicy() {
  const { t } = useI18n();
  const policy = useWorktreePolicy();
  const write = useWriteWorktree();
  if (policy.isError) return <InlineError error={policy.error} />;
  const value: Worktree | undefined = policy.data;
  if (value === undefined) return policy.isLoading ? <Hint>{t('st.runtime.loading')}</Hint> : null;

  return (
    <div data-worktree-policy>
      <SettingsGroup title={t('st.worktreePolicy.title')}>
        <InstantRow label={t('st.worktreePolicy.enabled')} help={t('st.worktreePolicy.enabledHelp')}>
          {(save) => (
            <Toggle layout="bare" label={t('st.worktreePolicy.enabled')} checked={value.enabled} disabled={save.saving}
              onChange={(enabled) => void save.run(() => write({ enabled }))} />
          )}
        </InstantRow>
        <InstantRow label={t('st.worktreePolicy.base')} help={t('st.worktreePolicy.baseHelp')}>
          {(save) => (
            <SettingsSegmented<'head' | 'fresh'>
              ariaLabel={t('st.worktreePolicy.base')}
              dataAttr="data-worktree-base"
              value={value.defaultBase}
              disabled={save.saving}
              onChange={(default_base) => void save.run(() => write({ default_base }))}
              choices={[
                { value: 'head', label: t('st.worktreePolicy.baseHead') },
                { value: 'fresh', label: t('st.worktreePolicy.baseFresh') },
              ]}
            />
          )}
        </InstantRow>
        <InstantRow label={t('st.worktreePolicy.prefix')} help={t('st.worktreePolicy.prefixHelp')}>
          {(save) => (
            <CommitInput ariaLabel={t('st.worktreePolicy.prefix')} dataAttr="data-worktree-prefix" className="w-36 font-mono"
              value={value.branchPrefix} disabled={save.saving}
              validate={(text) => (BRANCH_PREFIX.test(text) ? null : t('st.worktreePolicy.prefixInvalid'))}
              onCommit={(branch_prefix) => void save.run(() => write({ branch_prefix }))} />
          )}
        </InstantRow>
        <InstantRow label={t('st.worktreePolicy.autoCleanup')} help={t('st.worktreePolicy.autoCleanupHelp')}>
          {(save) => (
            <Toggle layout="bare" label={t('st.worktreePolicy.autoCleanup')} checked={value.cleanup.auto} disabled={save.saving}
              onChange={(auto) => void save.run(() => write({ cleanup: { auto } }))} />
          )}
        </InstantRow>
        <InstantRow label={t('st.worktreePolicy.afterDays')} help={t('st.worktreePolicy.afterDaysHelp')}>
          {(save) => (
            <div className="flex items-center gap-1.5">
              <CommitInput ariaLabel={t('st.worktreePolicy.afterDays')} dataAttr="data-worktree-after-days" className="w-16" inputMode="numeric"
                value={String(value.cleanup.afterDays)} disabled={save.saving}
                validate={(text) => (/^\d+$/.test(text) && Number(text) >= 1 ? null : t('st.worktreePolicy.daysInvalid'))}
                onCommit={(text) => void save.run(() => write({ cleanup: { after_days: Number(text) } }))} />
              <span className="text-[12px] text-ink-faint">{t('st.worktreePolicy.daysUnit')}</span>
            </div>
          )}
        </InstantRow>
        <AdvancedDetails summary={t('st.worktreePolicy.advanced')}>
          <div className="space-y-1">
            <InstantRow label={t('st.worktreePolicy.root')} help={t('st.worktreePolicy.rootHelp')}>
              {(save) => (
                <CommitInput ariaLabel={t('st.worktreePolicy.root')} dataAttr="data-worktree-root" className="w-72 max-w-full font-mono"
                  value={value.root} placeholder={t('st.worktreePolicy.rootDefault')} disabled={save.saving}
                  validate={(text) => (text === '' || /^(?:[A-Za-z]:[\\/]|[\\/])/.test(text) ? null : t('st.worktreePolicy.rootInvalid'))}
                  onCommit={(root) => void save.run(() => write({ root }))} />
              )}
            </InstantRow>
            <InstantRow label={t('st.worktreePolicy.gitTimeout')} help={t('st.worktreePolicy.gitTimeoutHelp')}>
              {(save) => (
                <div className="flex items-center gap-1.5">
                  <CommitInput ariaLabel={t('st.worktreePolicy.gitTimeout')} dataAttr="data-worktree-git-timeout" className="w-20" inputMode="numeric"
                    value={String(value.gitTimeoutMs / 1000)} disabled={save.saving}
                    validate={(text) => (/^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 600 ? null : t('st.worktreePolicy.timeoutInvalid'))}
                    onCommit={(text) => void save.run(() => write({ git_timeout_ms: Number(text) * 1000 }))} />
                  <span className="text-[12px] text-ink-faint">{t('st.residency.secondsUnit')}</span>
                </div>
              )}
            </InstantRow>
            <DisposableIgnoredEditor stored={value.cleanup.disposableIgnored} />
          </div>
        </AdvancedDetails>
      </SettingsGroup>
    </div>
  );
}
