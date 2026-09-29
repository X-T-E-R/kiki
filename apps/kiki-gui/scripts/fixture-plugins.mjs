/**
 * Fixture stand-in for the plugin REST surface beyond list/info/enable
 * (kap-server routes/plugins.ts; contract in the plugin REST contract doc):
 * preview → consent install, rollback, prerequisite install, recommendation
 * match/dismiss, panel list/document/bridge, and plugin skins merged into
 * `/skins`. Failed installs never mutate state.
 *
 * Scenario seeds (all optional):
 *   pluginCandidates: { [source]: { plan, summary, info?, error? } }
 *     plan    — the `PluginInstallPlan` preview returns
 *     summary — the `PluginSummary` install adds (lands disabled)
 *     info    — `PluginInfo` served afterwards from `/plugins/{id}`
 *     error   — `{ code, msg }` preview fails with
 *   pluginRecommendations: [catalog entry id]    — what match returns
 *   pluginPanels: { [pluginId]: [{ id, label, slot, html }] }
 *   pluginSkins:  [{ id: '<plugin>:<theme>', name, variants, plugin: { id, version } }]
 */

function candidateFor(server, source) {
  return server.scenario?.data.pluginCandidates?.[source];
}

function catalogEntry(server, id) {
  return (server.scenario?.data.pluginMarketplace ?? []).find((entry) => entry.id === id);
}

/** Recompute the catalog's install state from the live plugin list. */
export function marketplaceWithState(server) {
  return (server.scenario?.data.pluginMarketplace ?? []).map((entry) => {
    const installed = server.plugins.find((plugin) => plugin.id === entry.id);
    if (installed === undefined) {
      const { installed: _drop, updateAvailable: _update, ...rest } = entry;
      return entry.installed !== undefined && server.pluginsRemoved?.has(entry.id) ? rest : entry;
    }
    return { ...entry, installed: { version: installed.version, enabled: installed.enabled } };
  });
}

export function pluginSkins(server) {
  return (server.scenario?.data.pluginSkins ?? []).filter((skin) =>
    server.plugins.some((plugin) => plugin.id === skin.plugin?.id && plugin.enabled && plugin.state === 'ok'));
}

/** Returns true when the request was handled. */
export function handlePlugins(server, res, path, method, body) {
  if (path === '/plugins:preview' && method === 'POST') {
    const source = String(body?.source ?? '').trim();
    const candidate = candidateFor(server, source);
    if (candidate === undefined) {
      server.envelope(res, null, 40409, `Plugin source not found: ${source}`);
      return true;
    }
    if (candidate.error !== undefined) {
      server.envelope(res, null, candidate.error.code, candidate.error.msg);
      return true;
    }
    server.envelope(res, candidate.plan);
    return true;
  }
  if (path === '/plugins' && method === 'POST' && body?.fingerprint !== undefined) {
    const source = String(body.source ?? '').trim();
    const candidate = candidateFor(server, source);
    if (candidate === undefined || candidate.plan === undefined) {
      server.envelope(res, null, 40409, `Plugin source not found: ${source}`);
      return true;
    }
    if (body.fingerprint !== candidate.plan.fingerprint) {
      server.envelope(res, null, 40001, 'The plugin changed since it was reviewed. Review it again before installing.');
      return true;
    }
    if (candidate.plan.consentRequired && body.consent !== true) {
      server.envelope(res, null, 40001, 'This plugin needs your consent to install.');
      return true;
    }
    const summary = { ...candidate.summary, enabled: false };
    server.plugins = server.plugins.filter((plugin) => plugin.id !== summary.id);
    server.plugins.push(summary);
    if (candidate.info !== undefined) {
      server.scenario.data.pluginInfos ??= {};
      server.scenario.data.pluginInfos[summary.id] = candidate.info;
    }
    server.envelope(res, summary);
    return true;
  }
  const action = /^\/plugins\/([^/]+):(rollback|install-prerequisite|dismiss-recommendation|remove)$/.exec(path);
  if (action !== null && method === 'POST') {
    const id = decodeURIComponent(action[1]);
    const verb = action[2];
    if (verb === 'dismiss-recommendation') {
      server.pluginsDismissed ??= new Set();
      server.pluginsDismissed.add(id);
      server.envelope(res, { ok: true });
      return true;
    }
    const index = server.plugins.findIndex((plugin) => plugin.id === id);
    if (index < 0) {
      server.envelope(res, null, 40419, 'plugin.not_found');
      return true;
    }
    if (verb === 'remove') {
      server.plugins.splice(index, 1);
      server.pluginsRemoved ??= new Set();
      server.pluginsRemoved.add(id);
      server.envelope(res, { ok: true });
      return true;
    }
    if (verb === 'rollback') {
      const plugin = server.plugins[index];
      if (plugin.rollback === undefined) {
        server.envelope(res, null, 40001, 'No previous version to roll back to.');
        return true;
      }
      server.plugins[index] = { ...plugin, version: plugin.rollback.version, rollback: undefined };
      server.envelope(res, { ok: true });
      return true;
    }
    const failing = server.scenario?.data.pluginPrerequisiteFailures?.includes(`${id}:${body?.id}`);
    if (failing === true) {
      server.envelope(res, null, 50001, `Could not download ${body?.id}: the release checksum did not match.`);
      return true;
    }
    server.envelope(res, { ok: true });
    return true;
  }
  if (path === '/plugins/recommendations/match' && method === 'POST') {
    const ids = server.scenario?.data.pluginRecommendations ?? [];
    const entries = ids
      .filter((id) => !server.pluginsDismissed?.has(id) && !server.plugins.some((plugin) => plugin.id === id))
      .map((id) => catalogEntry(server, id))
      .filter((entry) => entry !== undefined && entry.tier !== 'third-party');
    server.envelope(res, { entries });
    return true;
  }
  if (path === '/plugins/panels' && method === 'GET') {
    const panels = Object.entries(server.scenario?.data.pluginPanels ?? {}).flatMap(([pluginId, list]) =>
      server.plugins.some((plugin) => plugin.id === pluginId && plugin.enabled)
        ? list.map((panel) => ({ pluginId, id: panel.id, label: panel.label, slot: panel.slot }))
        : []);
    server.envelope(res, { panels });
    return true;
  }
  const panelDoc = /^\/plugins\/([^/]+)\/panels\/([^/]+)\/(document|bridge)$/.exec(path);
  if (panelDoc !== null) {
    const pluginId = decodeURIComponent(panelDoc[1]);
    const panelId = decodeURIComponent(panelDoc[2]);
    const panel = server.scenario?.data.pluginPanels?.[pluginId]?.find((entry) => entry.id === panelId);
    const enabled = server.plugins.some((plugin) => plugin.id === pluginId && plugin.enabled);
    if (panel === undefined || !enabled) {
      server.envelope(res, null, 40409, 'panel not found');
      return true;
    }
    if (panelDoc[3] === 'document' && method === 'GET') {
      server.envelope(res, { html: panel.html, sandbox: 'allow-scripts' });
      return true;
    }
    if (panelDoc[3] === 'bridge' && method === 'POST') {
      server.pluginBridgeCalls ??= [];
      server.pluginBridgeCalls.push({ pluginId, panelId, body });
      if (body?.method === 'session.summary') {
        server.envelope(res, { result: { id: body.session_id, title: 'Fixture session' } });
      } else if (body?.method === 'session.sendMessage') {
        server.envelope(res, { result: { accepted: true } });
      } else {
        server.envelope(res, { result: null });
      }
      return true;
    }
  }
  return false;
}
