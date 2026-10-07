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
    // Like the real manager: a new plugin lands off, a reinstall keeps its switch.
    const existing = server.plugins.find((plugin) => plugin.id === candidate.summary.id);
    const summary = { ...candidate.summary, enabled: existing?.enabled ?? false };
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
  // Plugin-owned settings: GET returns the declared form and plain values;
  // secret values are only listed as configured, exactly like kap-server.
  const settingsMatch = /^\/plugins\/([^/]+)\/settings$/.exec(path);
  if (settingsMatch !== null) {
    const pluginId = decodeURIComponent(settingsMatch[1]);
    server.pluginSettings ??= structuredClone(server.scenario?.data.pluginSettings ?? {});
    const view = server.pluginSettings[pluginId] ?? { values: {}, secretsConfigured: [] };
    if (method === 'POST') {
      // A scenario can make one package's settings refuse, so a save that did
      // not land is observable rather than assumed impossible. The GET keeps
      // answering normally either way — which is exactly why a refused write
      // cannot be told from a good one by reading values back.
      const refusal = server.scenario?.data.pluginSettingsRefusals?.[pluginId];
      if (refusal !== undefined) {
        server.envelope(res, null, refusal.code ?? 40001, refusal.message ?? 'the host refused this write');
        return true;
      }
      const properties = view.schema?.schema?.properties ?? {};
      const values = { ...view.values };
      const secrets = new Set(view.secretsConfigured);
      for (const [key, value] of Object.entries(body?.values ?? {})) {
        if (properties[key]?.secret === true) { value === null ? secrets.delete(key) : secrets.add(key); continue; }
        if (value === null) delete values[key]; else values[key] = value;
      }
      server.pluginSettings[pluginId] = { ...view, values, secretsConfigured: [...secrets] };
    }
    server.envelope(res, server.pluginSettings[pluginId] ?? view);
    return true;
  }
  return false;
}

/**
 * Plugin usage — the four-level answer (home → global → workspace → session).
 *
 * A scenario seeds `pluginUsage` as a map of target key → rows; the rows are
 * echoed with the target the request actually asked for, so a screenshot shows
 * the same fields the server sends rather than a shape invented here. A
 * `pluginUsageRefusals` entry makes one write answer unsupported, which is how
 * the "this server does not offer it" path is observed rather than assumed.
 */
export function handlePluginUsage(server, res, path, method, body, query) {
  if (!path.startsWith('/plugins/usage')) return false;
  const rows = server.scenario?.data.pluginUsage;
  if (rows === undefined) {
    server.envelope(res, null, 40012, 'unsupported procedure');
    return true;
  }
  // A write names its target in the body and a read in the query, exactly as
  // the real route does, so both have to be read from wherever they arrived.
  const bodySessionId = body?.target?.session_id;
  const bodyWorkspaceId = body?.target?.workspace_id;
  const sessionId = query?.get('session_id') ?? (typeof bodySessionId === 'string' ? bodySessionId : null);
  const workspaceKey = query?.get('workspace_id')
    ?? (typeof bodyWorkspaceId === 'string' ? bodyWorkspaceId : null);
  const key = sessionId !== undefined && sessionId !== null && sessionId !== '' ? `session:${sessionId}` : workspaceKey;
  const scoped = rows[key] ?? rows.default ?? { workspace_name: 'Fixture workspace', workspace_root: 'C:/work/fixture', plugins: [] };

  if (path === '/plugins/usage' && method === 'GET') {
    server.envelope(res, {
      home_id: 'fixture-home',
      target: {
        workspace_id: scoped.workspace_id ?? workspaceKey ?? 'ws-fixture',
        name: scoped.workspace_name ?? 'Fixture workspace',
        root: scoped.workspace_root ?? 'C:/work/fixture',
        ...(sessionId !== undefined && sessionId !== null && sessionId !== '' ? { session_id: sessionId } : {}),
      },
      revision: server.pluginUsageRevision ?? 1,
      apply_state: scoped.apply_state ?? 'applied',
      errors: scoped.errors ?? [],
      plugins: scoped.plugins ?? [],
    });
    return true;
  }
  if (path === '/plugins/usage' && method === 'PUT' || path === '/plugins/usage' && method === 'POST') {
    const pluginId = String(body?.plugin_id ?? '');
    const override = body?.override;
    const refusal = server.scenario?.data.pluginUsageRefusals?.[`${key}:${pluginId}`];
    if (refusal !== undefined) {
      server.envelope(res, null, refusal.code ?? 40001, refusal.message ?? 'the host refused this write');
      return true;
    }
    const target = rows[key];
    if (target === undefined) return false;
    const plugin = (target.plugins ?? []).find((entry) => entry.id === pluginId);
    if (plugin === undefined) {
      server.envelope(res, null, 40409, `plugin not found: ${pluginId}`);
      return true;
    }
    if (sessionId !== undefined && sessionId !== null && sessionId !== '') plugin.session_override = override;
    else plugin.override = override;
    // The effective answer follows the write, which is what makes the row's
    // optimistic value converge instead of snapping back.
    const homeOff = plugin.home_enabled === false;
    plugin.effective = homeOff ? false : override === 'on';
    if (override === 'off') plugin.reason = sessionId !== undefined && sessionId !== null && sessionId !== '' ? 'session_disabled' : 'workspace_disabled';
    else delete plugin.reason;
    server.pluginUsageRevision = (server.pluginUsageRevision ?? 1) + 1;
    server.envelope(res, {
      home_id: 'fixture-home',
      target: {
        workspace_id: target.workspace_id ?? workspaceKey ?? 'ws-fixture',
        name: target.workspace_name ?? 'Fixture workspace',
        root: target.workspace_root ?? 'C:/work/fixture',
        ...(sessionId !== undefined && sessionId !== null && sessionId !== '' ? { session_id: sessionId } : {}),
      },
      revision: server.pluginUsageRevision,
      apply_state: 'applied',
      errors: [],
      plugins: target.plugins ?? [],
    });
    return true;
  }
  return false;
}
