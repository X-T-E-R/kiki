import { createKlient } from '@kiki/klient/http';
import {
  syncMemoryScopeKindSchema,
  syncPeerTransferInputSchema,
  type PortableSpaceSessionSelection,
  type SyncBundleImportReceipt,
  type SyncMemoryScopeKind,
  type SyncPeerTransferInput,
} from '@kiki/protocol';
import type { Command } from 'commander';
import { resolveKikiHome } from './home';
import { ensureServer } from './serve';

interface SyncCommandOptions {
  readonly home?: string;
  readonly memories?: boolean;
  readonly skills?: boolean;
  readonly includeGitSkills?: boolean;
  readonly config?: boolean;
  readonly credentials?: boolean;
  readonly sessions?: string;
  readonly workDir?: string;
  readonly targetWorkDir?: string;
  readonly targetProjectId?: string;
  readonly projectId?: string[];
  readonly memoryScopes?: string;
  readonly json?: boolean;
}

export interface SyncCommandDependencies {
  readonly ensureServer?: typeof ensureServer;
  readonly createKlient?: typeof createKlient;
  readonly stdout?: { write(chunk: string): unknown };
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function parseSyncSessionsSpec(raw: string | undefined): PortableSpaceSessionSelection | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'none') return { mode: 'none' };
  const recentMatch = /^recent:(\d+)$/u.exec(trimmed);
  if (recentMatch !== null) {
    const count = Number(recentMatch[1]);
    if (!Number.isSafeInteger(count) || count < 1 || count > 50) {
      throw new Error('--sessions recent:<count> requires a count from 1 to 50.');
    }
    return { mode: 'recent', count };
  }
  const sessionIds = trimmed
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (sessionIds.length === 0) {
    throw new Error('--sessions expects recent:<count> or comma-separated session IDs.');
  }
  return { mode: 'ids', sessionIds };
}

function parseMemoryScopes(raw: string | undefined): SyncMemoryScopeKind[] | undefined {
  if (raw === undefined) return undefined;
  const scopes = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => syncMemoryScopeKindSchema.parse(item));
  return scopes.length > 0 ? scopes : undefined;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function buildTransferInput(options: SyncCommandOptions): SyncPeerTransferInput {
  return syncPeerTransferInputSchema.parse({
    includeMemories: options.memories !== false,
    includeSkills: options.skills !== false,
    includeGitSkills: options.includeGitSkills === true ? true : undefined,
    includeConfig: options.config === true,
    includeCredentials: options.credentials === true,
    sessions: parseSyncSessionsSpec(options.sessions),
    workDir: nonEmptyTrimmed(options.workDir),
    targetWorkDir: nonEmptyTrimmed(options.targetWorkDir),
    targetProjectId: nonEmptyTrimmed(options.targetProjectId),
    projectIds: options.projectId && options.projectId.length > 0 ? options.projectId : undefined,
    memoryScopes: parseMemoryScopes(options.memoryScopes),
  });
}

function formatReceipt(direction: 'pull' | 'push', peerId: string, receipt: SyncBundleImportReceipt): string {
  const lines = [
    `Sync ${direction} (${peerId}) complete:`,
    `  Memories: ${receipt.memoriesApplied} applied, ${receipt.memoriesSkipped} skipped`,
    `  Skills: ${receipt.skillsApplied} applied, ${receipt.skillsSkipped} skipped`,
  ];
  if (receipt.sessionsApplied !== undefined || receipt.sessionsSkipped !== undefined) {
    lines.push(`  Sessions: ${receipt.sessionsApplied ?? 0} applied, ${receipt.sessionsSkipped ?? 0} skipped`);
  }
  if (receipt.configDomainsApplied.length > 0) {
    lines.push(`  Config domains: ${receipt.configDomainsApplied.join(', ')}`);
  }
  if (
    receipt.credentials.appliedIds.length > 0 ||
    receipt.credentials.skippedIds.length > 0 ||
    receipt.credentials.conflictIds.length > 0
  ) {
    lines.push(
      `  Credentials: ${receipt.credentials.appliedIds.length} applied, ${receipt.credentials.skippedIds.length} skipped, ${receipt.credentials.conflictIds.length} conflicts`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function addSyncTransferOptions(command: Command): Command {
  return command
    .option('--home <dir>', 'Local Kiki home directory.')
    .option('--memories', 'Include portable memories (enabled by default).', true)
    .option('--no-memories', 'Skip memories.')
    .option('--skills', 'Include portable skills (enabled by default).', true)
    .option('--no-skills', 'Skip skills.')
    .option('--include-git-skills', 'Also export git-backed skill trees (excluding .git and node_modules).')
    .option('--config', 'Include portable config sections.', false)
    .option('--credentials', 'Include synced credential envelopes.', false)
    .option('--sessions <spec>', 'Include sessions: recent:<count> or comma-separated session IDs.')
    .option('--work-dir <dir>', 'Source workspace path used to resolve project skills.')
    .option('--target-work-dir <dir>', 'Remap incoming workspace memories and sessions onto this local workspace path.')
    .option('--target-project-id <id>', 'Remap incoming workspace memories and sessions onto this explicit workspace/project ID.')
    .option('--project-id <id>', 'Filter workspace memories to this project/workspace ID; may be repeated.', collect, [])
    .option('--memory-scopes <scopes>', 'Comma-separated memory scopes: global,persona,workspace,persona_workspace.')
    .option('--json', 'Output machine-readable JSON.');
}

export function registerSyncCommand(program: Command, dependencies: SyncCommandDependencies = {}): Command {
  const group = program
    .command('sync')
    .description('Pull or push memories, skills, sessions, config, and credentials over a paired peer connection.')
    .option('--home <dir>', 'Local Kiki home directory.');

  const runTransfer = async (
    direction: 'pull' | 'push',
    peerId: string,
    options: SyncCommandOptions,
    command: Command,
  ): Promise<void> => {
    const homeDir = resolveKikiHome((options.home ?? command.optsWithGlobals()['home']) as string | undefined);
    const connection = await (dependencies.ensureServer ?? ensureServer)({ homeDir });
    const client = (dependencies.createKlient ?? createKlient)({ endpoint: connection.url, token: connection.token });
    const stdout = dependencies.stdout ?? process.stdout;
    try {
      const input = buildTransferInput(options);
      const receipt = direction === 'pull'
        ? await client.rest!.sync.pullFromPeer(peerId, input)
        : await client.rest!.sync.pushToPeer(peerId, input);
      if (options.json) {
        stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      } else {
        stdout.write(formatReceipt(direction, peerId, receipt));
      }
    } finally {
      await client.close();
    }
  };

  addSyncTransferOptions(
    group.command('pull <peerId>').description('Pull memories, skills, sessions, or config from a paired peer.'),
  ).action(async (peerId: string, options: SyncCommandOptions, command: Command) =>
    runTransfer('pull', peerId, options, command),
  );

  addSyncTransferOptions(
    group.command('push <peerId>').description('Push memories, skills, sessions, or config to a paired peer.'),
  ).action(async (peerId: string, options: SyncCommandOptions, command: Command) =>
    runTransfer('push', peerId, options, command),
  );

  return group;
}
