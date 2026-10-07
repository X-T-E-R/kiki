/**
 * One workspace's own page — `/settings/workspaces?workspace=<id>`.
 *
 * The list stays a list. Everything you can *do* to a workspace lives on its
 * own page, because a workspace is the unit you configure: name and path are
 * its identity, its plugins are what its sessions may use, and the rest of what
 * belongs to it is scoped to it rather than to the machine.
 *
 * The grammar is the settings grammar — hairline rows, no cards inside cards,
 * one subject per card — so this page reads as the same product as the leaves
 * around it rather than as a second app.
 *
 * What each control writes is a fact about *this* workspace, and the page never
 * pretends otherwise:
 *
 * - Plugins carry the workspace override and the level each value came from, so
 *   a plugin that is on because the global default is on is not mistaken for
 *   one this workspace chose.
 * - Restore returns this workspace to inherit. It never touches the global
 *   default and never touches any session.
 * - Name, pin, memory, profiles and MCP are the existing client calls with this
 *   workspace's id or root. None of them is reimplemented here, and none of
 *   them is faked: a capability this server does not offer says so in one line
 *   instead of showing a field that would not save.
 */

import { useContext, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';

import type { PluginUsageItem, PluginUsageResponse, PluginUsageTarget, Workspace } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { workspacesSettingsPath } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { WorkspaceDetailNameContext } from '../workspaceScope';
import { useConnection } from '../../../state/connection';
import { isCapabilityUnsupportedError } from '../../agent-panel/mapCapabilities';
import { CapabilityIcon } from '../../capabilities/CapabilityIcon';
import { InstallFlow, type InstallRequest } from '../../capabilities/InstallFlow';
import { AddSourceDialog } from '../../capabilities/AddSourceDialog';
import { PluginCatalogDialog } from '../../capabilities/WorkspacePluginsSection';
import { useInvalidatePlugins } from '../../capabilities/usePlugins';
import {
  isStaleRevision,
  isStaleScope,
  overrideSource,
  rowBlockedByHome,
  rowCanRestore,
  rowState,
  rowToggleIntent,
  scopeOf,
  type OverrideSource,
} from '../../capabilities/pluginUsage';
import { FeedbackLine, InlineError, SavedTick, Toggle, type Feedback } from '../../controls';
import { Icon, Spinner } from '../../icons';
import { SECONDARY_BUTTON } from '../../ui';
import { SettingField } from '../fields';
import { SectionCard } from '../SectionCard';
import { SettingsSelect } from '../SettingsPrimitives';
import { useSavedTick } from '../useSavedTick';

const USAGE_QUERY_KEY = (workspaceId: string) => ['plugin-usage', { workspace_id: workspaceId }] as const;
const TRUST_QUERY_KEY = (workspaceId: string) => ['workspace-trust', workspaceId] as const;
const MEMORY_QUERY_KEY = (workspaceId: string) => ['memory-workspace-settings', workspaceId] as const;
const PROFILES_QUERY_KEY = (workspaceId: string) => ['agent-profiles', { workspace_id: workspaceId }] as const;
const MCP_QUERY_KEY = (root: string) => ['mcp-managed-servers', root] as const;
const SKILLS_QUERY_KEY = (workspaceId: string) => ['workspace-skills', workspaceId] as const;

export function WorkspaceSettingsPage({ workspaceId }: { readonly workspaceId: string }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const workspaceQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const workspace: Workspace | undefined = useMemo(
    () => workspaceQuery.data?.items.find((item) => item.id === workspaceId),
    [workspaceQuery.data, workspaceId],
  );

  const [name, setName] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // The breadcrumb names this workspace, the way an open plugin's page names
  // its plugin: the page is that object, not the section.
  const reportDetailName = useContext(WorkspaceDetailNameContext);

  const rename = useMutation({
    mutationFn: (next: string) => client.renameWorkspace(workspaceId, next),
    onSuccess: (echoed) => {
      setName(null);
      setFeedback({ tone: 'success', text: t('st.workspaces.detail.renamed', { name: echoed.name }) });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
    onError: (error: unknown) => { setFeedback({ tone: 'error', text: errorText(locale, error) }); },
  });

  const pinned = useMutation({
    mutationFn: (value: boolean) => client.setWorkspacePinned(workspaceId, value),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['workspaces'] }); },
    onError: (error: unknown) => { setFeedback({ tone: 'error', text: errorText(locale, error) }); },
  });

  const memory = useMemoryOverride(workspaceId);
  const trust = useWorkspaceTrust(workspaceId);
  const profiles = useWorkspaceProfiles(workspaceId);
  const [install, setInstall] = useState<InstallRequest | null>(null);
  const [adding, setAdding] = useState(false);
  const [browse, setBrowse] = useState(false);

  const back = (
    <button
      type="button"
      onClick={() => { void navigate(workspacesSettingsPath()); }}
      className="-ml-1 inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-[13px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
      data-workspace-detail-back
    >
      <Icon name="arrowLeft" size={14} />
      {t('st.workspaces.detail.back')}
    </button>
  );

  useEffect(() => {
    if (workspace !== undefined) reportDetailName(workspace.name);
    return () => { reportDetailName(null); };
  }, [reportDetailName, workspace?.name]);

  if (workspaceQuery.isPending) {
    return <p className="py-3 text-[13px] text-ink-faint" role="status" data-workspace-detail-loading>{t('cap.loading')}</p>;
  }
  if (workspaceQuery.isError) {
    return (
      <div className="space-y-2" data-workspace-detail-error>
        <InlineError error={workspaceQuery.error} />
        <button type="button" className={SECONDARY_BUTTON} onClick={() => { void workspaceQuery.refetch(); }}>{t('common.retry')}</button>
      </div>
    );
  }
  if (workspace === undefined) return <WorkspaceNotFound />;

  const draftName = name ?? workspace.name;
  const dirty = draftName.trim() !== '' && draftName.trim() !== workspace.name;

  /**
   * Every install opened from this page is made on behalf of THIS workspace,
   * whichever way it was reached — the catalog and a source both go through
   * here rather than through the market, which has no workspace to name and
   * would offer the install a scope it cannot fill. The scope *adds* the third
   * choice in the sheet; it never preselects it, so the reader still decides
   * between everywhere, later and here.
   */
  const installForThisWorkspace = (request: InstallRequest) => {
    setInstall({
      ...request,
      scope: { kind: 'workspace', target: { workspace_id: workspace.id }, name: workspace.name },
    });
  };

  return (
    <div className="space-y-6" data-workspace-detail={workspace.id}>
      {back}

      <SectionCard id="st-card-workspace-detail" title={workspace.name} scope="workspace">
        <p className="min-w-0 truncate font-mono text-[12px] text-ink-faint" data-workspace-detail-root title={workspace.root}>
          {workspace.root}
        </p>
        <div className="mt-4 space-y-3">
          <SettingField label={t('st.workspaces.renameTitle')}>
            <div className="flex flex-wrap items-center gap-2">
              <input
                data-autofocus
                data-workspace-detail-name
                aria-label={t('st.workspaces.renameTitle')}
                className="min-w-0 max-w-[42ch] flex-1 rounded-lg border border-hairline bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-selected-ink"
                value={draftName}
                maxLength={100}
                onChange={(event) => { setName(event.currentTarget.value); }}
                onKeyDown={(event) => { if (event.key === 'Enter' && dirty && !rename.isPending) rename.mutate(draftName.trim()); }}
              />
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={!dirty || rename.isPending}
                data-workspace-detail-rename
                onClick={() => { rename.mutate(draftName.trim()); }}
              >
                {rename.isPending ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </SettingField>
          <SettingField label={t('st.workspaces.pin')} help={t('st.workspaces.detail.pinHelp')}>
            <Toggle
              // The label names what a click would DO, not what is currently
              // true: an unpinned workspace offers to be pinned, and a pinned
              // one offers to be unpinned.
              label={workspace.pinned ? t('st.workspaces.unpin') : t('st.workspaces.pin')}
              checked={workspace.pinned}
              disabled={pinned.isPending}
              onChange={(checked) => { pinned.mutate(checked); }}
            />
          </SettingField>
        </div>
        {feedback !== null ? <div className="mt-2"><FeedbackLine feedback={feedback} /></div> : null}
      </SectionCard>

      <WorkspacePluginsCard
        workspace={workspace}
        onInstall={installForThisWorkspace}
        onAddFromSource={() => { setAdding(true); }}
        onBrowse={() => { setBrowse(true); }}
      />
      <WorkspaceTrustCard workspace={workspace} read={trust} />
      <WorkspaceMemoryCard workspace={workspace} memory={memory} />
      <WorkspaceResourcesCard workspace={workspace} profiles={profiles} />

      {browse ? (
        <PluginCatalogDialog
          title={t('st.workspaces.detail.browseTitle')}
          body={t('st.workspaces.detail.browseBody')}
          onClose={() => { setBrowse(false); }}
          onPick={(entry) => {
            setBrowse(false);
            installForThisWorkspace({ source: entry.source, sha256: entry.sha256, displayName: entry.displayName, icon: entry.icon, entry });
          }}
        />
      ) : null}
      {adding ? (
        <AddSourceDialog
          onClose={() => { setAdding(false); }}
          onPreview={(request) => { setAdding(false); installForThisWorkspace(request); }}
        />
      ) : null}
      {install !== null ? (
        <InstallFlow
          request={install}
          onClose={() => { setInstall(null); }}
          onInstalled={() => { void queryClient.invalidateQueries({ queryKey: USAGE_QUERY_KEY(workspace.id) }); }}
        />
      ) : null}
    </div>
  );
}

