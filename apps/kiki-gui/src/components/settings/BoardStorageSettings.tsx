import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardClient } from '@kiki/klient/contract/board/types';
import { taskBoardStorageFromConfig, type TaskBoardStorage } from '@kiki/session-core/settings/agentCapabilitiesSettings';
import { useConnection } from '../../state/connection';
import { useI18n } from '../../i18n';
import { Hint, SavedTick } from '../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
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
    <label className="block text-xs">{t('st.boardStorage.mode')}
      <select className={`${INPUT} mt-1`} value={storage.mode} disabled={saving || config.isPending || config.isError}
        onChange={(event) => { setDirty(true); setStorage({ mode: event.target.value as TaskBoardStorage['mode'] }); }}>
        <option value="auto">{t('st.boardStorage.auto')}</option><option value="global">{t('st.boardStorage.global')}</option><option value="fixed">{t('st.boardStorage.fixed')}</option>
      </select>
      <Hint>{modeHint}</Hint>
    </label>
    {storage.mode === 'fixed' ? <label className="block text-xs">{t('st.boardStorage.path')}
      <input className={`${INPUT} mt-1`} value={storage.path ?? ''} disabled={saving} onChange={(event) => { setDirty(true); setStorage({ mode: 'fixed', path: event.target.value }); }} />
      <Hint>{t('st.boardStorage.pathHint')}</Hint>
    </label> : null}
    <label className="block text-xs">{t('st.boardStorage.workspace')}
      <select className={`${INPUT} mt-1`} value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
        <option value="">{t('st.boardStorage.selectWorkspace')}</option>
        {workspaces.data?.items.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name ?? workspace.root}</option>)}
      </select>
    </label>
    {!board ? <p role="status" className="text-xs text-ink-soft">{t('st.agentBoard.hint')}</p> : null}
    {workspaceId === '' ? <p role="status" className="text-xs text-ink-soft">{t('st.boardStorage.awaitWorkspace')}</p> : null}
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={SECONDARY_BUTTON} disabled={!board || !workspaceId || preview.isFetching || (storage.mode === 'fixed' && !storage.path?.trim())} onClick={() => { void preview.refetch(); }}>{t('st.boardStorage.preview')}</button>
      <button type="button" className={PRIMARY_BUTTON} disabled={saving || config.isPending || config.isError || !dirty || (storage.mode === 'fixed' && !storage.path?.trim())} onClick={() => { void save(); }}>{t('st.boardStorage.save')}</button>
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
