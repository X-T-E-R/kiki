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

  // The location is a fact the system can compute, so the draft is not the
  // preview target: picking a workspace or a mode previews at once, while a
  // typed path only becomes the target when the field is left, so a half-typed
  // path is never resolved.
  const [pathTarget, setPathTarget] = useState('');
  useEffect(() => {
    if (config.data === undefined || dirty) return;
    const next = taskBoardStorageFromConfig(config.data);
    setStorage(next);
    setPathTarget(fixedPathOf(next));
  }, [config.data, dirty]);

  const previewTarget: TaskBoardStorage = storage.mode === 'fixed'
    ? { mode: 'fixed', path: pathTarget }
    : { mode: storage.mode };
  const canPreview = board !== undefined
    && workspaceId !== ''
    && (storage.mode !== 'fixed' || pathTarget.trim() !== '');
  // Keyed by the target it resolves, so an answer for an abandoned workspace or
  // mode lands in its own cache entry and can never overwrite the current one.
  const preview = useQuery({
    queryKey: ['boardStoragePreview', workspaceId, previewTarget],
    queryFn: () => {
      if (!board) throw new Error(t('st.agentBoard.hint'));
      return board.read({ action: 'preview', workspaceId, configuration: previewTarget });
    },
    enabled: canPreview,
    retry: false,
  });
  const result = preview.data;
  const value = result?.ok && !Array.isArray(result.value) && 'selectionOnly' in result.value ? result.value : undefined;
  const failure = error ?? config.error?.message ?? preview.error?.message
    ?? (result !== undefined && !result.ok ? `${result.error.code}: ${result.error.message}` : undefined);
  const save = async () => {
    setSaving(true); setError(undefined);
    try {
      const body = { task_board: storage.mode === 'fixed' ? { storage: { mode: storage.mode, path: storage.path ?? '' } } : { storage: { mode: storage.mode } } };
      const echoed = await client.patchConfig(body);
      cache.setQueryData(['config'], echoed);
      const next = taskBoardStorageFromConfig(echoed);
      setStorage(next);
      setPathTarget(fixedPathOf(next));
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
  const resolved = value ? <dl className="break-all text-xs space-y-1" data-board-storage-preview><dt>{t('st.boardStorage.source')}</dt><dd>{t(`st.boardStorage.kind.${value.kind}`)} · {t(`st.boardStorage.${value.mode}`)} · {value.existing ? t('st.boardStorage.existing') : t('st.boardStorage.newStore')}</dd><dt>{t('st.boardStorage.resolved')}</dt><dd className="font-mono">{value.tasksDirectory}</dd></dl> : null;
  const computing = preview.isFetching && value === undefined
    ? <p role="status" data-board-storage-previewing className="text-xs text-ink-soft">{t('st.boardStorage.previewing')}</p>
    : null;
  // Auto lets the system choose, so its resolved directory is reference detail;
  // an explicit mode answers the user's own question, so it stays in view.
  const resolution = <>{resolved}{computing}</>;
  return <div className="space-y-3" data-board-storage-settings>
    <Hint>{t('st.boardStorage.policy')}</Hint>
    <div data-board-storage-mode>
      <span id="board-storage-mode-label" className={FORM_LABEL}>{t('st.boardStorage.mode')}</span>
      <div className="mt-1">
        {/* Picking a mode drops the draft path with it, so the preview target is dropped
            too: the field comes back empty, and an empty field must never resolve the
            path it used to hold. */}
        <SearchableSelect
          id="board-storage-mode"
          ariaLabel={t('st.boardStorage.mode')}
          value={storage.mode}
          disabled={saving || config.isPending || config.isError}
          hideFilter
          onChange={(next) => {
            setDirty(true);
            const mode = next as TaskBoardStorage['mode'];
            if (mode !== 'fixed') setPathTarget('');
            setStorage({ mode });
          }}
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
      <input
        className={`${INPUT} mt-1`}
        value={storage.path ?? ''}
        disabled={saving}
        onChange={(event) => { setDirty(true); setStorage({ mode: 'fixed', path: event.target.value }); }}
        onBlur={(event) => { setPathTarget(event.target.value); }}
        onKeyDown={(event) => { if (event.key === 'Enter') setPathTarget(event.currentTarget.value); }}
      />
      <Hint>{t('st.boardStorage.pathHint')}</Hint>
    </label> : null}
    <div data-board-storage-workspace>
      <span id="board-storage-workspace-label" className={FORM_LABEL}>{t('st.boardStorage.workspace')}</span>
      {/* The resolved location belongs to the workspace it resolves against, so the picker, the refresh and the result sit together, apart from the save row. */}
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
        <button
          type="button"
          className={`${SECONDARY_BUTTON} h-9 shrink-0`}
          disabled={!canPreview || preview.isFetching}
          onClick={() => { if (storage.mode === 'fixed') setPathTarget(storage.path ?? ''); void preview.refetch(); }}
        >
          {failure !== undefined ? t('st.boardStorage.retry') : t('st.boardStorage.refresh')}
        </button>
      </div>
    </div>
    {!board ? <p role="status" className="text-xs text-ink-soft">{t('st.agentBoard.hint')}</p> : null}
    {workspaceId === '' ? <p role="status" className="text-xs text-ink-soft">{t('st.boardStorage.awaitWorkspace')}</p> : null}
    {storage.mode === 'auto' ? null : resolution}
    {failure !== undefined ? <FeedbackLine feedback={{ tone: 'error', text: failure }} /> : null}
    <Hint>{t('st.boardStorage.noMove')}</Hint>
    <AdvancedDetails summary={t('st.boardStorage.details')} data-board-storage-details>
      {storage.mode === 'auto' ? resolution : null}
      <p>{t('st.boardStorage.policyDetails')}</p>
    </AdvancedDetails>
    <SettingsDraftFooter id="board-storage" dirty={dirty} saving={saving} saved={saved} saveLabel={t('st.boardStorage.save')}
      saveDisabled={config.isPending || config.isError || (storage.mode === 'fixed' && !storage.path?.trim())}
      onSave={() => { void save(); }}
      onDiscard={() => { if (config.data !== undefined) { const next = taskBoardStorageFromConfig(config.data); setStorage(next); setPathTarget(fixedPathOf(next)); } setDirty(false); setError(undefined); }} />
  </div>;
}

/** The path a preview target uses; only fixed mode has one. */
function fixedPathOf(storage: TaskBoardStorage): string {
  return storage.mode === 'fixed' ? storage.path ?? '' : '';
}
