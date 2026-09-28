import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardClient } from '@kiki/klient/contract/board/types';
import { taskBoardStorageFromConfig, type TaskBoardStorage } from '@kiki/session-core/settings/agentCapabilitiesSettings';
import { useConnection } from '../../state/connection';
import { useI18n } from '../../i18n';
import { Hint, SavedTick } from '../controls';
import { SearchableSelect } from '../SearchableSelect';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { FORM_LABEL, FORM_SELECT_TRIGGER } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';
import { useDirtyReporter } from '../dirtyGuard';

export function BoardStorageSettings({ board }: { board?: BoardClient }) {
  const { client } = useConnection();
  const { t } = useI18n();
  const cache = useQueryClient();
  const config = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces() });
  const [workspaceId, setWorkspaceId] = useState('');
  const [storage, setStorage] = useState<TaskBoardStorage>({ mode: 'auto' });
  const [dirty, setDirty] = useState(false);
  useDirtyReporter('board-storage', dirty);
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
      <div className="mt-1">
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
    </div>
    {!board ? <p role="status" className="text-xs text-ink-soft">{t('st.agentBoard.hint')}</p> : null}
    {workspaceId === '' ? <p role="status" className="text-xs text-ink-soft">{t('st.boardStorage.awaitWorkspace')}</p> : null}
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={SECONDARY_BUTTON} disabled={!board || !workspaceId || preview.isFetching || (storage.mode === 'fixed' && !storage.path?.trim())} onClick={() => { void preview.refetch(); }}>{t('st.boardStorage.preview')}</button>
      <button type="button" className={PRIMARY_BUTTON} disabled={saving || config.isPending || config.isError || !dirty || (storage.mode === 'fixed' && !storage.path?.trim())} onClick={() => { void save(); }}>{t('st.boardStorage.save')}</button>
      <button type="button" className={SECONDARY_BUTTON} disabled={saving || !dirty} onClick={() => { if (config.data !== undefined) setStorage(taskBoardStorageFromConfig(config.data)); setDirty(false); setError(undefined); }}>{t('st.advanced.discard')}</button>
      {dirty ? <span role="status" className="text-xs text-ink-soft">{t('st.tools.unsaved')}</span> : null}
      <SavedTick show={saved} />
    </div>
    <Hint>{t('st.boardStorage.noMove')}</Hint>
    <details data-board-storage-details className="text-xs text-ink-soft">
      <summary className="cursor-pointer">{t('st.boardStorage.details')}</summary>
      <p className="mt-1">{t('st.boardStorage.policyDetails')}</p>
    </details>
    {value ? <dl className="break-all text-xs space-y-1" data-board-storage-preview><dt>{t('st.boardStorage.source')}</dt><dd>{t(`st.boardStorage.kind.${value.kind}`)} · {t(`st.boardStorage.${value.mode}`)} · {value.existing ? t('st.boardStorage.existing') : t('st.boardStorage.newStore')}</dd><dt>{t('st.boardStorage.resolved')}</dt><dd className="font-mono">{value.tasksDirectory}</dd></dl> : null}
    {error || config.error || preview.error || (result && !result.ok) ? <p role="alert" className="text-xs text-danger">{error ?? config.error?.message ?? preview.error?.message ?? (result && !result.ok ? `${result.error.code}: ${result.error.message}` : '')}</p> : null}
  </div>;
}
