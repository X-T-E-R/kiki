import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';

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
  readonly appService?: boolean;
  readonly contextTokens: number;
  readonly unsupported: readonly string[];
}

export async function fingerprintDirectory(root: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const digest = createHash('sha256');
  async function* walk(directory: string): AsyncGenerator<string> {
    signal?.throwIfAborted();
    const entries = await readdir(directory, { withFileTypes: true });
    signal?.throwIfAborted();
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink()) throw new Error(`Plugin file is a symbolic link: ${entry.name}`);
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) yield* walk(file);
      else if (entry.isFile()) yield file;
      else throw new Error(`Unsupported plugin file: ${entry.name}`);
    }
  }
  async function hashBatch(files: readonly string[]): Promise<void> {
    signal?.throwIfAborted();
    const readers = files.map((file) => {
      const stream = createReadStream(file, { signal, highWaterMark: 64 * 1024 });
      const closed = finished(stream, { cleanup: true }).catch((error: unknown) => error);
      stream.read(0);
      return { file, stream, closed };
    });
    try {
      for (const { file, stream } of readers) {
        signal?.throwIfAborted();
        digest.update(path.relative(root, file).replaceAll('\\', '/'));
        digest.update('\0');
        for await (const chunk of stream) {
          signal?.throwIfAborted();
          digest.update(chunk);
        }
      }
    } finally {
      for (const { stream } of readers) stream.destroy();
      await Promise.all(readers.map(({ closed }) => closed));
    }
  }
  let batch: string[] = [];
  for await (const file of walk(root)) {
    batch.push(file);
    if (batch.length === 8) {
      await hashBatch(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await hashBatch(batch);
  signal?.throwIfAborted();
  return digest.digest('hex');
}

export function contributionNames(manifest: PluginManifest): readonly string[] {
  return [
    ...(manifest.skills ?? []).map((_, i) => `skill:${i}`),
    ...(manifest.agents ?? []).map((_, i) => `agent:${i}`),
    ...Object.keys(manifest.mcpServers ?? {}).map((name) => `mcp:${name}`),
    ...(manifest.hooks ?? []).map((hook, i) => `hook:${i}:${hook.event}`),
    ...(manifest.hookRules?.rules ?? []).map((rule) => `hook:${rule.id}:${rule.event}`),
    ...(manifest.commands ?? []).map((command) => `command:${command.name}`),
    ...(manifest.kiki?.themes ?? []).map((theme) => `theme:${theme.id}`),
    ...(manifest.kiki?.providerPresets ?? []).map((preset) => `provider:${preset.id}`),
    ...(manifest.kiki?.tools ?? []).map((tool) => `tool:${tool.name}`),
    ...(manifest.kiki?.sessionSources ?? []).map((source) => `session-source:${source.id}`),
    ...(manifest.kiki?.imAdapters ?? []).map((adapter) => `im-adapter:${adapter.id}`),
    ...Object.entries(manifest.kiki?.dependencies ?? {}).map(([id, range]) => `dependency:${id}@${range}`),
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
  if (previous !== undefined && JSON.stringify(manifest.kiki?.imAdapters ?? []) !== JSON.stringify(previous.kiki?.imAdapters ?? [])) changes.push('IM adapter definitions changed');
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
      ? manifest.kiki?.entry !== undefined || contributions.some((item) => !item.startsWith('theme:')) || Object.keys(manifest.kiki?.permissions ?? {}).length > 0
      : previous.kiki?.entry === undefined && manifest.kiki?.entry !== undefined,
    permissions: manifest.kiki?.permissions,
    contributions,
    appService: manifest.kiki?.activation === 'app',
    contextTokens: Math.ceil((
      (manifest.systemPrompt?.length ?? 0) +
      (manifest.skillInstructions?.length ?? 0) +
      (manifest.kiki?.tools ?? []).reduce((total, tool) => total + JSON.stringify(tool).length, 0)
    ) / 4),
    unsupported: manifest.unsupportedComponents ?? [],
  };
}