/**
 * What this workspace's sessions may use. Each switch is the workspace
 * override; each row names the level its value actually came from, and
 * restoring returns *this workspace* to inherit without touching the global
 * default or any session.
 */
function WorkspacePluginsCard({ workspace, onInstall, onAddFromSource, onBrowse }: {
  readonly workspace: Workspace;
  readonly onInstall: (request: InstallRequest) => void;
  readonly onAddFromSource: () => void;
  readonly onBrowse: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePlugins();
  const target: PluginUsageTarget = useMemo(() => ({ workspace_id: workspace.id }), [workspace.id]);
  const [pending, setPending] = useState<Readonly<Record<string, 'on' | 'off'>>>({});
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});

  const read = useQuery({
    queryKey: USAGE_QUERY_KEY(workspace.id),
    queryFn: () => client.getPluginUsage(target),
    staleTime: 5_000,
    retry: false,
  });

  const write = useMutation({
    mutationFn: (input: { pluginId: string; override: 'on' | 'off' | 'inherit' }) =>
      client.setPluginUsage({ target, plugin_id: input.pluginId, override: input.override }),
    onMutate: (input) => {
      // The choice is on screen before the server answers. `inherit` removes
      // the override, so it has no value to hold; the value is captured in a
      // const so the narrowing survives into the updater.
      const { override } = input;
      if (override === 'inherit') {
        setPending(({ [input.pluginId]: _cleared, ...rest }) => rest);
      } else {
        setPending((current) => ({ ...current, [input.pluginId]: override }));
      }
      setFailures(({ [input.pluginId]: _cleared, ...rest }) => rest);
    },
    onSuccess: (response: PluginUsageResponse) => {
      // The whole answer is the server's, so every optimistic entry is stale
      // the moment it lands; nothing is cleared per-plugin.
      setPending({});
      setFailures({});
      if (isStaleScope(response, scopeOf(read.data))) return;
      const previous = queryClient.getQueryData<PluginUsageResponse>(USAGE_QUERY_KEY(workspace.id));
      if (previous === undefined || !isStaleRevision(previous.revision, response.revision)) {
        queryClient.setQueryData(USAGE_QUERY_KEY(workspace.id), response);
      }
      void invalidate();
    },
    onError: (error, input) => {
      setPending(({ [input.pluginId]: _cleared, ...rest }) => rest);
      setFailures((current) => ({ ...current, [input.pluginId]: errorText(locale, error) }));
    },
  });

  const send = (pluginId: string, override: 'on' | 'off' | 'inherit') => {
    void write.mutateAsync({ pluginId, override }).catch(() => undefined);
  };
  const onToggle = (item: PluginUsageItem, enabled: boolean) => {
    if (rowToggleIntent(item) === undefined) return;
    if (enabled === item.effective) return;
    send(item.id, enabled ? 'on' : 'off');
  };

  const scope = scopeOf(read.data);
  const items = read.data?.plugins ?? [];
  const unsupported = isCapabilityUnsupportedError(read.error);

  return (
    <SectionCard id="st-card-workspace-plugins" title={t('st.workspaces.detail.plugins')} scope="workspace">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-ink-faint" data-workspace-plugins-scope title={scope?.root}>
          {scope === undefined ? t('st.workspaces.detail.pluginsScopePending') : t('st.workspaces.detail.pluginsScope', { name: scope.name })}
        </p>
        <div className="flex items-center gap-3">
          {/* Browsing stays on this page for the same reason "From a source"
              does: the same link to the marketplace dropped the workspace, and
              an install that arrived from here would then have offered a
              choice with no workspace to name. */}
          <button
            type="button"
            className="rounded text-[12px] text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
            data-workspace-plugins-browse=""
            onClick={onBrowse}
          >
            {t('rail.plugins.browse')}
          </button>
          <button type="button" className={`rounded text-[12px] text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink`} data-workspace-plugins-add-source="" onClick={onAddFromSource}>
            {t('rail.plugins.addSource')}
          </button>
        </div>
      </div>
      {unsupported ? (
        <p className="max-w-[62ch] text-[12px] leading-snug text-ink-faint" data-workspace-plugins-unsupported="">
          {t('st.workspaces.detail.pluginsUnsupported')}
        </p>
      ) : read.isPending ? (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-ink-faint" role="status">
          <Spinner label={t('cap.loading')} />{t('rail.plugins.loading')}
        </p>
      ) : read.isError ? (
        <div className="mt-3 space-y-2" data-workspace-plugins-error>
          <InlineError error={read.error} />
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { void read.refetch(); }}>{t('common.retry')}</button>
        </div>
      ) : items.length === 0 ? (
        <p className="mt-3 text-[13px] leading-relaxed text-ink-faint" data-workspace-plugins-empty>{t('st.workspaces.detail.pluginsEmpty')}</p>
      ) : (
        <ul className="mt-2" data-workspace-plugins-list>
          {items.map((item) => (
            <WorkspacePluginRow
              key={item.id}
              item={item}
              pending={pending[item.id]}
              failure={failures[item.id]}
              busy={write.isPending && write.variables?.pluginId === item.id}
              onToggle={onToggle}
              onRestore={(row) => { send(row.id, 'inherit'); }}
              onInstall={onInstall}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

const SOURCE_KEY: Readonly<Record<OverrideSource, I18nKey>> = {
  session: 'rail.plugins.source.session',
  workspace: 'rail.plugins.source.workspace',
  global: 'rail.plugins.source.global',
  home: 'rail.plugins.source.home',
};

const REASON_KEY: Readonly<Record<NonNullable<PluginUsageItem['reason']>, I18nKey>> = {
  home_disabled: 'rail.plugins.reason.homeOff',
  invalid_plugin: 'rail.plugins.reason.invalid',
  workspace_disabled: 'rail.plugins.reason.workspaceOff',
  session_disabled: 'rail.plugins.reason.sessionOff',
  global_disabled: 'rail.plugins.reason.globalOff',
};

function WorkspacePluginRow({ item, pending, failure, busy, onToggle, onRestore, onInstall }: {
  readonly item: PluginUsageItem;
  readonly pending?: 'on' | 'off';
  readonly failure?: string;
  readonly busy: boolean;
  readonly onToggle: (item: PluginUsageItem, enabled: boolean) => void;
  readonly onRestore: (item: PluginUsageItem) => void;
  readonly onInstall: (request: InstallRequest) => void;
}) {
  const { t } = useI18n();
  const effective = pending === undefined ? item.effective : pending === 'on';
  const state = rowState(item);
  const source = pending === undefined ? overrideSource(item) : 'workspace';
  return (
    <li
      className="flex min-w-0 items-center gap-3 border-b border-hairline py-2.5 last:border-b-0"
      data-workspace-plugin={item.id}
      data-override={pending ?? item.override}
      data-effective={String(effective)}
    >
      <CapabilityIcon icon={item.icon} kind="plugin" size="sm" />
      <div className="min-w-0 flex-1">
        <p className="min-w-0 truncate text-[13px] font-medium text-ink" title={item.displayName}>{item.displayName}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] leading-4 text-ink-faint">
          {state.kind === 'blocked' ? (
            <span data-workspace-plugin-reason={state.reason}>{t(REASON_KEY[state.reason])}</span>
          ) : (
            <span data-workspace-plugin-source={source}>{t(SOURCE_KEY[source])}</span>
          )}
          {item.app_service ? (
            // Home-scoped, and said so in the same words the rail uses: this
            // service is shared by the space's workspaces rather than run per
            // workspace, so the switch beside it cannot be read as starting or
            // stopping this workspace's own copy.
            <span data-workspace-plugin-app-service="" title={t('rail.plugins.appServiceHint')}>{t('rail.plugins.appService')}</span>
          ) : null}
          {rowCanRestore(item) && !rowBlockedByHome(item) ? (
            <button
              type="button"
              className="rounded underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
              data-workspace-plugin-restore=""
              onClick={() => { onRestore(item); }}
            >
              {t('rail.plugins.restore')}
            </button>
          ) : null}
          {busy ? <Spinner label={t('rail.plugins.saving')} /> : null}
          {failure !== undefined ? <span role="alert" className="text-danger" data-workspace-plugin-error>{failure}</span> : null}
        </p>
      </div>
      <Toggle
        // The row already prints the plugin's name, so the switch keeps it
        // for assistive tech only: repeating it here doubles the row's width
        // for text the reader can already see.
        label={t('st.workspaces.detail.pluginToggle', { name: item.displayName })}
        layout="bare"
        checked={effective}
        disabled={busy || state.kind === 'blocked'}
        onChange={(enabled) => { onToggle(item, enabled); }}
      />
      {/* A plugin that is not installed here yet is a real gap on this page,
          and the way to fill it is the same install flow the market uses. */}
      {item.state === 'error' ? (
        <button
          type="button"
          className={`shrink-0 rounded text-[12px] text-ink-faint transition-colors hover:text-ink`}
          data-workspace-plugin-reinstall={item.id}
          onClick={() => { onInstall({ source: item.id, displayName: item.displayName, ...(item.icon !== undefined ? { icon: item.icon } : {}) }); }}
        >
          {t('common.retry')}
        </button>
      ) : null}
    </li>
  );
}

/** Explicit trust, never granted as a side effect of opening this page. */
function useWorkspaceTrust(workspaceId: string) {
  const { client } = useConnection();
  const read = useQuery({
    queryKey: TRUST_QUERY_KEY(workspaceId),
    queryFn: () => client.getWorkspaceTrust(workspaceId),
    retry: false,
  });
  const write = useMutation({
    mutationFn: (trusted: boolean) => client.setWorkspaceTrust(workspaceId, trusted),
  });
  return { read, write };
}

function WorkspaceTrustCard({ workspace, read }: {
  readonly workspace: Workspace;
  readonly read: ReturnType<typeof useWorkspaceTrust>;
}) {
  const { t, locale } = useI18n();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const trusted = read.read.data?.trusted === true;
  const unsupported = isCapabilityUnsupportedError(read.read.error);

  const apply = async (next: boolean) => {
    setFeedback(null);
    try {
      await read.write.mutateAsync(next);
      setFeedback({ tone: 'success', text: next ? t('st.workspaces.detail.trustGranted') : t('st.workspaces.detail.trustRemoved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  return (
    <SectionCard id="st-card-workspace-trust" title={t('st.workspaces.detail.trust')} scope="workspace">
      {unsupported ? (
        <p className="max-w-[62ch] text-[12px] leading-snug text-ink-faint" data-workspace-trust-unsupported="">
          {t('st.workspaces.detail.trustUnsupported')}
        </p>
      ) : read.read.isPending ? (
        <p className="text-[13px] text-ink-faint" role="status">{t('cap.loading')}</p>
      ) : read.read.isError ? (
        <div className="space-y-2">
          <InlineError error={read.read.error} />
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { void read.read.refetch(); }}>{t('common.retry')}</button>
        </div>
      ) : (
        <>
          <p className="max-w-[62ch] text-[13px] leading-5 text-ink-soft" data-workspace-trust-state>
            {trusted ? t('st.workspaces.detail.trustOn') : t('st.workspaces.detail.trustOff')}
          </p>
          <div className="mt-3">
            <Toggle
              id="workspace-trust-toggle"
              // The label names what a click would DO, the way Pin/Unpin does:
              // a trusted workspace offers to stop being trusted, and an
              // untrusted one to become trusted. Trust is only ever granted by
              // this click — opening the page never grants it.
              label={trusted
                ? t('st.workspaces.detail.trustRevoke', { name: workspace.name })
                : t('st.workspaces.detail.trustGrant', { name: workspace.name })}
              checked={trusted}
              disabled={read.write.isPending}
              onChange={(checked) => { void apply(checked); }}
            />
          </div>
        </>
      )}
      {feedback !== null ? <div className="mt-2"><FeedbackLine feedback={feedback} /></div> : null}
    </SectionCard>
  );
}

/**
 * Memory for this workspace: inherit, on, or off. The server owns the
 * effective answer, so the row prints what it resolved to rather than
 * guessing from the override alone.
 */
function useMemoryOverride(workspaceId: string) {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const read = useQuery({
    queryKey: MEMORY_QUERY_KEY(workspaceId),
    queryFn: () => client.getWorkspaceMemorySettings(workspaceId),
    retry: false,
  });
  const write = useMutation({
    mutationFn: (enabled: boolean | null) => client.patchWorkspaceMemorySettings(workspaceId, enabled),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: MEMORY_QUERY_KEY(workspaceId) }); },
  });
  return { read, write };
}

function WorkspaceMemoryCard({ workspace, memory }: {
  readonly workspace: Workspace;
  readonly memory: ReturnType<typeof useMemoryOverride>;
}) {
  const { t, locale } = useI18n();
  const [saved, ping] = useSavedTick();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const override: 'inherit' | 'true' | 'false' = memory.read.data?.enabled === null || memory.read.data === undefined
    ? 'inherit'
    : String(memory.read.data.enabled) as 'true' | 'false';

  const apply = async (next: 'inherit' | 'true' | 'false') => {
    setFeedback(null);
    try {
      await memory.write.mutateAsync(next === 'inherit' ? null : next === 'true');
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  const effective = memory.read.data === undefined
    ? undefined
    : t(memory.read.data.effective_enabled ? 'st.memory.enabled' : 'st.memory.disabled');

  return (
    <SectionCard id="st-card-workspace-memory" title={t('st.memory.workspaces')} scope="workspace">
      {memory.read.isPending ? (
        <p className="text-[13px] text-ink-faint" role="status">{t('cap.loading')}</p>
      ) : memory.read.isError ? (
        <div className="space-y-2">
          <InlineError error={memory.read.error} />
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { void memory.read.refetch(); }}>{t('common.retry')}</button>
        </div>
      ) : (
        <SettingField
          label={t('memory.ws.label')}
          help={effective === undefined ? t('st.memory.workspaceHelp') : t('st.memory.workspaceEffectiveInline', { state: effective })}
        >
          <SavedTick show={saved && !memory.write.isPending} />
          <SettingsSelect<'inherit' | 'true' | 'false'>
            dataAttr="data-workspace-memory-override"
            ariaLabel={t('memory.ws.label')}
            value={override}
            disabled={memory.write.isPending}
            onChange={(next) => { void apply(next); }}
            choices={[
              { value: 'inherit', label: t('st.workspaces.detail.inherit') },
              { value: 'true', label: t('st.memory.enabled') },
              { value: 'false', label: t('st.memory.disabled') },
            ]}
          />
        </SettingField>
      )}
      {feedback !== null ? <div className="mt-2"><FeedbackLine feedback={feedback} /></div> : null}
      <p className="mt-2 text-[12px] text-ink-faint">{t('st.workspaces.detail.memoryFor', { name: workspace.name })}</p>
    </SectionCard>
  );
}

/**
 * The three things that live beside plugins on a workspace: the agent profiles
 * scoped to it, the MCP servers configured against its root, and the skills it
 * can read. The first two link to the pages that already edit them at this
 * workspace's real scope; the third is read-only here because skills are
 * discovered, not authored, from this page.
 */
function WorkspaceResourcesCard({ workspace, profiles }: {
  readonly workspace: Workspace;
  readonly profiles: ReturnType<typeof useWorkspaceProfiles>;
}) {
  const { t } = useI18n();
  const { client, klient } = useConnection();
  const mcp = useQuery({
    queryKey: MCP_QUERY_KEY(workspace.root),
    queryFn: () => klient.global.mcp.list({ cwd: workspace.root }),
    staleTime: 60_000,
    retry: false,
  });
  const skills = useQuery({
    queryKey: SKILLS_QUERY_KEY(workspace.id),
    queryFn: () => client.listWorkspaceSkills(workspace.id),
    staleTime: 30_000,
    retry: false,
  });

  const profileCount = profiles.data?.items.length;

  return (
    <SectionCard id="st-card-workspace-resources" title={t('st.workspaces.detail.resources')} scope="workspace">
      <div className="space-y-3">
        <ResourceRow
          label={t('st.workspaces.detail.profiles')}
          detail={profileCount === undefined ? undefined : t('st.workspaces.detail.count', { count: profileCount })}
          to={`/settings/agents?workspace=${encodeURIComponent(workspace.id)}`}
          dataAttr="data-workspace-profiles-link"
        />
        {/* MCP goes to the settings leaf, which reads this workspace's root
            when it is asked about one: the server list belongs to a place, so
            the link names the place rather than a section that would show
            whichever workspace happened to be most recent. */}
        <ResourceRow
          label={t('st.workspaces.detail.mcp')}
          detail={mcp.isPending ? t('cap.loading') : mcp.isError ? t('st.workspaces.detail.unreadable') : t('st.workspaces.detail.count', { count: mcp.data?.length ?? 0 })}
          to={`/settings/mcp?workspace=${encodeURIComponent(workspace.id)}`}
          dataAttr="data-workspace-mcp-link"
        />
        <ResourceRow
          label={t('st.workspaces.detail.skills')}
          detail={skills.isPending ? t('cap.loading') : skills.isError ? t('st.workspaces.detail.unreadable') : t('st.workspaces.detail.count', { count: skills.data?.skills.length ?? 0 })}
          to={`/capabilities?tab=skills&workspace=${encodeURIComponent(workspace.id)}`}
          dataAttr="data-workspace-skills-link"
        />
      </div>
    </SectionCard>
  );
}

function ResourceRow({ label, detail, to, dataAttr }: {
  readonly label: string;
  readonly detail?: string;
  readonly to: string;
  readonly dataAttr: string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 items-center gap-3 border-b border-hairline py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-ink">{label}</p>
        {detail !== undefined ? <p className="text-[12px] text-ink-faint">{detail}</p> : null}
      </div>
      <Link
        to={to}
        aria-label={t('st.workspaces.detail.openResource', { name: label })}
        className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-[12.5px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        {...{ [dataAttr]: '' }}
      >
        {label}
        <Icon name="arrowRight" size={12} className="text-ink-faint" />
      </Link>
    </div>
  );
}

/** Profiles scoped to this workspace, read through the existing list call. */
function useWorkspaceProfiles(workspaceId: string) {
  const { client } = useConnection();
  return useQuery({
    queryKey: PROFILES_QUERY_KEY(workspaceId),
    queryFn: () => client.listNamedAgentProfiles({ workspace_id: workspaceId }),
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * A link to a workspace this server no longer has. It says so and offers the
 * list, where the remaining workspaces are; it never falls back to some other
 * workspace's page, because a link that no longer points at anything should
 * read as a dead link, not as a different workspace.
 */
function WorkspaceNotFound() {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <div className="space-y-4 py-2" data-workspace-detail-missing>
      <div>
        <h2 className="font-display text-[18px] leading-6 text-ink">{t('st.workspaces.detail.missingTitle')}</h2>
        <p className="mt-1 max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t('st.workspaces.detail.missingBody')}</p>
      </div>
      <button type="button" className={SECONDARY_BUTTON} data-workspace-detail-back onClick={() => { void navigate(workspacesSettingsPath()); }}>
        {t('st.workspaces.title')}
      </button>
    </div>
  );
}