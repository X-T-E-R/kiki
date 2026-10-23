/**
 * 浏览器控制 → the way in. One question, asked in the order a person has to
 * answer it: which browser should Kiki drive, then prepare it, then connect it.
 *
 * The named routes are the server's own (`app/browser/browserSetupService.ts`),
 * read from one `GET /browser/setup`. Every route is described by its own
 * readiness and its own actions, so the page never decides what "installed" or
 * "connected" means — it says what the server reported and offers the action the
 * server listed. A route whose components are all in place does not offer to
 * install them again; a route already connected says so and keeps its way out.
 *
 * Three route shapes exist and the page keeps them apart, because they are not
 * three versions of the same promise:
 *
 *   Kiki-managed  (independent-browser) — Kiki installs a verified driver and its
 *       own browser, then opens one connection. This is the whole flow, and the
 *       two actions are Set up and Connect.
 *   Extension     (kimi-webbridge)     — Kiki installs a plugin and a local
 *       bridge; the store extension is a person's click, so that step is a link
 *       to the store, never a button claiming to have crossed it.
 *   External      (codex-browser)      — another app owns the control surface.
 *       Nothing here is for Kiki to install or connect, so there is no Kiki
 *       button and no connected badge: only the official instructions, placed at
 *       this route's own action.
 *
 * Everything else — a manual CDP address, a hand-picked driver or executable —
 * stays in the advanced region below, for the browser this page cannot set up.
 *
 * The rows are a flat list, not a card wall: the settings page draws its own
 * sections as hairline-separated bands, and three rounded boxes stacked in a
 * column would read as a gallery rather than as three answers to one question.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { isBrowserToolPolicyDenied, isBrowserToolPolicyPartiallyDenied } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { ExternalLink } from '../../../host/ExternalLink';
import { useConnection } from '../../../state/connection';
import {
  blockingStep, browserApi, browserKeys, browserPresetOwnsConnection, browserRealStatus, codexConnectionForPipe, codexConnectionIdForNewPipe,
  presetAction, presetReadiness, runningStep, warningStep, whenText,
  type BrowserSetupStatus, type PresetReadiness, type SourceBrowserItem,
} from '../../../lib/browserRest';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../../controls';
import { Icon } from '../../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { ConfirmDialog } from '../../ConfirmDialog';
import { AdvancedDetails } from '../fields';
import { SettingsSelect } from '../SettingsPrimitives';

const READINESS_TONE: Readonly<Record<PresetReadiness, { text: I18nKey; dot: string }>> = {
  preparing: { text: 'st.browser.route.preparing', dot: 'status-dot-busy bg-ink-soft' },
  'needs-action': { text: 'st.browser.route.needsAction', dot: 'bg-hairline-strong' },
  ready: { text: 'st.browser.route.ready', dot: 'bg-selected-ink' },
  connected: { text: 'st.browser.route.connected', dot: 'bg-success' },
  unsupported: { text: 'st.browser.route.unsupported', dot: 'bg-ink-soft' },
  failed: { text: 'st.browser.route.failed', dot: 'bg-danger' },
  'forced-off': { text: 'st.browser.route.forcedOff', dot: 'bg-danger' },
  blocked: { text: 'st.browser.route.blocked', dot: 'bg-danger' },
  external: { text: 'st.browser.route.external', dot: 'bg-ink-soft' },
};

/**
 * The store a `install_extension` action names. The server sends the URL and the
 * browser it belongs to; the page says which store in its own words so a link
 * never opens a page the reader cannot recognise.
 */
const STORE_TARGET_KEYS: Readonly<Record<string, I18nKey>> = {
  chrome: 'st.browser.store.chrome',
  edge: 'st.browser.store.edge',
  documentation: 'st.browser.store.docs',
};

/**
 * Step ids the page names in its own words, as a phrase that reads after "Still
 * needs …". A step this does not know keeps the server's id rather than being
 * given a sentence it did not earn.
 */
const STEP_KEYS: Readonly<Record<string, I18nKey>> = {
  'daemon-binary': 'st.browser.step.daemonBinary',
  daemon: 'st.browser.step.daemon',
  skill: 'st.browser.step.skill',
  plugin: 'st.browser.step.plugin',
  extension: 'st.browser.step.extension',
  detect: 'st.browser.step.detect',
  compatibility: 'st.browser.step.compatibility',
  feature: 'st.browser.step.feature',
  'desktop-app': 'st.browser.step.desktopApp',
  driver: 'st.browser.step.driver',
  chrome: 'st.browser.step.chrome',
  install: 'st.browser.step.install',
};

/** A sentence about a step is one the page can back, or none at all. */
const REASON_KEYS: Readonly<Record<string, I18nKey>> = {
  feature_disabled: 'st.browser.reason.featureDisabled',
  version_mismatch: 'st.browser.reason.versionMismatch',
  external_app_required: 'st.browser.reason.externalApp',
  connection_conflict: 'st.browser.reason.connectionConflict',
  connection_disabled: 'st.browser.reason.connectionDisabled',
  extension_not_connected: 'st.browser.reason.extensionNotConnected',
  artifact_missing: 'st.browser.reason.artifactMissing',
  artifact_mismatch: 'st.browser.reason.artifactMismatch',
  mismatch: 'st.browser.reason.artifactMismatch',
  choose_connection: 'st.browser.reason.chooseConnection',
  approval_unproven: 'st.browser.reason.approvalUnproven',
  pipe_discovery_failed: 'st.browser.reason.pipeDiscoveryFailed',
  ego_installed: 'st.browser.reason.egoInstalled',
  ego_onboarding: 'st.browser.reason.egoOnboarding',
  ego_choose_cli: 'st.browser.reason.egoChooseCli',
  ego_ready: 'st.browser.reason.egoReady',
  disk_updated: 'st.browser.route.done.updateDisk',
  disk_updated_running_unchanged: 'st.browser.route.done.updateRunningUnchanged',
};

