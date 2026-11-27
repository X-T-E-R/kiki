import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  classifyRelayInput,
  generateRelayDeployGuide,
  relayStatusSchema,
  type RelayDeployProxyTarget,
  type RelayNodeLiveStatus,
  type RelayStatus,
} from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { createRelayConnection, type RelayConnection } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import { copyTextToClipboard } from '../../lib/clipboard';
import { FeedbackLine, Hint, Toggle, type Feedback } from '../controls';
import { Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { SettingField, SettingsBox } from './fields';
import { SectionCard } from './SectionCard';

const ROW_ACTION =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent pointer-coarse:h-10';

const ICON_BUTTON =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10';

const EMPTY_RELAY_STATUS: RelayStatus = {
  schemaVersion: 1,
  inboundEnabled: true,
  standbyNodeIds: [],
  nodes: [],
  subscriptions: [],
};

const PROXY_KINDS: readonly { readonly id: RelayDeployProxyTarget; readonly label: string }[] = [
  { id: 'caddy', label: 'Caddy' },
  { id: 'nginx', label: 'Nginx' },
  { id: 'openresty', label: 'OpenResty' },
  { id: 'cloudflare', label: 'Cloudflare' },
];

function nodeLabel(node: RelayNodeLiveStatus): string {
  if (node.label.trim() !== '') return node.label.trim();
  try {
    return new URL(node.url).host;
  } catch {
    return node.url;
  }
}

function statusDotClass(node: RelayNodeLiveStatus): string {
  if (node.connected) return 'bg-success';
  if (node.slot === 'connecting') return 'bg-amber-500';
  if (node.slot === 'error') return 'bg-danger';
  return 'bg-ink-faint';
}

function parsePublicEndpoint(raw: string): { readonly publicHost: string; readonly basePath: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { publicHost: 'relay.example.com', basePath: '/kiki-relay' };
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    const basePath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return { publicHost: parsed.hostname || 'relay.example.com', basePath };
  } catch {
    return { publicHost: 'relay.example.com', basePath: '/kiki-relay' };
  }
}

