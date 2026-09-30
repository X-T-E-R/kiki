/**
 * Plugin detail — what it adds, what it needs, then one folded "Advanced"
 * block for pinning, rollback, full permissions, provenance and diagnostics.
 *
 * Works for both states: a catalog entry that is not installed (description,
 * tier, install) and an installed plugin (live contributions from its
 * manifest, enable switch, the plugin's own skins from `/api/skins`).
 */

import { useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import {
  hasAnyPermission,
  pluginContributions,
  pluginPermissions,
  pluginPrerequisites,
  type PluginContributions,
  type PluginUpdateView,
} from '../../lib/pluginCatalog';
import type { PluginInfo, PluginSummary } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { Toggle } from '../controls';
import { Dialog } from '../Dialog';
import { Icon } from '../icons';
import { DANGER_BUTTON, DANGER_GHOST_BUTTON, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { CapabilityGlyph, CapabilityIcon } from './CapabilityIcon';
import type { InstallRequest } from './InstallFlow';
import { PermissionBoundary, PermissionList } from './PermissionList';
import { PluginSettingsForm } from './PluginSettingsForm';
import { Disclosure, FactList, Tag } from './primitives';
import {
  subjectIcon,
  subjectName,
  useInvalidatePlugins,
  usePluginInfo,
  usePluginSkins,
  type PluginSubject,
} from './usePlugins';

export function PluginDetail({
  subject,
  update,
  onBack,
  onInstall,
  onUpdate,
  onOpenPanel,
}: {
  readonly subject: PluginSubject;
  /** Available update from the catalog or GitHub; shown, never auto-installed. */
  readonly update?: PluginUpdateView;
  readonly onBack: () => void;
  readonly onInstall: (request: InstallRequest) => void;
  readonly onUpdate?: (plugin: PluginSummary, update: PluginUpdateView) => void;
  readonly onOpenPanel?: (pluginId: string, panelId: string) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const invalidate = useInvalidatePlugins();
  const installed = subject.installed;
  const infoQuery = usePluginInfo(installed === undefined ? undefined : subject.id);
  const info: PluginInfo | undefined = infoQuery.data;
  const skins = usePluginSkins(installed === undefined ? undefined : subject.id);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState<'toggle' | 'remove' | 'rollback' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [deleteData, setDeleteData] = useState(false);

  const manifest = info?.manifest as Readonly<Record<string, unknown>> | undefined;
  const contributions = pluginContributions(subject.id, manifest, {
    skillCount: installed?.skillCount,
    hookCount: installed?.hookCount,
    mcpServers: info?.mcpServers.map((server) => server.name),
  });
  const permissions = pluginPermissions(manifest);
  const prerequisites = pluginPrerequisites(info, manifest);
  const name = subjectName(subject);
  const description = (manifest?.['description'] as string | undefined)
    ?? subject.entry?.description;
  const broken = installed !== undefined && (installed.state === 'error' || installed.hasErrors);
  const catalogSource = subject.entry?.source;
  const version = installed?.version ?? subject.entry?.version;

  const run = async (kind: 'toggle' | 'remove' | 'rollback', action: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
      await invalidate();
    } catch (failure) {
      setError(errorText(locale, failure));
    } finally {
      setBusy(null);
    }
  };

  const install = () => {
    if (catalogSource === undefined) return;
    onInstall({
      source: catalogSource,
      displayName: name,
      icon: subjectIcon(subject, info),
      entry: subject.entry,
      prerequisites,
    });
  };

  return (
    <div className="min-w-0" data-plugin-detail={subject.id}>
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-[13px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        data-plugin-detail-back
      >
        <Icon name="arrowLeft" size={14} />
        {t('cap.detail.back')}
      </button>

      <header className="mt-4 flex flex-wrap items-start gap-4">
        <CapabilityIcon icon={subjectIcon(subject, info)} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="font-display text-[22px] leading-7 text-ink">{name}</h1>
            <TierTag tier={subject.entry?.tier} installed={installed} />
          </div>
          {description !== undefined ? <p className="mt-1 max-w-[62ch] text-[13px] leading-5 text-ink-soft">{description}</p> : null}
          <p className="mt-1 text-[12px] text-ink-faint">
            {version !== undefined ? `v${version}` : null}
            {update !== undefined ? (
              <>
                {version !== undefined ? ' · ' : null}
                <span className="font-medium text-selected-ink" data-plugin-update-state={update.via}>
                  {update.branch !== undefined && update.version !== undefined
                    ? t('cap.update.branch', { branch: update.branch, version: update.version })
                    : update.version !== undefined ? t('cap.plugins.updateTo', { version: update.version }) : t('cap.detail.updateAvailable')}
                </span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {installed === undefined ? (
            <button type="button" className={PRIMARY_BUTTON} onClick={install} disabled={catalogSource === undefined} data-plugin-install={subject.id}>
              {t('cap.action.install')}
            </button>
          ) : (
            <>
              {update !== undefined && onUpdate !== undefined ? (
                <button type="button" className={SECONDARY_BUTTON} onClick={() => { onUpdate(installed, update); }} data-plugin-update={subject.id}>{t('cap.action.update')}</button>
              ) : null}
              <Toggle
                label={installed.enabled ? t('cap.state.on') : t('cap.state.off')}
                checked={installed.enabled}
                disabled={busy !== null}
                onChange={(checked) => { void run('toggle', () => client.setPluginEnabled(installed.id, checked)); }}
              />
            </>
          )}
        </div>
      </header>

      {broken ? (
        <p role="alert" className="mt-4 text-[13px] text-danger" data-plugin-broken>
          {info?.diagnostics.find((item) => item.severity === 'error')?.message ?? t('cap.detail.broken')}
        </p>
      ) : null}
      {error !== null ? <p role="alert" className="mt-4 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-8 grid gap-8 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <div className="min-w-0 space-y-8">
          <section data-plugin-contributes>
            <h2 className="text-[13px] font-medium text-ink">{t('cap.detail.adds')}</h2>
            {installed === undefined ? (
              <p className="mt-2 text-[13px] leading-5 text-ink-soft">{t('cap.detail.addsAfterInstall')}</p>
            ) : infoQuery.isPending ? (
              <p className="mt-2 text-[13px] text-ink-faint" role="status">{t('cap.loading')}</p>
            ) : (
              <ContributionList
                contributions={contributions}
                skinNames={skins.skins.map((skin) => ({ id: skin.id, name: skin.name, variants: skin.variants }))}
                onOpenPanel={onOpenPanel === undefined ? undefined : (panelId) => { onOpenPanel(subject.id, panelId); }}
                enabled={installed.enabled}
              />
            )}
          </section>
          {installed !== undefined ? <PluginSettingsForm pluginId={subject.id} /> : null}
        </div>

        <aside className="min-w-0 space-y-6">
          <section data-plugin-needs>
            <h2 className="text-[13px] font-medium text-ink">{t('cap.detail.needs')}</h2>
            <div className="mt-2 space-y-3">
              {installed === undefined ? (
                <p className="text-[13px] text-ink-soft">{t('cap.detail.needsOnPreview')}</p>
              ) : hasAnyPermission(permissions) ? (
                <>
                  <PermissionList permissions={permissions} />
                  <PermissionBoundary />
                </>
              ) : (
                <p className="text-[13px] text-ink-soft">{t('cap.install.noPermissions')}</p>
              )}
              {prerequisites.map((item) => (
                <PrerequisiteLine key={item.id} pluginId={subject.id} item={item} installed={installed !== undefined} />
              ))}
            </div>
          </section>
        </aside>
      </div>

      <div className="mt-8 border-t border-hairline pt-4">
        <Disclosure label={t('cap.advanced')} open={advanced} onToggle={() => { setAdvanced((value) => !value); }} dataAttrs={{ 'data-plugin-advanced': '' }}>
          <div className="space-y-6">
            <FactList
              items={[
                { label: t('cap.detail.id'), value: subject.id, mono: true },
                ...(version !== undefined ? [{ label: t('cap.detail.version'), value: version, mono: true }] : []),
                ...(installed?.github !== undefined ? [{
                  label: t('cap.detail.pinned'),
                  value: `${installed.github.owner}/${installed.github.repo} @ ${(installed.github.installedSha ?? installed.github.ref.value).slice(0, 12)}`,
                  mono: true,
                }] : []),
                ...(installed?.zipSha256 !== undefined ? [{ label: t('cap.detail.checksum'), value: installed.zipSha256.slice(0, 16), mono: true }] : []),
                { label: t('cap.detail.source'), value: installed?.originalSource ?? catalogSource ?? '—', mono: true },
                ...(info?.root !== undefined ? [{ label: t('cap.detail.location'), value: info.root, mono: true }] : []),
                ...(info?.installedAt !== undefined ? [{ label: t('cap.detail.installedAt'), value: new Date(info.installedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : undefined) }] : []),
                ...(subject.entry?.homepage !== undefined ? [{ label: t('cap.detail.homepage'), value: <a className="text-selected-ink hover:underline" href={subject.entry.homepage} target="_blank" rel="noopener noreferrer">{subject.entry.homepage}</a> }] : []),
              ]}
            />
            {installed !== undefined ? (
              <div className="space-y-2" data-plugin-permissions-detail>
                <p className="text-[12px] font-medium text-ink-soft">{t('cap.detail.permissionsDeclared')}</p>
                <PermissionList permissions={permissions} />
              </div>
            ) : null}
            {prerequisites.length > 0 ? (
              <div className="space-y-2">
                <p className="text-[12px] font-medium text-ink-soft">{t('cap.detail.prerequisites')}</p>
                <FactList items={prerequisites.map((item) => ({
                  label: item.id,
                  value: [item.kind, item.version, item.required ? t('cap.detail.required') : t('cap.detail.optional'), item.setting].filter(Boolean).join(' · '),
                  mono: true,
                }))}
                />
              </div>
            ) : null}
            {info !== undefined && info.diagnostics.length > 0 ? (
              <div className="space-y-1" data-plugin-diagnostics>
                <p className="text-[12px] font-medium text-ink-soft">{t('cap.detail.diagnostics')}</p>
                <ul className="space-y-1">
                  {info.diagnostics.map((item, index) => (
                    <li key={index} className={`text-[12px] leading-4 ${item.severity === 'error' ? 'text-danger' : 'text-ink-soft'}`}>{item.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {installed !== undefined ? (
              <div className="flex flex-wrap items-center gap-2">
                {installed.rollback !== undefined ? (
                  <button type="button" className={SECONDARY_BUTTON} disabled={busy !== null} onClick={() => { setConfirmRollback(true); }} data-plugin-rollback={subject.id}>
                    {t('cap.action.rollback', { version: installed.rollback.version ?? t('cap.detail.previous') })}
                  </button>
                ) : null}
                <span className="flex-1" />
                <button type="button" className={DANGER_GHOST_BUTTON} disabled={busy !== null} onClick={() => { setConfirmRemove(true); }} data-plugin-remove={subject.id}>
                  {t('cap.action.remove')}
                </button>
              </div>
            ) : null}
          </div>
        </Disclosure>
      </div>

      {confirmRemove && installed !== undefined ? (
        <Dialog
          role="alertdialog"
          ariaLabel={t('cap.remove.title', { name })}
          overlayId="confirm-plugin-remove"
          onClose={() => { setConfirmRemove(false); setDeleteData(false); }}
        >
          <h3 className="font-display text-[18px] leading-6 text-ink">{t('cap.remove.title', { name })}</h3>
          <p className="mt-2.5 text-[13px] leading-5 text-ink-soft">{t('cap.remove.body')}</p>
          {removalConsequences(t, contributions).length > 0 ? (
            <ul className="mt-2.5 list-disc space-y-1 pl-5 text-[13px] leading-5 text-ink-soft">
              {removalConsequences(t, contributions).map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : null}
          <label className="mt-4 flex min-h-8 items-center gap-2 text-[13px] text-ink-soft">
            <input type="checkbox" checked={deleteData} onChange={(event) => { setDeleteData(event.target.checked); }} className="h-4 w-4 accent-[var(--color-danger)]" data-plugin-remove-data />
            {t('cap.remove.deleteData')}
          </label>
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className={SECONDARY_BUTTON} data-autofocus onClick={() => { setConfirmRemove(false); setDeleteData(false); }}>{t('common.cancel')}</button>
            <button
              type="button"
              className={DANGER_BUTTON}
              data-plugin-remove-confirm
              onClick={() => {
                const wipe = deleteData;
                setConfirmRemove(false);
                setDeleteData(false);
                void run('remove', () => client.removePlugin(installed.id, { deleteData: wipe })).then(onBack);
              }}
            >
              {deleteData ? t('cap.remove.confirmWithData') : t('cap.action.remove')}
            </button>
          </div>
        </Dialog>
      ) : null}
      {confirmRollback && installed?.rollback !== undefined ? (
        <ConfirmDialog
          open
          overlayId="confirm-plugin-rollback"
          title={t('cap.rollback.title', { name, version: installed.rollback.version ?? t('cap.detail.previous') })}
          body={t('cap.rollback.body')}
          confirmLabel={t('cap.action.rollback', { version: installed.rollback.version ?? t('cap.detail.previous') })}
          onCancel={() => { setConfirmRollback(false); }}
          onConfirm={() => { setConfirmRollback(false); void run('rollback', () => client.rollbackPlugin(installed.id)); }}
        />
      ) : null}
    </div>
  );
}

function removalConsequences(t: ReturnType<typeof useI18n>['t'], contributions: PluginContributions): readonly string[] {
  const lines: string[] = [];
  if (contributions.tools.length > 0) lines.push(t('cap.contrib.tools', { count: contributions.tools.length }));
  if (contributions.panels.length > 0) lines.push(t('cap.contrib.panels', { count: contributions.panels.length }));
  if (contributions.commands.length > 0) lines.push(t('cap.contrib.commands', { count: contributions.commands.length }));
  if (contributions.themes.length > 0) lines.push(t('cap.contrib.themes', { count: contributions.themes.length }));
  if (contributions.skills > 0) lines.push(t('cap.contrib.skills', { count: contributions.skills }));
  if (contributions.mcpServers.length > 0) lines.push(t('cap.contrib.mcp', { count: contributions.mcpServers.length }));
  return lines;
}

function TierTag({ tier, installed }: { readonly tier?: 'official' | 'curated' | 'third-party'; readonly installed?: PluginSummary }) {
  const { t } = useI18n();
  if (tier === 'official') return <Tag>{t('cap.tier.official')}</Tag>;
  if (tier === 'curated') return <Tag>{t('cap.tier.curated')}</Tag>;
  if (tier === 'third-party') return <Tag tone="warn">{t('cap.tier.thirdParty')}</Tag>;
  // Not in the catalog: say how it was installed, as the Installed list does.
  if (installed === undefined) return null;
  return <Tag>{installed.source === 'github' ? t('cap.origin.git') : installed.source === 'zip-url' ? t('cap.origin.zip') : t('cap.tier.local')}</Tag>;
}

function ContributionList({
  contributions,
  skinNames,
  onOpenPanel,
  enabled,
}: {
  readonly contributions: PluginContributions;
  readonly skinNames: readonly { readonly id: string; readonly name: string; readonly variants: readonly string[] }[];
  readonly onOpenPanel?: (panelId: string) => void;
  readonly enabled: boolean;
}) {
  const { t } = useI18n();
  const groups: { key: string; kind: Parameters<typeof CapabilityGlyph>[0]['kind']; title: string; rows: { key: string; name: string; meta?: string; action?: React.ReactNode }[] }[] = [];
  if (contributions.tools.length > 0) {
    groups.push({
      key: 'tools', kind: 'tool', title: t('cap.contrib.tools', { count: contributions.tools.length }),
      rows: contributions.tools.map((tool) => ({
        key: tool.name,
        name: tool.name,
        meta: [tool.description.split('. ')[0], tool.accesses.length > 0 ? tool.accesses.join(' / ') : undefined].filter(Boolean).join(' · '),
      })),
    });
  }
  if (contributions.panels.length > 0) {
    groups.push({
      key: 'panels', kind: 'panel', title: t('cap.contrib.panels', { count: contributions.panels.length }),
      rows: contributions.panels.map((panel) => ({
        key: panel.id,
        name: panel.label,
        meta: panel.slot === 'sidebar' ? t('cap.panel.sidebar') : t('cap.panel.workspace'),
        action: onOpenPanel !== undefined && enabled ? (
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { onOpenPanel(panel.id); }} data-plugin-open-panel={panel.id}>
            {t('cap.panel.open')}
          </button>
        ) : undefined,
      })),
    });
  }
  if (contributions.commands.length > 0) {
    groups.push({
      key: 'commands', kind: 'command', title: t('cap.contrib.commands', { count: contributions.commands.length }),
      rows: contributions.commands.map((command) => ({ key: command.name, name: `/${command.name}`, meta: command.description })),
    });
  }
  if (contributions.themes.length > 0 || skinNames.length > 0) {
    const rows = skinNames.length > 0
      ? skinNames.map((skin) => ({ key: skin.id, name: skin.name, meta: skin.variants.map((variant) => variant === 'dark' ? t('cap.skin.dark') : t('cap.skin.light')).join(' · ') }))
      : contributions.themes.map((theme) => ({ key: theme.id, name: theme.label, meta: theme.base === 'dark' ? t('cap.skin.dark') : t('cap.skin.light') }));
    groups.push({ key: 'themes', kind: 'theme', title: t('cap.contrib.themes', { count: rows.length }), rows });
  }
  if (contributions.skills > 0) {
    groups.push({ key: 'skills', kind: 'skill', title: t('cap.contrib.skills', { count: contributions.skills }), rows: [] });
  }
  if (contributions.mcpServers.length > 0) {
    groups.push({
      key: 'mcp', kind: 'mcp', title: t('cap.contrib.mcp', { count: contributions.mcpServers.length }),
      rows: contributions.mcpServers.map((server) => ({ key: server, name: server })),
    });
  }
  if (contributions.providerPresets.length > 0) {
    groups.push({
      key: 'providers', kind: 'plugin', title: t('cap.contrib.providers', { count: contributions.providerPresets.length }),
      rows: contributions.providerPresets.map((preset) => ({ key: preset.id, name: preset.label })),
    });
  }
  if (groups.length === 0) return <p className="mt-2 text-[13px] text-ink-faint">{t('cap.install.addsNothing')}</p>;
  return (
    <div className="mt-3 space-y-5">
      {groups.map((group) => (
        <div key={group.key} data-plugin-contribution={group.key}>
          <p className="flex items-center gap-2 text-[12px] font-medium text-ink-soft">
            <span className="text-ink-faint"><CapabilityGlyph kind={group.kind} className="h-3.5 w-3.5" /></span>
            {group.title}
          </p>
          {group.rows.length > 0 ? (
            <ul className="mt-1 space-y-0.5 pl-[22px]">
              {group.rows.map((row) => (
                <li key={row.key} className="flex min-h-8 items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[13px] text-ink ${group.key === 'tools' || group.key === 'commands' || group.key === 'mcp' ? 'font-mono text-[12px]' : ''}`}>{row.name}</span>
                    {row.meta !== undefined && row.meta !== '' ? <span className="block truncate text-[12px] leading-4 text-ink-faint">{row.meta}</span> : null}
                  </span>
                  {row.action}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PrerequisiteLine({ pluginId, item, installed }: {
  readonly pluginId: string;
  readonly item: ReturnType<typeof pluginPrerequisites>[number];
  readonly installed: boolean;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const invalidate = useInvalidatePlugins();
  const [state, setState] = useState<'idle' | 'confirm' | 'running' | 'done' | 'failed'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const run = async () => {
    setState('running');
    setMessage(null);
    try {
      await client.installPluginPrerequisite(pluginId, item.id);
      await invalidate();
      setState('done');
    } catch (error) {
      setMessage(errorText(locale, error));
      setState('failed');
    }
  };
  const executable = item.kind === 'executable';
  return (
    <div className="text-[13px]" data-plugin-prerequisite={item.id}>
      <p className="text-ink">
        <span className="font-mono text-[12px]">{item.id}</span>
        {item.version !== undefined ? <span className="text-ink-faint"> {item.version}</span> : null}
        {item.required ? <span className="text-ink-faint"> · {t('cap.detail.required')}</span> : null}
      </p>
      {installed && executable ? (
        <div className="mt-1.5">
          {state === 'done' ? (
            <span className="text-[12px] text-ink-soft" role="status">{t('cap.prereq.done')}</span>
          ) : (
            <button type="button" className={SECONDARY_BUTTON} disabled={state === 'running'} onClick={() => { setState('confirm'); }} data-plugin-prerequisite-action={item.id}>
              {state === 'running' ? t('cap.prereq.installing') : t('cap.prereq.action', { id: item.id })}
            </button>
          )}
          {message !== null ? <p role="alert" className="mt-1 text-[12px] text-danger">{message}</p> : null}
        </div>
      ) : (
        <p className="mt-0.5 text-[12px] leading-4 text-ink-faint">{t('cap.install.needsLater')}</p>
      )}
      {state === 'confirm' ? (
        <ConfirmDialog
          open
          overlayId="confirm-plugin-prerequisite"
          title={t('cap.prereq.title', { id: item.id })}
          body={t('cap.prereq.body', { id: item.id, version: item.version ?? '' })}
          confirmLabel={t('cap.prereq.action', { id: item.id })}
          onCancel={() => { setState('idle'); }}
          onConfirm={() => { void run(); }}
        />
      ) : null}
    </div>
  );
}
