import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { MAIN_SPACE_ID, currentSpace, useSpaces } from '../../lib/spaces';
import { useSpaceSettingsTarget } from '../../lib/spaceSettings';
import { useConnection } from '../../state/connection';
import { Hint } from '../controls';
import { PortableSpacesCard, type PortableExportRequest } from './spaces/PortableSpacesCard';

/**
 * Settings → Subscriptions (`/settings/subscriptions`).
 *
 * Dedicated top-level page for URL subscriptions, encrypted/archive packs,
 * legacy folder/Git links, and pack export — decoupled from local/remote space
 * topology on `/settings/spaces`.
 */
export function SubscriptionsSection() {
  const { client, localClient, meta, connectionId, sshLabel } = useConnection();
  const host = useHost();
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();

  const inRemotePair = typeof connectionId === 'string' && connectionId !== '';
  const inRemoteScope = inRemotePair || Boolean(sshLabel);
  const controlClient = host.kind === 'tauri' ? localClient : (localClient ?? (inRemoteScope ? null : client));
  const controlTarget = useSpaceSettingsTarget(controlClient, controlClient === client ? meta : undefined);
  const here = currentSpace();
  const localHere = here !== null && !here.homeId.startsWith('remote:') ? here : null;
  const controlSpaces = useSpaces(controlClient);
  const localHomeId = controlTarget?.identity.homeId ?? localHere?.homeId ?? MAIN_SPACE_ID;
  const localSpaceName = localHomeId === MAIN_SPACE_ID
    ? t('st.spaces.main')
    : (localHere?.name ?? controlSpaces.data?.find((item) => item.id === localHomeId)?.name ?? t('sidebar.space.unnamed'));
  const mainSpacePath = controlSpaces.data?.find((item) => item.id === MAIN_SPACE_ID)?.path ?? '';

  const [portableExportRequest, setPortableExportRequest] = useState<PortableExportRequest | null>(null);
  const clearPortableExport = useCallback(() => { setPortableExportRequest(null); }, []);

  // Support cross-page handoff from Spaces row menu (`?exportSpace=<spaceId>`).
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const exportSpaceId = params.get('exportSpace');
    if (exportSpaceId === null || exportSpaceId.trim() === '') return;
    setPortableExportRequest({ intent: 'export', source: { kind: 'live', spaceId: exportSpaceId.trim() } });
    params.delete('exportSpace');
    const nextSearch = params.toString();
    const target = `${location.pathname}${nextSearch === '' ? '' : `?${nextSearch}`}${location.hash}`;
    void navigate(target, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

  return (
    <>
      {inRemoteScope ? (
        <p className="text-[13px] text-ink-soft" data-subscriptions-remote-scope-banner>
          {t('st.spaces.remoteScopeBanner', { space: localSpaceName })}
        </p>
      ) : null}
      {controlClient === null ? (
        <Hint>{t('st.spaces.loading')}</Hint>
      ) : (
        <PortableSpacesCard
          client={controlClient}
          spaces={controlSpaces.data ?? []}
          mainPath={mainSpacePath}
          externalExportRequest={portableExportRequest}
          onClearExternalExport={clearPortableExport}
        />
      )}
    </>
  );
}