export function RelayConnectionCard({ targetClient }: { readonly targetClient: KikiClient | null }) {
  const { t, locale } = useI18n();

  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [pluginConn, setPluginConn] = useState<RelayConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const [quickInput, setQuickInput] = useState('');
  const [deployUrl, setDeployUrl] = useState('wss://relay.example.com/kiki-relay');
  const [deployPort, setDeployPort] = useState('9440');
  const [deployProxy, setDeployProxy] = useState<RelayDeployProxyTarget>('caddy');

  const hasNativeRest = typeof targetClient?.requestApiJson === 'function';

  useEffect(() => {
    if (targetClient === null || hasNativeRest) {
      setPluginConn(null);
      return;
    }
    if (targetClient.klient?.global?.plugins === undefined || targetClient.klient?.rest?.plugins === undefined) {
      setPluginConn(null);
      return;
    }
    try {
      setPluginConn(createRelayConnection(targetClient.klient));
    } catch {
      setPluginConn(null);
    }
  }, [targetClient, hasNativeRest]);

  const loadStatus = useCallback(async () => {
    if (targetClient === null) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setReadError(null);
    try {
      if (typeof targetClient.requestApiJson === 'function') {
        const raw = await targetClient.requestApiJson<unknown>('GET', '/remote-connections/relays');
        setStatus(relayStatusSchema.parse(raw));
      } else if (pluginConn !== null) {
        const snap = await pluginConn.read();
        setStatus(snap.state === 'available' ? snap.status : EMPTY_RELAY_STATUS);
      } else {
        setStatus(EMPTY_RELAY_STATUS);
      }
    } catch (err) {
      setReadError(errorText(locale, err));
    } finally {
      setLoading(false);
    }
  }, [targetClient, pluginConn, locale]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const applyRelayRequest = async (
    busyKey: string,
    run: () => Promise<RelayStatus>,
    successText?: string,
  ) => {
    setBusy(busyKey);
    setFeedback(null);
    try {
      const next = await run();
      setStatus(next);
      if (successText !== undefined) {
        setFeedback({ tone: 'success', text: successText });
      }
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    } finally {
      setBusy(null);
    }
  };

  const handleQuickAdd = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (targetClient === null) return;
    const raw = quickInput.trim();
    const classified = classifyRelayInput(raw);
    if (classified.kind === 'invalid') {
      setFeedback({ tone: 'error', text: t('st.conn.relay.inputInvalid') });
      return;
    }
    if (classified.kind === 'subscription-url') {
      await applyRelayRequest(
        'add',
        async () => {
          if (typeof targetClient.requestApiJson === 'function') {
            const res = await targetClient.requestApiJson<unknown>('POST', '/remote-connections/relays/subscriptions', {
              body: { url: classified.url },
            });
            return relayStatusSchema.parse(res);
          }
          if (pluginConn !== null) return pluginConn.addSubscription({ url: classified.url });
          return EMPTY_RELAY_STATUS;
        },
        t('st.conn.relay.addedSubscription'),
      );
      setQuickInput('');
      return;
    }

    const nodeBody = classified.kind === 'share-uri' ? { uri: raw } : { url: classified.url };
    await applyRelayRequest(
      'add',
      async () => {
        if (typeof targetClient.requestApiJson === 'function') {
          const res = await targetClient.requestApiJson<unknown>('POST', '/remote-connections/relays/nodes', {
            body: nodeBody,
          });
          return relayStatusSchema.parse(res);
        }
        if (pluginConn !== null) return pluginConn.addNode(nodeBody);
        return EMPTY_RELAY_STATUS;
      },
      t('st.conn.relay.addedNode'),
    );
    setQuickInput('');
  };

  const handleProbe = async () => {
    if (targetClient === null) return;
    const enabledNodes = (status?.nodes ?? []).filter((node) => node.enabled);
    await applyRelayRequest(
      'probe',
      async () => {
        if (typeof targetClient.requestApiJson === 'function') {
          await Promise.allSettled(
            enabledNodes.map((node) =>
              targetClient.requestApiJson!('POST', '/remote-connections/relays/probe', {
                body: { url: node.url },
              })),
          );
          const refreshed = await targetClient.requestApiJson<unknown>('GET', '/remote-connections/relays');
          return relayStatusSchema.parse(refreshed);
        }
        if (pluginConn !== null) {
          await Promise.allSettled(enabledNodes.map((node) => pluginConn.probe(node.url)));
          return pluginConn.status();
        }
        return status ?? EMPTY_RELAY_STATUS;
      },
      t('st.conn.relay.probed'),
    );
  };

  const handleToggleNodeEnabled = async (node: RelayNodeLiveStatus) => {
    if (targetClient === null) return;
    await applyRelayRequest(`toggle-${node.id}`, async () => {
      if (typeof targetClient.requestApiJson === 'function') {
        const res = await targetClient.requestApiJson<unknown>(
          'PATCH',
          `/remote-connections/relays/nodes/${encodeURIComponent(node.id)}`,
          { body: { enabled: !node.enabled } },
        );
        return relayStatusSchema.parse(res);
      }
      if (pluginConn !== null) return pluginConn.updateNode(node.id, { enabled: !node.enabled });
      return status ?? EMPTY_RELAY_STATUS;
    });
  };

  const handleToggleNodeRole = async (node: RelayNodeLiveStatus) => {
    if (targetClient === null) return;
    const nextRole = node.role === 'backup-only' ? 'auto' : 'backup-only';
    await applyRelayRequest(`role-${node.id}`, async () => {
      if (typeof targetClient.requestApiJson === 'function') {
        const res = await targetClient.requestApiJson<unknown>(
          'PATCH',
          `/remote-connections/relays/nodes/${encodeURIComponent(node.id)}`,
          { body: { role: nextRole } },
        );
        return relayStatusSchema.parse(res);
      }
      if (pluginConn !== null) return pluginConn.updateNode(node.id, { role: nextRole });
      return status ?? EMPTY_RELAY_STATUS;
    });
  };

  const handleRemoveNode = async (nodeId: string) => {
    if (targetClient === null) return;
    await applyRelayRequest(
      `remove-${nodeId}`,
      async () => {
        if (typeof targetClient.requestApiJson === 'function') {
          const res = await targetClient.requestApiJson<unknown>(
            'DELETE',
            `/remote-connections/relays/nodes/${encodeURIComponent(nodeId)}`,
          );
          return relayStatusSchema.parse(res);
        }
        if (pluginConn !== null) return pluginConn.removeNode(nodeId);
        return status ?? EMPTY_RELAY_STATUS;
      },
      t('st.conn.relay.removed'),
    );
  };

  const handleRefreshSub = async (subId: string) => {
    if (targetClient === null) return;
    await applyRelayRequest(
      `sub-refresh-${subId}`,
      async () => {
        if (typeof targetClient.requestApiJson === 'function') {
          const res = await targetClient.requestApiJson<unknown>(
            'POST',
            `/remote-connections/relays/subscriptions/${encodeURIComponent(subId)}/refresh`,
          );
          return relayStatusSchema.parse(res);
        }
        if (pluginConn !== null) return pluginConn.refreshSubscription(subId);
        return status ?? EMPTY_RELAY_STATUS;
      },
      t('st.conn.relay.subRefreshed'),
    );
  };

  const handleRemoveSub = async (subId: string) => {
    if (targetClient === null) return;
    await applyRelayRequest(
      `sub-remove-${subId}`,
      async () => {
        if (typeof targetClient.requestApiJson === 'function') {
          const res = await targetClient.requestApiJson<unknown>(
            'DELETE',
            `/remote-connections/relays/subscriptions/${encodeURIComponent(subId)}`,
          );
          return relayStatusSchema.parse(res);
        }
        if (pluginConn !== null) return pluginConn.removeSubscription(subId);
        return status ?? EMPTY_RELAY_STATUS;
      },
      t('st.conn.relay.removed'),
    );
  };

  const copySnippet = async (value: string) => {
    try {
      await copyTextToClipboard(value);
      setFeedback({ tone: 'success', text: t('st.conn.ext.copied') });
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    }
  };

  const parsedPort = Number.parseInt(deployPort, 10);
  const deployGuide = useMemo(() => {
    const { publicHost, basePath } = parsePublicEndpoint(deployUrl);
    return generateRelayDeployGuide({
      publicHost,
      basePath,
      port: Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 9440,
      proxyTarget: deployProxy,
    });
  }, [deployUrl, parsedPort, deployProxy]);

  const nodeStateText = (node: RelayNodeLiveStatus): string => {
    if (node.rttMs !== undefined) return t('st.conn.relay.rttMs', { ms: Math.round(node.rttMs) });
    if (node.connected) return t('st.conn.relay.state.registered');
    if (node.slot === 'connecting') return t('st.conn.relay.state.connecting');
    if (node.slot === 'disabled') return t('st.conn.relay.state.disabled');
    if (node.slot === 'error') return t('st.conn.relay.state.error');
    return t('st.conn.relay.state.idle');
  };

  const activeNodeRoleText = (node: RelayNodeLiveStatus): string => {
    if (node.slot === 'home') return t('st.conn.relay.role.home');
    if (node.slot === 'standby') return t('st.conn.relay.role.standby');
    if (node.role === 'backup-only') return t('st.conn.relay.role.backup');
    return t('st.conn.relay.role.auto');
  };

  return (
    <SectionCard id="st-card-conn-relay" title={t('st.conn.relay.title')}>
      <div className="space-y-4" data-conn-relay>
        <p className="max-w-[62ch] text-[12.5px] leading-snug text-ink-soft">{t('st.conn.relay.intro')}</p>

        {targetClient === null ? (
          <Hint>{t('st.remote.controlUnavailable')}</Hint>
        ) : loading ? (
          <Hint>{t('st.spaces.loading')}</Hint>
        ) : readError !== null ? (
          <div className="space-y-1">
            <p role="alert" className="max-w-[62ch] text-[12.5px] leading-snug text-danger">{readError}</p>
            <div>
              <button
                type="button"
                onClick={() => { void loadStatus(); }}
                className={ROW_ACTION}
                data-conn-relay-retry
              >
                {t('st.conn.ext.retry')}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <form onSubmit={(event) => { void handleQuickAdd(event); }} data-conn-relay-add-bar>
              <SettingField
                label={t('st.conn.relay.inputLabel')}
                htmlFor="conn-relay-quick-input"
                layout="stack"
                help={t('st.conn.relay.inputHint')}
              >
                <div className="flex items-center gap-2">
                  <input
                    id="conn-relay-quick-input"
                    data-conn-relay-input
                    value={quickInput}
                    spellCheck={false}
                    onChange={(event) => { setQuickInput(event.target.value); }}
                    placeholder="kiki-relay://relay.example.com · https://team.example.com/relays.json"
                    className="min-w-0 flex-1 rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[12px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
                  />
                  <button
                    type="submit"
                    disabled={busy !== null || quickInput.trim() === ''}
                    className={`${SECONDARY_BUTTON} shrink-0`}
                    data-conn-relay-add
                  >
                    {busy === 'add' ? t('st.conn.relay.adding') : t('st.conn.relay.add')}
                  </button>
                  {(status?.nodes.length ?? 0) > 0 ? (
                    <button
                      type="button"
                      onClick={() => { void handleProbe(); }}
                      disabled={busy !== null}
                      className={ICON_BUTTON}
                      title={t('st.conn.relay.probe')}
                      aria-label={t('st.conn.relay.probe')}
                      data-conn-relay-probe
                    >
                      <Icon name="refresh" size={14} />
                    </button>
                  ) : null}
                </div>
              </SettingField>
            </form>

            {status !== null && status.nodes.length === 0 && status.subscriptions.length === 0 ? (
              <p className="text-[12px] text-ink-faint" data-conn-relay-empty>{t('st.conn.relay.empty')}</p>
            ) : null}

            {status !== null && status.nodes.length > 0 ? (
              <SettingsBox data-conn-relay-nodes="">
                {status.nodes.map((node) => {
                  const isManual = node.subscriptionId === undefined;
                  return (
                    <div key={node.id} className="flex flex-wrap items-center justify-between gap-3 py-1" data-conn-relay-node={node.id}>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(node)}`} />
                          <span className="truncate font-normal">{nodeLabel(node)}</span>
                          <span className="text-[12px] text-ink-soft">{nodeStateText(node)}</span>
                          <span className="text-ink-faint" aria-hidden>·</span>
                          <span className="text-[12px] text-ink-soft" data-conn-relay-node-role={node.slot}>
                            {activeNodeRoleText(node)}
                          </span>
                          {!isManual ? (
                            <span className="rounded border border-hairline px-1.5 py-0.5 text-[11px] text-ink-faint">
                              {t('st.conn.relay.sourceSub')}
                            </span>
                          ) : null}
                        </div>
                        <p className="truncate font-mono text-[11.5px] text-ink-faint">{node.url}</p>
                        {node.lastError !== undefined && node.lastError !== '' ? (
                          <p className="break-all text-[11.5px] text-danger">{node.lastError}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {isManual ? (
                          <button
                            type="button"
                            onClick={() => { void handleToggleNodeRole(node); }}
                            disabled={busy !== null}
                            className={ROW_ACTION}
                            data-conn-relay-role-toggle={node.id}
                          >
                            {node.role === 'backup-only' ? t('st.conn.relay.role.backup') : t('st.conn.relay.role.auto')}
                          </button>
                        ) : null}
                        {isManual ? (
                          <Toggle
                            id={`conn-relay-enable-${node.id}`}
                            layout="bare"
                            label={t('st.conn.relay.enabledLabel')}
                            checked={node.enabled}
                            disabled={busy !== null}
                            onChange={() => { void handleToggleNodeEnabled(node); }}
                          />
                        ) : null}
                        {isManual ? (
                          <button
                            type="button"
                            onClick={() => { void handleRemoveNode(node.id); }}
                            disabled={busy !== null}
                            className={ICON_BUTTON}
                            title={t('st.conn.relay.remove')}
                            aria-label={t('st.conn.relay.remove')}
                            data-conn-relay-remove={node.id}
                          >
                            <Icon name="close" size={14} />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </SettingsBox>
            ) : null}

            {status !== null && status.subscriptions.length > 0 ? (
              <SettingsBox data-conn-relay-subscriptions="">
                {status.subscriptions.map((sub) => {
                  const subNodesCount = status.nodes.filter((n) => n.subscriptionId === sub.id).length;
                  return (
                    <div key={sub.id} className="flex items-center justify-between gap-3 py-1" data-conn-relay-sub={sub.id}>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink">
                          <span className="truncate font-normal">{sub.label ?? sub.url}</span>
                          <span className="text-[11.5px] text-ink-soft">
                            {t('st.conn.relay.subCount', { count: subNodesCount })}
                          </span>
                        </div>
                        <p className="truncate font-mono text-[11px] text-ink-faint">{sub.url}</p>
                        {sub.lastError !== undefined && sub.lastError !== '' ? (
                          <p className="break-all text-[11.5px] text-danger">{sub.lastError}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => { void handleRefreshSub(sub.id); }}
                          disabled={busy !== null}
                          className={ICON_BUTTON}
                          title={t('st.conn.ext.refresh')}
                          aria-label={t('st.conn.ext.refresh')}
                          data-conn-relay-sub-refresh={sub.id}
                        >
                          <Icon name="refresh" size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => { void handleRemoveSub(sub.id); }}
                          disabled={busy !== null}
                          className={ICON_BUTTON}
                          title={t('st.conn.relay.remove')}
                          aria-label={t('st.conn.relay.remove')}
                          data-conn-relay-sub-remove={sub.id}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </SettingsBox>
            ) : null}

            <details className="rounded-lg border border-hairline/70 px-3.5 py-2.5" data-conn-relay-deploy>
              <summary
                className="cursor-pointer select-none text-[12.5px] font-normal text-ink-soft hover:text-ink"
                data-conn-relay-deploy-toggle
              >
                {t('st.conn.relay.deployTitle')}
              </summary>
              <div className="mt-3 space-y-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
                  <SettingField label={t('st.conn.relay.deployPublicUrl')} htmlFor="conn-relay-deploy-url" layout="stack">
                    <input
                      id="conn-relay-deploy-url"
                      data-conn-relay-deploy-url
                      value={deployUrl}
                      spellCheck={false}
                      onChange={(event) => { setDeployUrl(event.target.value); }}
                      className="w-full rounded-md bg-ink/[0.04] px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
                    />
                  </SettingField>
                  <SettingField label={t('st.conn.relay.deployPort')} htmlFor="conn-relay-deploy-port" layout="stack">
                    <input
                      id="conn-relay-deploy-port"
                      data-conn-relay-deploy-port
                      value={deployPort}
                      inputMode="numeric"
                      onChange={(event) => { setDeployPort(event.target.value); }}
                      className="w-full rounded-md bg-ink/[0.04] px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
                    />
                  </SettingField>
                </div>

                <SettingField label={t('st.conn.relay.deployDocker')} layout="stack">
                  <div className="flex min-w-0 items-start gap-2">
                    <pre
                      data-conn-relay-deploy-docker
                      className="min-w-0 flex-1 overflow-x-auto rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] text-ink-soft"
                    >
                      {deployGuide.dockerCommand}
                    </pre>
                    <button
                      type="button"
                      onClick={() => { void copySnippet(deployGuide.dockerCommand); }}
                      className={ICON_BUTTON}
                      title={t('connect.copyLink')}
                      aria-label={t('connect.copyLink')}
                      data-conn-relay-copy-docker
                    >
                      <Icon name="copy" size={14} />
                    </button>
                  </div>
                </SettingField>

                <SettingField label={t('st.conn.relay.deployNpx')} layout="stack">
                  <div className="flex min-w-0 items-start gap-2">
                    <pre
                      data-conn-relay-deploy-npx
                      className="min-w-0 flex-1 overflow-x-auto rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] text-ink-soft"
                    >
                      {deployGuide.npxCommand}
                    </pre>
                    <button
                      type="button"
                      onClick={() => { void copySnippet(deployGuide.npxCommand); }}
                      className={ICON_BUTTON}
                      title={t('connect.copyLink')}
                      aria-label={t('connect.copyLink')}
                      data-conn-relay-copy-npx
                    >
                      <Icon name="copy" size={14} />
                    </button>
                  </div>
                </SettingField>

                <SettingField label={t('st.conn.relay.deployProxy')} layout="stack">
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t('st.conn.relay.deployProxy')}>
                      {PROXY_KINDS.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          role="tab"
                          aria-selected={deployProxy === item.id}
                          data-conn-relay-proxy-tab={item.id}
                          onClick={() => { setDeployProxy(item.id); }}
                          className={`${SECONDARY_BUTTON} ${deployProxy === item.id ? 'bg-selected text-selected-ink' : ''}`}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex min-w-0 items-start gap-2">
                      <pre
                        data-conn-relay-deploy-proxy
                        className="min-w-0 flex-1 overflow-x-auto rounded-md bg-ink/[0.04] px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] text-ink-soft"
                      >
                        {deployGuide.proxySnippet}
                      </pre>
                      <button
                        type="button"
                        onClick={() => { void copySnippet(deployGuide.proxySnippet); }}
                        className={ICON_BUTTON}
                        title={t('connect.copyLink')}
                        aria-label={t('connect.copyLink')}
                        data-conn-relay-copy-proxy
                      >
                        <Icon name="copy" size={14} />
                      </button>
                    </div>
                  </div>
                </SettingField>
              </div>
            </details>
          </div>
        )}

        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
