import type { NbSearchCapabilities } from './nbSearch';

export function describeCapabilities(capabilities: NbSearchCapabilities): { expiresAt: number; search: string; fetch: string } {
  const now = Date.now();
  const header = 'Capability snapshot (availability reflects the last successful probe, not a live provider health check). Native nb-search runtime; no Skill or CLI prerequisite.';
  const available = capabilities.config_source?.availability !== 'unavailable';
  const issues = capabilities.config_source?.issues;
  const sourceStatus = available ? '' : `Configuration source unavailable: ${issues !== undefined && issues.length > 0 ? issues.join(', ') : 'unknown configuration issue'}.`;
  const lanes = available ? capabilities.search.lanes.filter((lane) => lane.availability === 'ready') : [];
  const defaultLane = capabilities.search.default_lane;
  const search = [header, sourceStatus,
    defaultLane === undefined ? 'Default search lane: not configured. Select an available lane or preset explicitly.' : `Configured default search lane: ${defaultLane} (${lanes.some((lane) => lane.id === defaultLane && lane.execution_modes.includes('sync')) ? 'ready for sync' : 'unavailable for sync'}).`,
    'Explicit lane/lanes/preset selection overrides the default. Invalid or unavailable selections fail without switching providers.',
    'Available search lanes:',
    ...lanes.map((lane) => `- ${lane.id}: ${lane.output.channel === 'results' ? 'ranked source links and snippets' : 'typed provider answer/context; inspect its cited sources'}; output ${lane.output.channel} (${lane.output.schema_id}); execution ${lane.execution_modes.join(', ')}; latency ${lane.latency}, cost ${lane.cost}.`),
    ...(lanes.length === 0 ? ['None available in this snapshot.'] : []),
    `Presets: ${capabilities.search.presets.map((preset) => `${preset.name} [${preset.lanes.join(', ')}] (${preset.availability}; ${preset.execution_modes.join(', ')})`).join('; ') || 'none'}.`,
    `Search limits: ${JSON.stringify(capabilities.search.limits)}.`,
  ].filter(Boolean).join('\n');
  const fetch = [header, sourceStatus,
    'Configured fetch chains (default representation: markdown):',
    ...capabilities.fetch.chains.map((chain) => `- ${chain.input_kind}/${chain.representation}: ${chain.pipelines.join(' -> ')}.`),
    `Fetch inputs: ${JSON.stringify(capabilities.fetch.inputs)}.`,
    'Fetch pipelines:',
    ...capabilities.fetch.pipelines.map((pipeline) => `- ${pipeline.id}: ${pipeline.availability}; inputs ${pipeline.input_kinds.join(', ')}; representations ${pipeline.representations.join(', ')}; execution ${pipeline.execution_modes.join(', ')}; egress ${pipeline.egress}.`),
    `Fetch limits: ${JSON.stringify(capabilities.fetch.limits)}.`,
    'Explicit pipeline and representation override configured selection. Local/inline content stays subject to donor egress restrictions; file scopes do not bypass Kiki path admission.',
  ].filter(Boolean).join('\n');
  return { expiresAt: now + 60_000, search, fetch };
}
