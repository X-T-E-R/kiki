import { useContext, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import { sortWorkspacesByRecency } from '@kiki/session-core/sessions';
import { useI18n } from '../../../i18n';
import { pickWorkspace } from '../../../lib/capabilities';
import type { PluginOrigin } from '../../../lib/pluginCatalog';
import { useConnection } from '../../../state/connection';
import { useInstalledPlugins } from '../../capabilities/usePlugins';
import { SettingsCardMountContext, SettingsFlashContext } from '../SectionCard';
import { SettingsLoadFailure, TEXT_BUTTON } from '../SettingsPrimitives';

export const ORIGIN_KEYS = {
  official: 'cap.origin.official',
  catalog: 'cap.origin.catalog',
  local: 'cap.origin.local',
  git: 'cap.origin.git',
  zip: 'cap.origin.zip',
} as const satisfies Record<PluginOrigin, string>;

const ZOD_ISSUE_SHAPE = /"code"\s*:\s*"(invalid_type|too_small|too_big|invalid_enum_value|unrecognized_keys?)"/;

function parseFailureDetail(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'ZodError' && Array.isArray((error as { issues?: unknown }).issues)) {
    const first = ((error as { issues: readonly { path?: readonly unknown[]; message?: string }[] }).issues)[0];
    const path = first?.path !== undefined && first.path.length > 0 ? first.path.map(String).join('.') : undefined;
    if (path !== undefined && first?.message !== undefined) return `${path}: ${first.message}`;
    return first?.message ?? path ?? 'ZodError';
  }
  if (error instanceof SyntaxError) return error.message || 'SyntaxError';
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (ZOD_ISSUE_SHAPE.test(raw)) return raw.slice(0, 140);
  return undefined;
}

/**
 * Extensions & tools summary line (`#st-card-plugins`): counts installed
 * plugins and skills and links once to `/capabilities`, where installed objects
 * live. Announces `st-card-plugins` to `SettingsCardMountContext` so settings
 * search hits and `#st-card-plugins` / `#st-card-skill-catalog` bookmarks land
 * here cleanly.
 */
export function InstalledPluginsList() {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const [searchParams] = useSearchParams();
  const flashId = useContext(SettingsFlashContext);
  const onCardMount = useContext(SettingsCardMountContext);

  useEffect(() => {
    onCardMount?.('st-card-plugins');
  }, [onCardMount]);

  const pluginsQuery = useInstalledPlugins();
  const workspacesQuery = useQuery({
    queryKey: ['workspaces', 'catalog'],
    queryFn: () => client.listWorkspaceCatalog(),
    staleTime: 30_000,
  });
  const sorted = useMemo(
    () => sortWorkspacesByRecency(workspacesQuery.data?.items ?? []),
    [workspacesQuery.data],
  );
  const workspace = pickWorkspace(sorted, searchParams.get('workspace') ?? undefined);
  const workspaceId = workspace?.id ?? '';
  const skillsQuery = useQuery({
    queryKey: ['workspace-skills', workspaceId],
    queryFn: () => client.listWorkspaceSkills(workspaceId),
    enabled: workspaceId !== '',
    staleTime: 60_000,
  });

  const pluginCount = pluginsQuery.data?.plugins.length ?? 0;
  const skillCount = skillsQuery.data?.skills.length ?? 0;
  const parseDetail = pluginsQuery.isError ? parseFailureDetail(pluginsQuery.error) : undefined;

  return (
    <div
      id="st-card-plugins"
      data-settings-card="st-card-plugins"
      data-extensions-summary
      className={`scroll-mt-4 ${flashId === 'st-card-plugins' ? 'settings-card-flash' : ''}`}
    >
      {pluginsQuery.isError ? (
        <div data-plugins-installed-error>
          <SettingsLoadFailure
            message={parseDetail !== undefined
              ? t('st.plugins.loadInvalid', { detail: parseDetail })
              : t('st.plugins.loadFailed', { detail: errorText(locale, pluginsQuery.error) })}
            retrying={pluginsQuery.isFetching}
            onRetry={() => { void pluginsQuery.refetch(); }}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-ink-soft">
          <span data-extensions-installed-counts>
            {t('st.extensions.installedSummary', { plugins: pluginCount, skills: skillCount })}
          </span>
          <Link to="/capabilities" className={TEXT_BUTTON} data-extensions-open-capabilities>
            {t('st.extensions.openCapabilities')}
          </Link>
        </div>
      )}
    </div>
  );
}
