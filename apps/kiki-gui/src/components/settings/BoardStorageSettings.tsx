import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardClient } from '@kiki/klient/contract/board/types';
import { taskBoardStorageFromConfig, type TaskBoardStorage } from '@kiki/session-core/settings/agentCapabilitiesSettings';
import { useConnection } from '../../state/connection';
import { useI18n } from '../../i18n';
import { FeedbackLine, Hint } from '../controls';
import { SearchableSelect } from '../SearchableSelect';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { AdvancedDetails } from './fields';
import { FORM_LABEL, FORM_SELECT_TRIGGER, SettingsDraftFooter } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

export function BoardStorageSettings({ board }: { board?: BoardClient }) {
  const { client } = useConnection();
  const { t } = useI18n();
  const cache = useQueryClient();
  const config = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces() });
  const [workspaceId, setWorkspaceId] = useState('');
  const [storage, setStorage] = useState<TaskBoardStorage>({ mode: 'auto' });
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, ping] = useSavedTick();
  useEffect(() => {
    if (config.data !== undefined && !dirty) setStorage(taskBoardStorageFromConfig(config.data));
  }, [config.data, dirty]);
  const preview = useQuery({
    queryKey: ['boardStoragePreview', workspaceId, storage],
    queryFn: () => {
      if (!board) throw new Error(t('st.agentBoard.hint'));
      return board.read({ action: 'preview', workspaceId, configuration: storage });
    },
    enabled: false, retry: false,
  });
  const result = preview.data;
  const value = result?.ok && !Array.isArray(result.value) && 'selectionOnly' in result.value ? result.value : undefined;
  const save = async () => {
    setSaving(true); setError(undefined);
    try {
      const body = { task_board: storage.mode === 'fixed' ? { storage: { mode: storage.mode, path: storage.path ?? '' } } : { storage: { mode: storage.mode } } };
      const echoed = await client.patchConfig(body);
      cache.setQueryData(['config'], echoed);
      setStorage(taskBoardStorageFromConfig(echoed));
      setDirty(false);
      ping();
      await cache.invalidateQueries({ queryKey: ['boardStoragePreview'] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const modeHint = storage.mode === 'auto'
    ? t('st.boardStorage.modeAutoHint')
    : storage.mode === 'global'
      ? t('st.boardStorage.modeGlobalHint')
      : t('st.boardStorage.modeFixedHint');
  return <div className="space-y-3" data-board-storage-settings>
    <Hint>{t('st.boardStorage.policy')}</Hint>
    <div data-board-storage-mode>
      <span id="board-storage-mode-label" className={FORM_LABEL}>{t('st.boardStorage.mode')}</span>
      <div className="mt-1">
        <SearchableSelect
          id="board-storage-mode"
          ariaLabel={t('st.boardStorage.mode')}
          value={storage.mode}
          disabled={saving || config.isPending || config.isError}
          hideFilter
          onChange={(next) => { setDirty(true); setStorage({ mode: next as TaskBoardStorage['mode'] }); }}
          options={[
            { value: 'auto', label: t('st.boardStorage.auto') },
            { value: 'global', label: t('st.boardStorage.global') },
            { value: 'fixed', label: t('st.boardStorage.fixed') },
          ]}
          buttonClassName={FORM_SELECT_TRIGGER}
        />
      </div>
      <Hint>{modeHint}</Hint>
    </div>
    {storage.mode === 'fixed' ? <label className="block">
      <span className={FORM_LABEL}>{t('st.boardStorage.path')}</span>
      <input className={`${INPUT} mt-1`} value={storage.path ?? ''} disabled={saving} onChange={(event) => { setDirty(true); setStorage({ mode: 'fixed', path: event.target.value }); }} />
      <Hint>{t('st.boardStorage.pathHint')}</Hint>
    </label> : null}
    <div data-board-storage-workspace>
      <span id="board-storage-workspace-label" className={FORM_LABEL}>{t('st.boardStorage.workspace')}</span>
      {/* Preview belongs to the workspace it resolves against, so it sits beside the picker, apart from the save row. */}
      <div className="mt-1 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {/* Workspace lists can run long, so this picker keeps its filter. */}
          <SearchableSelect
            id="board-storage-workspace"
            ariaLabel={t('st.boardStorage.workspace')}
            value={workspaceId}
            onChange={setWorkspaceId}
            triggerLabel={workspaceId === '' ? <span className="text-ink-faint">{t('st.boardStorage.selectWorkspace')}</span> : undefined}
            options={(workspaces.data?.items ?? []).map((workspace) => ({
              value: workspace.id,
              label: workspace.name ?? workspace.root,
              hint: workspace.name === undefined ? undefined : workspace.root,
            }))}
            buttonClassName={FORM_SELECT_TRIGGER}
          />
        </div>
        <button type="button" className={`${SECONDARY_BUTTON} h-9 shrink-0`} disabled={!board || !workspaceId || preview.isFetching || (storage.mode === 'fixed' && !storage.path?.trim())} onClick={() => { void preview.refetch(); }}>{t('st.boardStorage.preview')}</button>
      </div>
    </div>
    {!board ? <p role="status" className="text-xs text-ink-soft">{t('st.agentBoard.hint')}</p> : null}
    {workspaceId === '' ? <p role="status" className="text-xs text-ink-soft">{t('st.boardStorage.awaitWorkspace')}</p> : null}
    {value ? <dl className="break-all text-xs space-y-1" data-board-storage-preview><dt>{t('st.boardStorage.source')}</dt><dd>{t(`st.boardStorage.kind.${value.kind}`)} · {t(`st.boardStorage.${value.mode}`)} · {value.existing ? t('st.boardStorage.existing') : t('st.boardStorage.newStore')}</dd><dt>{t('st.boardStorage.resolved')}</dt><dd className="font-mono">{value.tasksDirectory}</dd></dl> : null}
    <Hint>{t('st.boardStorage.noMove')}</Hint>
    <AdvancedDetails summary={t('st.boardStorage.details')} data-board-storage-details>
      <p>{t('st.boardStorage.policyDetails')}</p>
    </AdvancedDetails>
    <SettingsDraftFooter id="board-storage" dirty={dirty} saving={saving} saved={saved} saveLabel={t('st.boardStorage.save')}
      saveDisabled={config.isPending || config.isError || (storage.mode === 'fixed' && !storage.path?.trim())}
      onSave={() => { void save(); }}
      onDiscard={() => { if (config.data !== undefined) setStorage(taskBoardStorageFromConfig(config.data)); setDirty(false); setError(undefined); }} />
    {error || config.error || preview.error || (result && !result.ok) ? <FeedbackLine feedback={{ tone: 'error', text: error ?? config.error?.message ?? preview.error?.message ?? (result && !result.ok ? `${result.error.code}: ${result.error.message}` : '') }} /> : null}
  </div>;
}
