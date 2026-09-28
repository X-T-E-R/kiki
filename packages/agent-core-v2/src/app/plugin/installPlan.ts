import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { PluginPermissions } from './contributions';
import type { PluginManifest } from './types';

export interface PluginInstallPlan {
  readonly id: string;
  readonly version?: string;
  readonly fingerprint: string;
  readonly changes: readonly string[];
  readonly consentRequired: boolean;
  readonly permissions?: PluginPermissions;
  readonly contributions: readonly string[];
  readonly contextTokens: number;
  readonly unsupported: readonly string[];
}

export async function fingerprintDirectory(root: string): Promise<string> {
  const digest = createHash('sha256');
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`Plugin file is a symbolic link: ${entry.name}`);
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        digest.update(path.relative(root, file).replaceAll('\\', '/'));
        digest.update('\0');
        digest.update(await readFile(file));
      } else throw new Error(`Unsupported plugin file: ${entry.name}`);
    }
  }
  await walk(root);
  return digest.digest('hex');
}

export function contributionNames(manifest: PluginManifest): readonly string[] {
  return [
    ...(manifest.skills ?? []).map((_, i) => `skill:${i}`),
    ...(manifest.agents ?? []).map((_, i) => `agent:${i}`),
    ...Object.keys(manifest.mcpServers ?? {}).map((name) => `mcp:${name}`),
    ...(manifest.hooks ?? []).map((hook, i) => `hook:${i}:${hook.event}`),
    ...(manifest.commands ?? []).map((command) => `command:${command.name}`),
    ...(manifest.kiki?.themes ?? []).map((theme) => `theme:${theme.id}`),
    ...(manifest.kiki?.providerPresets ?? []).map((preset) => `provider:${preset.id}`),
    ...(manifest.kiki?.tools ?? []).map((tool) => `tool:${tool.name}`),
    ...(manifest.kiki?.panels ?? []).map((panel) => `panel:${panel.id}`),
    ...(manifest.kiki?.commands ?? []).map((command) => `command:${command.name}`),
    ...(manifest.kiki?.settings === undefined ? [] : ['settings']),
  ];
}

export function buildInstallPlan(
  manifest: PluginManifest,
  fingerprint: string,
  previous?: PluginManifest,
): PluginInstallPlan {
  const contributions = contributionNames(manifest);
  const old = previous === undefined ? [] : contributionNames(previous);
  const changes = [
    ...contributions.filter((item) => !old.includes(item)).map((item) => `added ${item}`),
    ...old.filter((item) => !contributions.includes(item)).map((item) => `removed ${item}`),
  ];
  if (previous !== undefined && JSON.stringify(manifest.kiki?.permissions ?? {}) !== JSON.stringify(previous.kiki?.permissions ?? {})) {
    changes.push('permissions changed');
  }
  if (previous !== undefined && JSON.stringify(manifest.kiki?.tools ?? []) !== JSON.stringify(previous.kiki?.tools ?? [])) {
    changes.push('tool definitions changed');
  }
  if (previous !== undefined && JSON.stringify(manifest.kiki?.providerPresets ?? []) !== JSON.stringify(previous.kiki?.providerPresets ?? [])) {
    changes.push('provider presets changed');
  }
  if (previous !== undefined && JSON.stringify(manifest.kiki?.themes ?? []) !== JSON.stringify(previous.kiki?.themes ?? [])) {
    changes.push('themes changed');
  }
  if (previous !== undefined && JSON.stringify(manifest.kiki?.panels ?? []) !== JSON.stringify(previous.kiki?.panels ?? [])) {
    changes.push('panels changed');
  }
  if (previous !== undefined && JSON.stringify(manifest.kiki?.commands ?? []) !== JSON.stringify(previous.kiki?.commands ?? [])) {
    changes.push('commands changed');
  }
  return {
    id: manifest.name.toLowerCase(),
    version: manifest.version,
    fingerprint,
    changes,
    consentRequired: previous === undefined
      ? contributions.some((item) => !item.startsWith('theme:')) || Object.keys(manifest.kiki?.permissions ?? {}).length > 0
      : changes.length > 0,
    permissions: manifest.kiki?.permissions,
    contributions,
    contextTokens: Math.ceil((
      (manifest.systemPrompt?.length ?? 0) +
      (manifest.skillInstructions?.length ?? 0) +
      (manifest.kiki?.tools ?? []).reduce((total, tool) => total + JSON.stringify(tool).length, 0)
    ) / 4),
    unsupported: manifest.unsupportedComponents ?? [],
  };
}