function egoNextKey(preset: BrowserSetupStatus): I18nKey {
  if (preset.state === 'connected') return 'st.browser.reason.egoAdmitted';
  if (preset.reason === 'ego_onboarding') return 'st.browser.reason.egoOnboarding';
  if (preset.reason === 'ego_installed') return 'st.browser.reason.egoInstalled';
  if (preset.reason === 'ego_choose_cli') return 'st.browser.reason.egoChooseCli';
  if (preset.reason === 'ego_ready' || preset.state === 'ready') return 'st.browser.reason.egoReady';
  if (preset.state === 'failed') return 'st.browser.reason.egoFailed';
  return 'st.browser.reason.egoMissing';
}

/** One route. The name is the server's `displayName`; the rest is its own answer. */
function BrowserRoute({ preset, active, onSelect }: {
  readonly preset: BrowserSetupStatus;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const { t, locale } = useI18n();
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState<'prepare' | 'connect' | 'cancel' | 'open' | 'update' | 'shortcut' | 'allow' | 'default' | 'source' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [selectedBrowserId, setSelectedBrowserId] = useState(preset.browserId ?? '');
  const [selectedCliPath, setSelectedCliPath] = useState('');
  useEffect(() => {
    setSelectedBrowserId(preset.browserId ?? '');
  }, [preset.browserId]);
  useEffect(() => {
    setSelectedCliPath((current) => (preset.cliPaths !== undefined && preset.cliPaths.includes(current) ? current : ''));
  }, [preset.cliPaths]);

  const configQuery = useQuery({
    queryKey: ['config', scopeId],
    queryFn: () => client.getConfig(),
    staleTime: 30_000,
  });

  const connectionsQuery = useQuery({
    queryKey: browserKeys.connections(scopeId),
    queryFn: () => browserApi(client).list(),
    staleTime: 10_000,
  });

  const toolPolicyDenied = isBrowserToolPolicyDenied(configQuery.data);
  const toolPolicyPartial = isBrowserToolPolicyPartiallyDenied(configQuery.data);
  const connections = connectionsQuery.data?.connections ?? [];
  const allowedBrowsers = (connectionsQuery.data as { allowedBrowsers?: string[] } | undefined)?.allowedBrowsers
    ?? (configQuery.data as { browser_control?: { allowedBrowsers?: string[] } } | undefined)?.browser_control?.allowedBrowsers;
  const isAllowedConfigured = (connectionsQuery.data as { allowedBrowsersConfigured?: boolean } | undefined)?.allowedBrowsersConfigured === true
    || (configQuery.data as { browser_control?: { allowedBrowsersConfigured?: boolean } } | undefined)?.browser_control?.allowedBrowsersConfigured === true;
  const disabledSources = (connectionsQuery.data as { disabledSources?: string[] } | undefined)?.disabledSources
    ?? (configQuery.data as { browser_control?: { disabledSources?: string[] } } | undefined)?.browser_control?.disabledSources
    ?? [];
  const sourceEnabled = !disabledSources.includes(preset.preset);

  const items: SourceBrowserItem[] = useMemo(() => {
    if (!sourceEnabled) return [];
    const list: SourceBrowserItem[] = [];
    const seenConnectionIds = new Set<string>();
    const allowedFor = (connection: { readonly id: string; readonly enabled?: boolean } | undefined): boolean => {
      if (connection === undefined || connection.enabled === false) return false;
      if (isAllowedConfigured && allowedBrowsers !== undefined) return allowedBrowsers.includes(connection.id);
      return true;
    };

    if (preset.candidates !== undefined && preset.candidates.length > 0) {
      for (const cand of preset.candidates) {
        const conn = preset.preset === 'codex-browser'
          ? codexConnectionForPipe(connections, cand.browserId)
          : connections.find((connection) => connection.id === preset.connectionId && preset.browserId === cand.browserId);
        if (conn !== undefined && seenConnectionIds.has(conn.id)) continue;
        if (conn !== undefined) seenConnectionIds.add(conn.id);
        const namedThisPipe = preset.browserId === cand.browserId;
        const isAllowed = allowedFor(conn);
        const isReady = conn?.status?.state === 'ready' || conn?.status?.state === 'running'
          || (preset.state === 'connected' && namedThisPipe);
        const isAuthUnknown = preset.reason === 'approval_unproven' && namedThisPipe;
        const isLive = conn?.enabled;
        list.push({
          id: conn?.id ?? cand.browserId,
          browserId: cand.browserId,
          source: preset.preset,
          name: conn?.name ?? cand.browserId,
          allowed: isAllowed,
          realStatus: browserRealStatus({
            toolPolicyDenied,
            toolPolicyPartial,
            ready: isReady,
            authUnknown: isAuthUnknown,
            allowed: isAllowed,
            live: isLive,
          }),
          connectionId: conn?.id,
        });
      }
    }

    for (const conn of connections) {
      if (seenConnectionIds.has(conn.id) || !browserPresetOwnsConnection(preset.preset, conn, preset.connectionId)) continue;
      seenConnectionIds.add(conn.id);
      const isAllowed = allowedFor(conn);
      const isReady = conn.status?.state === 'ready' || conn.status?.state === 'running';
      const isLive = conn.enabled;
      list.push({
        id: conn.id,
        browserId: conn.type === 'codex-extension' ? (conn.browserId ?? conn.id) : conn.id,
        source: preset.preset,
        name: conn.name ?? conn.id,
        allowed: isAllowed,
        realStatus: browserRealStatus({
          toolPolicyDenied,
          toolPolicyPartial,
          ready: isReady,
          allowed: isAllowed,
          live: isLive,
        }),
        connectionId: conn.id,
      });
    }

    if (preset.preset === 'ego-lite' && (preset.state === 'ready' || preset.state === 'connected') && list.length === 0) {
      list.push({
        id: 'ego-lite',
        browserId: 'ego-lite',
        source: 'ego-lite',
        name: preset.displayName || 'Ego Lite',
        allowed: false,
        realStatus: browserRealStatus({
          toolPolicyDenied,
          toolPolicyPartial,
          ready: preset.state === 'connected',
          allowed: false,
          live: true,
        }),
        connectionId: undefined,
      });
    }

    return list;
  }, [preset, connections, allowedBrowsers, isAllowedConfigured, sourceEnabled, toolPolicyDenied, toolPolicyPartial]);

  const allowedCountForRoute = items.filter((item) => item.allowed).length;

  const upsertConnectionEnabled = async (existingConn: (typeof connections)[number], nextEnabled: boolean, fallbackBrowserId?: string) => {
    if (existingConn.type === 'agent-browser-profile') {
      await browserApi(client).upsert(existingConn.id, {
        type: 'agent-browser-profile',
        name: existingConn.name,
        enabled: nextEnabled,
        profilePath: existingConn.profilePath,
        executablePath: existingConn.executablePath,
        headed: existingConn.headed,
        driverPath: existingConn.driverPath,
      });
    } else if (existingConn.type === 'agent-browser-cdp') {
      await browserApi(client).upsert(existingConn.id, {
        type: 'agent-browser-cdp',
        name: existingConn.name,
        enabled: nextEnabled,
        endpoint: { action: 'keep' },
        driverPath: existingConn.driverPath,
      });
    } else if (existingConn.type === 'kimi-webbridge') {
      // Allowing or disallowing the route's own connection also sets its switch;
      // the bridge is addressed by nothing, so the write is the common fields only.
      await browserApi(client).upsert(existingConn.id, {
        type: 'kimi-webbridge',
        name: existingConn.name,
        enabled: nextEnabled,
        driverPath: existingConn.driverPath,
      });
    } else if (existingConn.type === 'codex-extension') {
      await browserApi(client).upsert(existingConn.id, {
        type: 'codex-extension',
        name: existingConn.name,
        enabled: nextEnabled,
        runtimeRoot: existingConn.runtimeRoot ?? '',
        browserId: existingConn.browserId ?? fallbackBrowserId ?? existingConn.id,
      });
    } else if (existingConn.type === 'ego-lite') {
      await browserApi(client).upsert(existingConn.id, {
        type: 'ego-lite',
        name: existingConn.name,
        enabled: nextEnabled,
        ...(existingConn.cliPath !== undefined ? { cliPath: existingConn.cliPath } : {}),
        ...(existingConn.profileId !== undefined ? { profileId: existingConn.profileId } : {}),
        ...(existingConn.serverName !== undefined ? { serverName: existingConn.serverName } : {}),
      });
    }
  };

  const handleToggleSource = async (nextSourceEnabled: boolean) => {
    setBusy('source');
    setFeedback(null);
    try {
      const rawAllowed = (connectionsQuery.data as { allowedBrowsers?: string[] } | undefined)?.allowedBrowsers
        ?? (configQuery.data as { browser_control?: { allowedBrowsers?: string[] } } | undefined)?.browser_control?.allowedBrowsers;
      const isConfigured = (connectionsQuery.data as { allowedBrowsersConfigured?: boolean } | undefined)?.allowedBrowsersConfigured === true
        || (configQuery.data as { browser_control?: { allowedBrowsersConfigured?: boolean } } | undefined)?.browser_control?.allowedBrowsersConfigured === true;

      if (!nextSourceEnabled) {
        const preservedAllowed = isConfigured && rawAllowed !== undefined
          ? [...rawAllowed]
          : connections.filter((conn) => conn.enabled).map((conn) => conn.id);
        const nextDisabled = [...new Set([...disabledSources, preset.preset])] as ('kimi-webbridge' | 'independent-browser' | 'codex-browser' | 'ego-lite')[];
        await client.patchConfig({
          browser_control: {
            disabled_sources: nextDisabled,
            ...(!isConfigured ? { allowed_browsers: preservedAllowed } : {}),
          },
        } as import('../../../lib/client').KikiConfigPatch);
      } else {
        const nextDisabled = disabledSources.filter((source) => source !== preset.preset) as ('kimi-webbridge' | 'independent-browser' | 'codex-browser' | 'ego-lite')[];
        await client.patchConfig({
          browser_control: { disabled_sources: nextDisabled },
        } as import('../../../lib/client').KikiConfigPatch);
      }

      await queryClient.invalidateQueries({ queryKey: browserKeys.connections(scopeId) });
      await queryClient.invalidateQueries({ queryKey: browserKeys.presets(scopeId) });
      await queryClient.invalidateQueries({ queryKey: ['config', scopeId] });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(null);
    }
  };

  const handleToggleAllow = async (item: SourceBrowserItem, nextChecked: boolean) => {
    setBusy('allow');
    setFeedback(null);
    try {
      let connectionId = item.connectionId;
      let savedPending = false;
      if (nextChecked && connectionId === undefined) {
        if (preset.preset === 'ego-lite') {
          const created = await browserApi(client).connectPreset('ego-lite', {});
          if ((created.state !== 'ready' && created.state !== 'connected') || created.error !== undefined) {
            setFeedback({ tone: 'error', text: created.error ?? t('st.browser.reason.egoFailed') });
            return;
          }
          connectionId = created.connectionId ?? 'ego-lite';
        } else if (preset.preset === 'codex-browser') {
          const createId = codexConnectionIdForNewPipe(connections, item.browserId);
          if (createId === undefined) {
            setFeedback({ tone: 'error', text: t('st.browser.reason.connectionConflict') });
            return;
          }
          const created = await browserApi(client).connectPreset(preset.preset, {
            connectionId: createId,
            browserId: item.browserId,
          });
          const blocked = created.reason === 'connection_conflict' || created.reason === 'connection_disabled' || created.reason === 'choose_connection';
          savedPending = created.state === 'needs_user_action' && created.reason === 'approval_unproven';
          const usable = (created.state === 'ready' || created.state === 'connected' || savedPending)
            && !blocked && created.error === undefined && created.connectionId !== undefined;
          if (!usable) {
            setFeedback({
              tone: 'error',
              text: created.error ?? (created.reason === 'connection_conflict'
                ? t('st.browser.reason.connectionConflict')
                : t('st.browser.outcome.connectIncomplete')),
            });
            return;
          }
          connectionId = created.connectionId;
        } else {
          setFeedback({ tone: 'error', text: t('st.browser.reason.chooseConnection') });
          return;
        }
      }
      if (connectionId === undefined) return;

      const rawAllowed = (connectionsQuery.data as { allowedBrowsers?: string[] } | undefined)?.allowedBrowsers
        ?? (configQuery.data as { browser_control?: { allowedBrowsers?: string[] } } | undefined)?.browser_control?.allowedBrowsers;
      const isConfigured = (connectionsQuery.data as { allowedBrowsersConfigured?: boolean } | undefined)?.allowedBrowsersConfigured === true
        || (configQuery.data as { browser_control?: { allowedBrowsersConfigured?: boolean } } | undefined)?.browser_control?.allowedBrowsersConfigured === true;
      const known = new Set(connections.map((connection) => connection.id));
      known.add(connectionId);
      const base = (isConfigured && rawAllowed !== undefined
        ? [...rawAllowed]
        : connections.filter((connection) => connection.enabled).map((connection) => connection.id))
        .filter((id) => known.has(id));
      const nextAllowed = nextChecked
        ? [...new Set([...base, connectionId])]
        : base.filter((id) => id !== connectionId);

      await client.patchConfig({
        browser_control: { allowed_browsers: nextAllowed },
      } as import('../../../lib/client').KikiConfigPatch);

      const existingConn = connections.find((connection) => connection.id === connectionId);
      if (existingConn && existingConn.enabled !== nextChecked) {
        await upsertConnectionEnabled(existingConn, nextChecked, item.browserId);
      }

      await queryClient.invalidateQueries({ queryKey: browserKeys.connections(scopeId) });
      await queryClient.invalidateQueries({ queryKey: browserKeys.presets(scopeId) });
      await queryClient.invalidateQueries({ queryKey: ['config', scopeId] });
      if (savedPending) setFeedback({ tone: 'info', text: t('st.browser.route.done.savedApprovalUnproven') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(null);
    }
  };

  const handleDefault = async (connectionId: string, isDefault: boolean) => {
    setBusy('default');
    setFeedback(null);
    try {
      await browserApi(client).setDefault(isDefault ? undefined : connectionId);
      await queryClient.invalidateQueries({ queryKey: browserKeys.connections(scopeId) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(null);
    }
  };

  /** Set by the forced-off line so its fold opens; the fold owns its state. */
  const [openDiagnostics, setDiagnosticsOpen] = useState(false);

  const readiness = presetReadiness(preset);
  const tone = READINESS_TONE[readiness];
  const prepare = presetAction(preset, 'prepare');
  const connect = presetAction(preset, 'connect');
  const cancel = presetAction(preset, 'cancel');
  const openAction = presetAction(preset, 'open');
  const updateAction = presetAction(preset, 'update');
  const shortcutAction = presetAction(preset, 'shortcut');
  const extension = presetAction(preset, 'install_extension');
  const instructions = presetAction(preset, 'open_instructions');
  const running = runningStep(preset);
  const blocking = blockingStep(preset);
  const external = preset.controlSurface === 'external-app';
  const routeActions = preset.preset === 'ego-lite' || !external;
  const step = (id: string): string => t(STEP_KEYS[id] ?? 'st.browser.step.install');
  const reason = (source: BrowserSetupStatus['steps'][number]): string | undefined => {
    if (source.reason === undefined) return undefined;
    const key = REASON_KEYS[source.reason];
    if (key !== undefined) return t(key);
    return source.reason;
  };

  // Three different waits, and each one gets its own line: something Kiki is
  // doing now, something it can install, and something only a person can do
  // (a store approval, the native flag, another app's install).
  const moving = running !== undefined;
  const installable = blocking !== undefined && blocking.state === 'missing';
  // A failed step is the other case where Set up is the next move: something
  // went wrong installing, and offering it again is the repair.
  const repairable = preset.steps.some((item) => item.state === 'failed') || preset.state === 'failed' || preset.error !== undefined;
  // The native flag is enabled by the same consented prepare, so a route whose
  // only gap is the flag still has an in-place action here — and it is the one
  // the reader wants, rather than a trip to another page to find a switch.
  const featureOnly = blocking !== undefined && blocking.id === 'feature' && !installable && !repairable
    && blocking.reason !== 'feature_forced_off';
  // Forced off is not a step this page can take: the server withholds every
  // action, because an environment or runtime override outranks anything
  // consented here. It is reported, never offered.
  const forcedOff = blocking !== undefined && blocking.reason === 'feature_forced_off';
  // Either one, and Set up is the action. A warning is none of these, so a route
  // that is only warned about is not treated as needing an install.
  const canPrepare = installable || repairable || featureOnly;
  // The next move is Set up only when something is missing, something failed,
  // or only the flag is left. Once every installable component is in place,
  // pushing "install" at the reader is the thing this page exists to stop.
  const personOwned = blocking !== undefined && (blocking.state === 'user_action' || blocking.id === 'feature');
  // An external route has no Kiki action left, so "still needs X" would only
  // restate what its own action row already offers — and its reasons are the
  // other app's business, not something this page can move.
  // Forced off already says what is wrong and why, in its own line below.
  // Connected / ready routes do not show blocking lines.
  const needsLine = !external && !forcedOff && readiness !== 'connected' && (installable || personOwned || (blocking !== undefined && blocking.state === 'failed'));
  // Everything Kiki could install is in place and nothing failed: the honest
  // thing to say, and the reason Set up is not on offer. Only a route Kiki
  // itself fills in can be described that way — an external route has no such
  // work, and a forced-off route is not settled at all.
  // When already connected or when blocker/actions already explain what to do, omit repetitive wall text.
  const settled = !external && !moving && !installable && !repairable && !featureOnly && !forcedOff && readiness !== 'connected' && !needsLine;
  // A step the server marked `warning` is not blocking — nothing is missing —
  // but it is the one thing a person should know before trusting the route, so
  // it gets its own line rather than hiding in the diagnostics fold. It is
  // gathered independently of the blocker so a warning ahead of a real
  // blocker does not displace it.
  const warned = warningStep(preset);
  const hasVersionMismatch = preset.steps.some((item) => item.reason === 'version_mismatch') || warned?.reason === 'version_mismatch';
  const offeredExtension = extension;
  const offeredInstructions = instructions?.url;

  const reload = () => queryClient.invalidateQueries({ queryKey: browserKeys.presets(scopeId) });

  const act = async (action: 'prepare' | 'connect' | 'cancel' | 'open' | 'update' | 'shortcut') => {
    setBusy(action);
    setFeedback(null);
    try {
      const api = browserApi(client);
      let res: BrowserSetupStatus | undefined;
      if (action === 'prepare') res = await api.prepare(preset.preset, { consent: true });
      else if (action === 'connect') {
        const choosingCli = preset.cliPaths !== undefined && preset.cliPaths.length > 0;
        const body = choosingCli
          ? { cliPath: selectedCliPath }
          : preset.candidates !== undefined
            ? { connectionId: preset.connectionId ?? (preset.preset === 'codex-browser' ? 'codex-browser' : undefined), browserId: selectedBrowserId || undefined }
            : {};
        res = await api.connectPreset(preset.preset, body);
      }
      else if (action === 'open') res = await api.openPreset(preset.preset, {});
      else if (action === 'update') res = await api.updatePreset(preset.preset, {});
      else if (action === 'shortcut') res = await api.createShortcut(preset.preset, {});
      else res = await api.cancelSetup(preset.preset);
      setConfirming(false);
      await reload();
      // The managed route's connect or open writes a real connection, so the list and
      // the default selector below have to be re-read from the server.
      if ((preset.preset === 'independent-browser' || preset.preset === 'codex-browser' || preset.preset === 'ego-lite') && (action === 'connect' || action === 'open')) {
        await queryClient.invalidateQueries({ queryKey: browserKeys.connections(scopeId) });
      }

      if (action === 'connect' && preset.preset === 'ego-lite' && (
        res?.reason === 'ego_choose_cli' || res?.reason === 'ego_onboarding' || res?.reason === 'ego_installed' || res?.reason === 'ego_ready'
        || res?.state === 'ready' || res?.state === 'connected'
      )) {
        setFeedback(null);
        return;
      }
      if (res?.state === 'failed' || res?.error !== undefined) {
        setFeedback({ tone: 'error', text: res?.error ?? t('st.browser.route.failed') });
        return;
      }
      if (res?.reason === 'connection_disabled') {
        setFeedback({ tone: 'error', text: res?.error ?? t('st.browser.reason.connectionDisabled') });
        return;
      }
      if (action === 'open' && res?.state !== 'connected' && res?.state !== 'ready') {
        setFeedback({ tone: 'error', text: res?.error ?? t('st.browser.route.openFailed') });
        return;
      }
      if (action === 'connect') {
        if (res?.reason === 'approval_unproven' && (res.state === 'needs_user_action' || res.state === 'ready')) {
          setFeedback({ tone: 'info', text: t('st.browser.route.done.savedApprovalUnproven') });
          return;
        }
        if (res?.state !== 'connected' && res?.state !== 'ready') {
          setFeedback({ tone: 'error', text: res?.error ?? t('st.browser.outcome.connectIncomplete') });
          return;
        }
        if (res?.state === 'connected') {
          setFeedback(null);
          return;
        }
      }
      if (action === 'update') {
        if (res?.reason === 'disk_updated_running_unchanged') {
          setFeedback({ tone: 'info', text: t('st.browser.route.done.updateRunningUnchanged') });
        } else if (res?.reason === 'disk_updated') {
          setFeedback({ tone: 'info', text: t('st.browser.route.done.updateDisk') });
        } else {
          setFeedback({ tone: 'info', text: t('st.browser.route.done.update') });
        }
        return;
      }
      setFeedback({ tone: 'info', text: t(`st.browser.route.done.${action}`) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <li
      data-browser-route={preset.preset}
      data-browser-route-state={sourceEnabled ? readiness : 'disabled'}
      data-browser-route-active={active ? 'true' : 'false'}
      data-browser-source-enabled={sourceEnabled ? 'true' : 'false'}
      className={`min-w-0 border-t border-hairline py-3.5 first:border-t-0 first:pt-1 ${active ? 'bg-ink/[0.02]' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <button type="button" data-browser-route-select
          aria-pressed={active}
          onClick={onSelect}
          className="mr-auto min-w-0 text-left text-[14px] font-medium text-ink hover:underline underline-offset-2">
          {preset.displayName}
        </button>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-ink-soft" data-browser-route-readiness={readiness}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${sourceEnabled ? tone.dot : 'bg-hairline-strong'}`} />
          {sourceEnabled ? t(tone.text) : t('st.browser.source.disabled')}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={sourceEnabled}
          aria-label={t('st.browser.source.enable', { name: preset.displayName })}
          data-browser-source-switch={preset.preset}
          disabled={busy !== null}
          onClick={() => { void handleToggleSource(!sourceEnabled); }}
          className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full ring-1 transition-colors duration-[var(--kiki-motion-quick)] ${
            sourceEnabled ? 'bg-selected ring-selected-ink/45' : 'bg-hairline ring-hairline-strong'
          } ${busy !== null ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
        >
          <span
            className={`inline-block h-3 w-3 transform rounded-full transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${
              sourceEnabled ? 'translate-x-[16px] bg-selected-ink' : 'translate-x-[3px] bg-ink-faint'
            }`}
          />
        </button>
      </div>

      {!sourceEnabled ? (
        <>
          <p className="mt-1 text-[12px] text-ink-faint" data-browser-source-disabled-hint={preset.preset}>
            {t('st.browser.source.disabledHint')}
          </p>
          <FeedbackLine feedback={feedback} />
        </>
      ) : (
        <>
          {preset.preset === 'ego-lite' ? (
            <p className="mt-1 max-w-[62ch] text-[12.5px] leading-5 text-ink-soft" data-browser-route-ego-next>
              {t(egoNextKey(preset))}
            </p>
          ) : (
            <p className="mt-1 max-w-[62ch] text-[12.5px] leading-5 text-ink-soft">
              {t(`st.browser.route.blurb.${preset.preset}`)}
            </p>
          )}

          {items.length > 0 ? (
            <div className="mt-2.5 space-y-1.5 rounded border border-hairline bg-surface/40 p-2.5" data-browser-source-items={preset.preset}>
              <div className="flex items-center justify-between text-[12px]">
                <span className="font-medium text-ink">{t('st.browser.allowCheckbox')}</span>
                <span className="text-ink-soft" data-browser-allowed-count={preset.preset}>
                  {t('st.browser.allowedCount', { count: allowedCountForRoute })}
                </span>
              </div>
              <div className="space-y-1 pt-0.5">
                {items.map((item) => {
                  const currentDefault = connectionsQuery.data?.defaultBrowser ?? '';
                  const targetConnId = item.connectionId;
                  const isDefault = targetConnId !== undefined && currentDefault !== '' && currentDefault === targetConnId;
                  return (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded px-2 py-1 text-[12px] hover:bg-ink/[0.03]"
                    >
                      <label className="flex min-w-[8.5rem] flex-1 items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 shrink-0 rounded border-hairline-strong text-selected-ink focus:ring-0 cursor-pointer"
                          data-browser-allow-checkbox={item.id}
                          checked={item.allowed}
                          disabled={busy !== null}
                          onChange={(e) => { void handleToggleAllow(item, e.target.checked); }}
                        />
                        <span className="min-w-0 font-mono text-ink truncate" data-browser-identity={item.browserId}>
                          {item.name || item.browserId}
                        </span>
                        {item.name && item.name !== item.browserId ? (
                          <span className="hidden min-w-0 font-mono text-[11px] text-ink-faint truncate sm:inline">
                            {item.browserId}
                          </span>
                        ) : null}
                        <span className="hidden shrink-0 rounded bg-ink/[0.05] px-1.5 py-0.5 text-[10px] text-ink-soft sm:inline" data-browser-source-tag={item.source}>
                          {item.source}
                        </span>
                      </label>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {targetConnId !== undefined && (item.allowed || isDefault) ? (
                          <button
                            type="button"
                            data-browser-default-star={targetConnId}
                            aria-pressed={isDefault}
                            aria-label={t('st.browser.defaultLabel')}
                            disabled={busy !== null}
                            onClick={() => { void handleDefault(targetConnId, isDefault); }}
                            className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                              isDefault
                                ? 'bg-selected text-selected-ink font-medium'
                                : 'text-ink-faint hover:bg-ink/[0.05] hover:text-ink-soft'
                            }`}
                          >
                            {isDefault ? t('st.browser.defaultActive') : t('st.browser.setDefaultAction')}
                          </button>
                        ) : null}
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            item.realStatus === 'ready'
                              ? 'bg-success/10 text-success'
                              : item.realStatus === 'denied'
                                ? 'bg-danger/10 text-danger'
                                : item.realStatus === 'partial'
                                  ? 'bg-amber-ink/10 text-amber-ink'
                                  : item.realStatus === 'auth_unknown'
                                    ? 'bg-amber-ink/10 text-amber-ink'
                                    : item.realStatus === 'allowed'
                                      ? 'bg-selected-ink/10 text-selected-ink'
                                      : 'bg-ink/[0.05] text-ink-soft'
                          }`}
                          data-browser-status-tag={item.realStatus}
                        >
                          {t(`st.browser.status.${
                            item.realStatus === 'auth_unknown' ? 'authUnknown' : item.realStatus
                          }`)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {moving ? (
            <p role="status" className="mt-2 flex items-baseline gap-2 text-[12px] text-ink-soft" data-browser-route-progress={running.id}>
              <span>{t('st.browser.route.installing', { step: step(running.id) })}</span>
              {running.percent === undefined ? null : (
                <span className="font-mono tabular-nums text-ink-faint">{Math.round(running.percent)}%</span>
              )}
            </p>
          ) : null}

          {needsLine ? (
            <p className="mt-2 max-w-[62ch] text-[12px] leading-[18px] text-ink-soft" data-browser-route-blocker={blocking.id}>
              {t('st.browser.route.blocking', { step: step(blocking.id) })}
              {reason(blocking) === undefined ? '' : ` ${reason(blocking)}`}
            </p>
          ) : null}

          {forcedOff ? (
            <p className="mt-2 max-w-[62ch] text-[12px] leading-[18px] text-danger" data-browser-route-forced-off>
              {t('st.browser.reason.forcedOff', { step: step(blocking.id) })}
              {blocking.detail === undefined ? null : (
                <>
                  {' '}
                  <button type="button" className="text-ink-soft underline underline-offset-2"
                    data-browser-route-forced-off-cause
                    onClick={() => { setDiagnosticsOpen(true); }}>
                    {t('st.browser.reason.forcedOffCause')}
                  </button>
                </>
              )}
            </p>
          ) : null}
          {settled ? (
            <p className="mt-2 max-w-[62ch] text-[12px] leading-[18px] text-ink-faint" data-browser-route-settled>
              {t('st.browser.route.alreadyInstalled')}
            </p>
          ) : null}

          {warned === undefined ? null : (
            <p className="mt-2.5 max-w-[62ch] border-l-2 border-amber-ink/45 pl-2.5 text-[12px] leading-[18px] text-amber-ink"
              data-browser-route-warning={warned.id}>
              {t('st.browser.route.warning', { step: step(warned.id) })}
              {reason(warned) === undefined ? '' : ` ${reason(warned)}`}
            </p>
          )}

          {preset.error === undefined ? null : (
            <p role="alert" className="mt-2 max-w-[72ch] break-words text-[12px] leading-[18px] text-danger" data-browser-route-error>
              {preset.error}
            </p>
          )}

          {preset.candidates !== undefined ? (
            <div className="mt-2.5 space-y-1.5" data-browser-candidates-region>
              {preset.candidates.length === 0 ? (
                <p className="text-[12px] leading-[18px] text-ink-soft" data-browser-candidates-empty>
                  {t('st.browser.candidates.empty')}
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={`candidate-select-${preset.preset}`} className="text-[12px] font-medium text-ink-soft shrink-0">
                    {t('st.browser.candidates.label')}
                  </label>
                  <div className="min-w-[240px] max-w-full">
                    <SettingsSelect
                      id={`candidate-select-${preset.preset}`}
                      ariaLabel={t('st.browser.candidates.label')}
                      dataAttr="data-browser-candidate-select"
                      choices={preset.candidates.map((c) => ({
                        value: c.browserId,
                        label: c.browserId,
                      }))}
                      value={selectedBrowserId}
                      emptyText={t('st.browser.candidates.placeholder')}
                      onChange={(val) => { setSelectedBrowserId(val); }}
                      disabled={busy !== null}
                      variant="row"
                      mono
                    />
                  </div>
                  {selectedBrowserId !== (preset.browserId ?? '') ? (
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      data-browser-candidate-cancel
                      disabled={busy !== null}
                      onClick={() => { setSelectedBrowserId(preset.browserId ?? ''); }}
                    >
                      {t('st.browser.route.cancelSelection')}
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {preset.cliPaths !== undefined && preset.cliPaths.length > 0 ? (
            <div className="mt-2.5 space-y-1.5" data-browser-cli-paths>
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="ego-cli-select" className="text-[12px] font-medium text-ink-soft shrink-0">
                  {t('st.browser.fieldCliPath')}
                </label>
                <div className="min-w-0 max-w-full flex-1 sm:min-w-[240px] sm:flex-none">
                  <SettingsSelect
                    id="ego-cli-select"
                    ariaLabel={t('st.browser.fieldCliPath')}
                    dataAttr="data-browser-cli-select"
                    choices={preset.cliPaths.map((cliPath) => ({ value: cliPath, label: cliPath }))}
                    value={selectedCliPath}
                    emptyText={t('st.browser.route.egoCliPlaceholder')}
                    onChange={(cliPath) => { setSelectedCliPath(cliPath); }}
                    disabled={busy !== null}
                    variant="row"
                    mono
                  />
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
            {!routeActions || prepare === undefined || busy !== null || moving || readiness === 'connected' || !canPrepare ? null : (
              <button type="button"
                className={openAction !== undefined && readiness === 'ready' ? SECONDARY_BUTTON : PRIMARY_BUTTON}
                data-browser-route-prepare
                disabled={busy !== null}
                onClick={() => { setConfirming(true); }}>
                {busy === 'prepare' ? t('st.browser.route.preparing')
                  : featureOnly ? t('st.browser.route.turnOn') : t('st.browser.route.prepare')}
              </button>
            )}
            {!routeActions || openAction === undefined || (readiness !== 'ready' && readiness !== 'connected' && preset.state !== 'failed' && preset.error === undefined) || busy !== null ? null : (
              <button type="button" className={PRIMARY_BUTTON} data-browser-route-open
                disabled={busy !== null}
                onClick={() => { void act('open'); }}>
                {busy === 'open' ? t('st.browser.route.opening') : t('st.browser.route.open')}
              </button>
            )}
            {!routeActions || connect === undefined || (readiness !== 'ready' && preset.state !== 'needs_user_action' && preset.state !== 'failed' && preset.error === undefined) || busy !== null ? null : (
              <button type="button" className={openAction !== undefined ? SECONDARY_BUTTON : PRIMARY_BUTTON} data-browser-route-connect
                disabled={busy !== null || (preset.candidates !== undefined && (!selectedBrowserId || selectedBrowserId === '')) || (preset.cliPaths !== undefined && preset.cliPaths.length > 0 && selectedCliPath === '')}
                onClick={() => { void act('connect'); }}>
                {busy === 'connect' ? t('st.browser.route.connecting')
                  : preset.preset === 'ego-lite' ? t('st.browser.route.checkEgo')
                    : preset.candidates !== undefined ? t('st.browser.route.saveConnection') : t('st.browser.route.connect')}
              </button>
            )}
            {hasVersionMismatch && updateAction !== undefined ? (
              <button type="button" className={SECONDARY_BUTTON} data-browser-route-update
                disabled={busy !== null}
                onClick={() => { void act('update'); }}>
                {busy === 'update' ? t('st.browser.route.updating') : t('st.browser.route.update')}
              </button>
            ) : null}
            {readiness === 'connected' ? (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-success" data-browser-route-connected>
                <Icon name="check" size={12} />
                {t('st.browser.route.connectedAt', { at: whenText(locale, preset.checkedAt) ?? t('st.browser.route.connectedNow') })}
              </span>
            ) : null}
            {cancel === undefined || busy !== null ? null : (
              <button type="button" className={SECONDARY_BUTTON} data-browser-route-cancel
                onClick={() => { void act('cancel'); }}>
                {t('st.browser.route.cancel')}
              </button>
            )}
            {offeredExtension?.url === undefined ? null : (
              <ExternalLink className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`} href={offeredExtension.url}
                data-browser-route-extension={offeredExtension.target ?? 'chrome'}>
                <Icon name="external" size={12} />
                {t('st.browser.route.addExtension', { store: t(STORE_TARGET_KEYS[offeredExtension.target ?? ''] ?? 'st.browser.store.chrome') })}
              </ExternalLink>
            )}
            {offeredInstructions === undefined ? null : (
              <ExternalLink className="inline-flex items-center gap-1 text-[12px] text-selected-ink hover:underline" href={offeredInstructions}
                data-browser-route-instructions>
                {preset.preset === 'ego-lite' ? t('st.browser.route.downloadEgo') : t('st.browser.route.instructions')}
              </ExternalLink>
            )}
          </div>

          {preset.checkedAt === undefined ? null : (
            <p className="mt-2 text-[11px] text-ink-faint" data-browser-route-checked>
              {t('st.browser.route.checkedAt', { at: whenText(locale, preset.checkedAt) ?? '' })}
            </p>
          )}

          <FeedbackLine feedback={feedback} />

          {(updateAction !== undefined || shortcutAction !== undefined) ? (
            <AdvancedDetails summary={t('st.browser.route.advanced')} data-browser-route-advanced>
              <div className="flex flex-col gap-2 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  {updateAction === undefined || hasVersionMismatch ? null : (
                    <button type="button" className={SECONDARY_BUTTON} data-browser-route-update
                      disabled={busy !== null}
                      onClick={() => { void act('update'); }}>
                      {busy === 'update' ? t('st.browser.route.updating') : t('st.browser.route.update')}
                    </button>
                  )}
                  {shortcutAction === undefined ? null : (
                    <button type="button" className={SECONDARY_BUTTON} data-browser-route-shortcut
                      disabled={busy !== null}
                      onClick={() => { void act('shortcut'); }}>
                      {busy === 'shortcut' ? t('st.browser.route.creatingShortcut') : t('st.browser.route.shortcut')}
                    </button>
                  )}
                </div>
                {shortcutAction === undefined ? null : (
                  <p className="text-[11px] text-ink-faint">
                    {preset.executionHost === 'local' || preset.executionHost === '127.0.0.1' || preset.executionHost === 'localhost'
                      ? t('st.browser.route.shortcutHostLocal')
                      : t('st.browser.route.shortcutHostRemote', { host: preset.executionHost })}
                  </p>
                )}
              </div>
            </AdvancedDetails>
          ) : null}

          {preset.steps.every((item) => item.detail === undefined) ? null : (
            <AdvancedDetails summary={t('st.browser.route.diagnostics')} data-browser-route-diagnostics
              open={openDiagnostics || undefined}
              onToggle={(event) => { setDiagnosticsOpen((event.currentTarget as HTMLDetailsElement).open); }}>
              <dl className="space-y-1.5">
                {preset.steps.map((item) => (
                  <div key={item.id} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                    <dt className="text-ink-faint">{step(item.id)}</dt>
                    <dd className="min-w-0 text-ink-soft">
                      {t(`st.browser.stepState.${item.state}`)}
                      {item.reason === undefined ? '' : ` · ${item.reason}`}
                      {item.detail === undefined ? '' : <span className="block text-ink-faint">{item.detail}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="font-mono text-ink-faint break-all" data-browser-route-source>{preset.sourceUrl}</p>
              <p className="text-ink-faint">
                {t('st.browser.route.hostLine')} <span className="font-mono break-all">{preset.executionHost}</span>
              </p>
            </AdvancedDetails>
          )}
        </>
      )}

      <ConfirmDialog open={confirming} overlayId={`confirm-browser-prepare-${preset.preset}`}
        title={t('st.browser.route.confirmTitle', { name: preset.displayName })}
        body={t('st.browser.route.confirmBody')}
        consequences={[
          t('st.browser.route.consequenceHost', { host: preset.executionHost }),
          ...(preset.skill === undefined ? [] : [t('st.browser.route.consequencePlugin', { name: preset.skill })]),
          // The consent covers switching browser control on, so it is listed as
          // a consequence rather than left to a sentence the reader has to
          // notice. The server only reports a `feature` step while the flag is
          // still off, so its absence is the signal that there is nothing to
          // enable — and the dialog never opens with no button behind it.
          ...(preset.steps.some((item) => item.id === 'feature') ? [t('st.browser.route.consequenceFeature')] : []),
          ...(preset.connectionId === undefined ? [] : [t('st.browser.route.consequenceConnection', { name: preset.connectionId })]),
        ]}
        confirmLabel={t('st.browser.route.prepare')}
        onCancel={() => { setConfirming(false); }}
        onConfirm={() => { void act('prepare'); }} />
    </li>
  );
}

/**
 * The wizard: the named routes first, in the order a reader can finish them,
 * and the advanced region — the things a person fills in only when none of the
 * routes is what they want — last.
 */
export function BrowserSetupWizard() {
  const { client, scopeId, sshLabel } = useConnection();
  const { t } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);

  const query = useQuery({
    queryKey: browserKeys.presets(scopeId),
    queryFn: () => browserApi(client).setupPresets(),
    staleTime: 5_000,
    // The store approval happens in another window: the reader leaves for it,
    // comes back, and the row has to show the extension as connected. The app
    // turns focus refetch off globally, so this opts back in the way
    // `useSessionSshHosts` does for the same leave-and-return shape — one
    // re-read when the window regains focus and the data is stale, not a timer.
    refetchOnWindowFocus: true,
    // Only a preparation that is actually running is worth polling for; a
    // settled route is re-read on demand instead of on a timer forever.
    refetchInterval: (result) => result.state.data?.presets.some((preset) => preset.state === 'preparing') === true ? 1_500 : false,
  });

  const presets = query.data?.presets ?? [];
  const external = presets.filter((preset) => preset.controlSurface === 'external-app');
  const managed = presets.filter((preset) => preset.controlSurface !== 'external-app');
  // Preselect the route that is already furthest along, so a reader who came
  // back to a working setup lands on it rather than on the first row.
  const chosen = presets.find((preset) => preset.preset === picked)
    ?? managed.find((preset) => presetReadiness(preset) === 'connected' || presetReadiness(preset) === 'ready')
    ?? managed[0]
    ?? presets[0];

  return (
    <div className="space-y-3" data-browser-setup>
      <Hint>
        {sshLabel === null
          ? t('st.browser.setup.host')
          : t('st.browser.setup.hostSsh', { label: sshLabel })}
      </Hint>

      {query.isPending ? (
        <p role="status" className="text-[12px] text-ink-faint">{t('st.browser.setup.detecting')}</p>
      ) : query.isError ? (
        <div className="space-y-2">
          <InlineError error={query.error} />
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { void query.refetch(); }}>{t('common.retry')}</button>
        </div>
      ) : presets.length === 0 ? (
        <Hint>{t('st.browser.route.none')}</Hint>
      ) : (
        <>
          <ul className="divide-y divide-hairline" data-browser-routes>
            {managed.map((preset) => (
              <BrowserRoute key={preset.preset} preset={preset} active={chosen?.preset === preset.preset}
                onSelect={() => { setPicked(preset.preset); }} />
            ))}
          </ul>
          {external.length === 0 ? null : (
            <>
              <p className="pt-1 text-[12px] font-medium text-ink-faint" data-browser-routes-external-label>
                {t('st.browser.route.otherApps')}
              </p>
              <ul className="divide-y divide-hairline" data-browser-routes-external>
                {external.map((preset) => (
                  <BrowserRoute key={preset.preset} preset={preset} active={false} onSelect={() => {}} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
