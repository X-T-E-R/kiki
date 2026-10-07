/**
 * Import history — the built-in surface for bringing old conversations in.
 *
 * This used to live as a sub-view of the plugins market, which read as though
 * importing a conversation were a thing you install a plugin for. It is not:
 * the importers and the archives they write ship with Kiki, and bringing
 * history in is a way of working with sessions. So it sits on the sessions
 * route at `/settings/sessions/import`, and the old plugin address redirects
 * here so an old bookmark still lands on the same surface.
 *
 * Nothing is reimplemented: this is the same `ImportHistoryView` the plugins
 * sub-route rendered, with its own back link to the sessions page rather than
 * to the plugin list, and the same plugin links so a source plugin is still
 * one click away.
 */

import { useNavigate, useSearchParams } from 'react-router-dom';

import { importHistoryPath, installedPluginsPath, pluginSettingsPath, sessionsSettingsPath } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { ImportHistoryView } from '../capabilities/ImportHistoryView';

export function SessionsImportPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  // A source plugin's own "import from here" arrives as a query on this
  // address. The view takes the link as props rather than reading the address
  // itself, so the handoff only works when this page passes them on: dropping
  // them opened the first source instead of the linked one, which looked like a
  // plugin whose link did nothing. Both halves are optional, because an older
  // entry can name only the source id — that still resolves, by wildcard.
  const [params] = useSearchParams();
  const source = params.get('source') ?? undefined;
  const sourcePlugin = params.get('sourcePlugin') ?? undefined;

  return (
    <div className="space-y-4" data-sessions-import-page={importHistoryPath()}>
      <ImportHistoryView
        initialSourceId={source === '' ? undefined : source}
        initialSourcePluginId={sourcePlugin === '' ? undefined : sourcePlugin}
        onOpenPlugin={(pluginId) => { void navigate(pluginSettingsPath(pluginId)); }}
        onOpenSession={(sessionId) => { void navigate(`/s/${sessionId}`); }}
        onBack={() => { void navigate(sessionsSettingsPath()); }}
      />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => { void navigate(installedPluginsPath()); }}
          className="text-[12px] text-ink-faint transition-colors hover:text-ink"
          data-sessions-import-plugins
        >
          {t('st.sessions.importBrowsePlugins')}
        </button>
      </div>
    </div>
  );
}