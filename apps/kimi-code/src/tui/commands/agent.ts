import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { parse } from 'smol-toml';

import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export interface SelectableAgentProfile {
  readonly name: string;
  readonly description?: string;
  readonly main: boolean;
}

interface AgentCatalogConfig {
  readonly extraAgentDirs: readonly string[];
  readonly disabledBuiltinProfiles: ReadonlySet<string>;
  readonly disabledNamedProfiles: ReadonlySet<string>;
}

export async function loadSelectableAgentProfiles(
  host: Pick<SlashCommandHost, 'harness' | 'state'>,
): Promise<readonly SelectableAgentProfile[]> {
  const [core, discovery, roots, paths, config, pluginRoots] = await Promise.all([
    import('@kiki/agent-core-v2'),
    import('@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/agentFileDiscovery'),
    import('@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/agentRoots'),
    import('@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/paths'),
    readAgentCatalogConfig(host.harness.configPath),
    loadPluginAgentRoots(host.harness),
  ]);
  const fs = new core.HostFileSystem();
  const workDir = host.state.appState.workDir;
  const [userRoots, projectRoots, extraRoots, explicit] = await Promise.all([
    roots.userAgentRoots(fs, host.harness.homeDir, homedir()),
    roots.projectAgentRoots(fs, workDir),
    roots.configuredAgentRoots(fs, config.extraAgentDirs, workDir, homedir(), 'extra'),
    Promise.all(
      (host.state.appState.agentFiles ?? []).map(async (file) => {
        const path = paths.resolveAgentPath(file, workDir, homedir());
        const definition = core.parseAgentFileText({
          path,
          source: 'explicit',
          text: await fs.readText(path),
        });
        return { ...definition, override: true };
      }),
    ),
  ]);
  const [plugin, user, project, extra] = await Promise.all([
    discovery.discoverAgentFiles(fs, pluginRoots),
    discovery.discoverAgentFiles(fs, userRoots),
    discovery.discoverAgentFiles(fs, projectRoots),
    discovery.discoverAgentFiles(fs, extraRoots),
  ]);

  const builtins = core.getAgentProfileContributions();
  const enabledBuiltinNames = new Set<string>();
  const merged = new Map<string, SelectableAgentProfile>();
  for (const profile of builtins) {
    if (config.disabledBuiltinProfiles.has(profile.name)) continue;
    enabledBuiltinNames.add(profile.name);
    merged.set(profile.name, {
      name: profile.name,
      description: profile.description,
      main: profile.main === true,
    });
  }

  for (const definition of [
    ...plugin.agents,
    ...user.agents,
    ...extra.agents,
    ...project.agents,
    ...explicit,
  ]) {
    if (definition.private) continue;
    if (config.disabledNamedProfiles.has(definition.name)) continue;
    if (enabledBuiltinNames.has(definition.name) && definition.override !== true) continue;
    merged.set(definition.name, {
      name: definition.name,
      description: definition.description,
      main: definition.main === true,
    });
  }

  return [...merged.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function handleAgentCommand(
  host: SlashCommandHost,
  args: string,
  loadProfiles: typeof loadSelectableAgentProfiles = loadSelectableAgentProfiles,
): Promise<void> {
  let profiles: readonly SelectableAgentProfile[];
  try {
    profiles = await loadProfiles(host);
  } catch (error) {
    host.showError(`Failed to load agent profiles: ${formatErrorMessage(error)}`);
    return;
  }

  const requested = args.trim();
  const current = host.state.appState.agentProfile ?? 'agent';
  if (requested.length === 0) {
    const rows = profiles.map((profile) => {
      const marker = profile.name === current ? '*' : ' ';
      const main = profile.main ? ' (main)' : '';
      const description = profile.description === undefined ? '' : ` — ${profile.description}`;
      return `${marker} ${profile.name}${main}${description}`;
    });
    if (!profiles.some((profile) => profile.name === current)) {
      rows.unshift(`* ${current} (current explicit profile)`);
    }
    host.showNotice(
      'Agent profiles',
      [
        `Current for new sessions: ${current}`,
        '',
        ...rows,
        '',
        'Use /agent <name> to select a profile, then /new to start it.',
      ].join('\n'),
    );
    return;
  }

  const selected = profiles.find((profile) => profile.name === requested);
  if (selected === undefined) {
    host.showError(`Unknown agent profile: ${requested}`);
    return;
  }
  host.setAppState({ agentProfile: selected.name });
  host.showNotice(
    `Agent profile for new sessions: ${selected.name}`,
    'The current session is unchanged. Run /new to start a session with this profile.',
  );
}

async function loadPluginAgentRoots(
  harness: SlashCommandHost['harness'],
): Promise<readonly { readonly path: string; readonly source: 'plugin' }[]> {
  try {
    const plugins = await harness.listPlugins();
    const infos = await Promise.all(
      plugins
        .filter((plugin) => plugin.enabled && plugin.state === 'ok')
        .map((plugin) => harness.getPluginInfo(plugin.id)),
    );
    return infos.flatMap((plugin) =>
      (plugin.manifest?.agents ?? []).map((path) => ({ path, source: 'plugin' as const })),
    );
  } catch {
    return [];
  }
}

async function readAgentCatalogConfig(path: string): Promise<AgentCatalogConfig> {
  try {
    const parsed = parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    return {
      extraAgentDirs: stringList(parsed['extra_agent_dirs']),
      disabledBuiltinProfiles: new Set(stringList(parsed['disabled_builtin_profiles'])),
      disabledNamedProfiles: new Set(stringList(parsed['disabled_named_profiles'])),
    };
  } catch {
    return {
      extraAgentDirs: [],
      disabledBuiltinProfiles: new Set(),
      disabledNamedProfiles: new Set(),
    };
  }
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
