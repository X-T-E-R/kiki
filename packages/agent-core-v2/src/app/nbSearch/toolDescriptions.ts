import type { NbSearchCapabilities } from './nbSearch';

const MISMATCH_PREFIX = 'MANAGED_CREDENTIALS_MISMATCH:';

export function formatManagedCredentialMismatchHint(issues: readonly string[] | undefined): string {
  if (issues === undefined || issues.length === 0) return '';
  const slots = issues
    .filter((issue) => issue.startsWith(MISMATCH_PREFIX))
    .map((issue) => issue.slice(MISMATCH_PREFIX.length))
    .filter((slot) => slot.length > 0);
  if (slots.length === 0) return '';
  return `Managed credential binding mismatch for slot(s): ${slots.join(', ')} (stored gui-credentials.json fingerprint no longer matches current config/base_url). Re-save the API key in Settings -> Search & Fetch, or configure a same-origin [providers.<id>] API key.`;
}

export function describeCapabilities(capabilities: NbSearchCapabilities): { expiresAt: number; search: string; fetch: string } {
  const now = Date.now();
  const header = 'Capability snapshot (availability reflects the last successful probe, not a live provider health check). Native nb-search runtime; no Skill or CLI prerequisite.';
  const available = capabilities.config_source?.availability !== 'unavailable';
  const issues = capabilities.config_source?.issues;
  const sourceStatus = available ? '' : `Configuration source unavailable: ${issues !== undefined && issues.length > 0 ? issues.join(', ') : 'unknown configuration issue'}.`;
  const mismatchWarning = available ? formatManagedCredentialMismatchHint(issues) : '';
  const lanes = available ? capabilities.search.lanes.filter((lane) => lane.availability === 'ready') : [];
  const defaultLane = capabilities.search.default_lane;
  const search = [header, sourceStatus, mismatchWarning,
    defaultLane === undefined ? 'Default search lane: not configured. Select an available lane or preset explicitly.' : `Configured default search lane: ${defaultLane} (${lanes.some((lane) => lane.id === defaultLane && lane.execution_modes.includes('sync')) ? 'ready for sync' : 'unavailable for sync'}).`,
    'Explicit lane/lanes/preset selection overrides the default. Invalid or unavailable selections fail without switching providers.',
    'Available search lanes:',
    ...lanes.map((lane) => `- ${lane.id}: ${lane.output.channel === 'results' ? 'ranked source links and snippets' : 'typed provider answer/context; inspect its cited sources'}; output ${lane.output.channel} (${lane.output.schema_id}); execution ${lane.execution_modes.join(', ')}; latency ${lane.latency}, cost ${lane.cost}.`),
    ...(lanes.length === 0 ? ['None available in this snapshot.'] : []),
    `Presets: ${capabilities.search.presets.map((preset) => `${preset.name} [${preset.lanes.join(', ')}] (${preset.availability}; ${preset.execution_modes.join(', ')})`).join('; ') || 'none'}.`,
    `Search limits: ${JSON.stringify(capabilities.search.limits)}.`,
  ].filter(Boolean).join('\n');
  const fetch = [header, sourceStatus, mismatchWarning,
    'Configured fetch chains (default representation: markdown):',
    ...capabilities.fetch.chains.map((chain) => `- ${chain.input_kind}/${chain.representation}: ${chain.pipelines.join(' -> ')}.`),
    `Fetch inputs: ${JSON.stringify(capabilities.fetch.inputs)}.`,
    'Fetch pipelines:',
    ...capabilities.fetch.pipelines.map((pipeline) => `- ${pipeline.id}: ${pipeline.availability}; inputs ${pipeline.input_kinds.join(', ')}; representations ${pipeline.representations.join(', ')}; execution ${pipeline.execution_modes.join(', ')}; egress ${pipeline.egress}.`),
    `Fetch limits: ${JSON.stringify(capabilities.fetch.limits)}.`,
    'URL selection: explicit pipeline > first matching user rule > enabled built-in rule > configured fetch chain. Only the selected ordered list is tried; a direct-only rule never adds a paid fallback. Inline/file inputs do not use URL routing. Local/inline content stays subject to donor egress restrictions; file scopes do not bypass Kiki path admission.',
    ...(capabilities.fetch.routing === undefined ? [] : [`URL routing: ${capabilities.fetch.routing.enabled ? 'enabled' : 'disabled'}; built-in package ${capabilities.fetch.routing.package.id}@${capabilities.fetch.routing.package.version} (${capabilities.fetch.routing.builtin_enabled ? 'enabled' : 'disabled'}); user rules ${capabilities.fetch.routing.rules.length}. Route and actual attempts are returned in fetch receipts.`]),
  ].filter(Boolean).join('\n');
  return { expiresAt: now + 60_000, search, fetch };
}
