import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createKlient } from '@kiki/klient/http';
import {
  syncMemoryScopeKindSchema,
  syncPeerTransferInputSchema,
  type PortableSpaceSessionSelection,
  type SyncBundleImportReceipt,
  type SyncFilesTransferReceipt,
  type SyncMemoryScopeKind,
  type SyncPeerTransferInput,
} from '@kiki/protocol';
import { quotePosixShellArg } from '@kiki/shell-quoting';
import type { Command } from 'commander';
import { resolveKikiHome } from './home';
import {
  REMOTE_POSIX_PATH,
  isRemoteTarget,
  remoteCommand,
  resolveRemoteTarget,
  type RemoteCommandRunner,
} from './remote-transport';
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
  readonly runRemote?: RemoteCommandRunner;
  readonly stdout?: { write(chunk: string): unknown };
}

interface SyncFilesCommandOptions {
  readonly home?: string;
  readonly json?: boolean;
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
  if (receipt.homeAssetsApplied !== undefined || receipt.homeAssetsSkipped !== undefined) {
    lines.push(`  Home assets: ${receipt.homeAssetsApplied ?? 0} applied, ${receipt.homeAssetsSkipped ?? 0} skipped`);
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

function formatFilesReceipt(
  direction: 'pull' | 'push',
  peer: string,
  receipt: SyncFilesTransferReceipt,
): string {
  const unit = receipt.fileCount === 1 ? 'file' : 'files';
  return `Sync files ${direction} (${peer}) complete: ${receipt.fileCount} ${unit}, ${receipt.totalBytes} bytes -> ${receipt.destinationPath}\n`;
}

function resolveLocalPath(rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : resolve(rawPath);
}

function assertSafeRemotePosixPath(remotePath: string): void {
  const trimmed = remotePath.trim();
  if (trimmed.length === 0) {
    throw new Error('Remote path must not be empty.');
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.codePointAt(i);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) {
      throw new Error('Remote path contains invalid control characters.');
    }
  }
  const normalized = trimmed.replaceAll('\\', '/').toLowerCase();
  const stripped = normalized === '/' ? '/' : normalized.replace(/\/+$/u, '');
  if (stripped === '/' || stripped === '~' || stripped === '$home') {
    throw new Error(`Remote path '${remotePath}' targets a forbidden secret location.`);
  }
  const segments = new Set(stripped.split('/').filter((segment) => segment.length > 0));
  if (
    segments.has('.ssh') ||
    segments.has('.gnupg') ||
    segments.has('server.local-owner') ||
    stripped.includes('/.kiki/credentials') ||
    stripped === '~/.kiki/credentials' ||
    stripped.startsWith('~/.kiki/credentials/') ||
    stripped.includes('/.kiki/server') ||
    stripped === '~/.kiki/server' ||
    stripped.startsWith('~/.kiki/server/')
  ) {
    throw new Error(`Remote path '${remotePath}' targets a forbidden secret location.`);
  }
}

const REMOTE_KIKI_HOME_SETUP =
  'kh="${KIKI_HOME:-${KIMI_CODE_HOME:-$HOME/.kiki}}"; case "$kh" in "~") kh="$HOME" ;; "~/"*) kh="$HOME/${kh#~/}" ;; esac; if [ -d "$kh" ]; then kh=$(cd "$kh" && pwd -P); fi; ';

const REMOTE_FORBIDDEN_PATH_GUARD =
  'case "$rp" in "/"|"$HOME"|"$kh"|"$HOME/.ssh"|"$HOME/.ssh/"*|"$HOME/.gnupg"|"$HOME/.gnupg/"*|"$kh/credentials"|"$kh/credentials/"*|"$kh/server"|"$kh/server/"*|*"/.kiki/credentials"|*"/.kiki/credentials/"*|*"/.kiki/server"|*"/.kiki/server/"*|*"/server.local-owner") echo "Forbidden secret path: $rp" >&2; exit 3 ;; esac; ';

function buildRemoteFilePullScript(remotePath: string): string {
  const quoted = quotePosixShellArg(remotePath);
  return [
    REMOTE_POSIX_PATH,
    'set -eu; ',
    REMOTE_KIKI_HOME_SETUP,
    `p=${quoted}; `,
    'case "$p" in "~") p="$HOME" ;; "~/"*) p="$HOME/${p#~/}" ;; esac; ',
    'if [ "$p" != "/" ]; then p="${p%/}"; fi; ',
    'if [ ! -e "$p" ]; then echo "Remote path not found: $p" >&2; exit 2; fi; ',
    'if [ -L "$p" ]; then echo "Symlink source is not allowed: $p" >&2; exit 3; fi; ',
    'rp=$(cd "$(dirname "$p")" && printf "%s/%s\\n" "$(pwd -P)" "$(basename "$p")"); ',
    REMOTE_FORBIDDEN_PATH_GUARD,
    'if [ -f "$rp" ]; then printf "KIKI-FILE\\n"; exec tar -czf - -C "$(dirname "$rp")" "$(basename "$rp")"; ',
    'elif [ -d "$rp" ]; then if find "$rp" \\( -type l -o -name .ssh -o -name .gnupg -o -name server.local-owner -o -path "$kh/credentials" -o -path "$kh/server" -o -path "*/.kiki/credentials" -o -path "*/.kiki/server" \\) | grep -q .; then echo "Forbidden secret or symlink inside source directory: $rp" >&2; exit 3; fi; printf "KIKI-DIR\\n"; exec tar -czf - -C "$rp" .; ',
    'else echo "Unsupported remote path type: $rp" >&2; exit 2; fi',
  ].join('');
}

function buildRemoteFilePushScript(remotePath: string, kind: 'file' | 'directory', rootName: string): string {
  const quotedPath = quotePosixShellArg(remotePath);
  const quotedRoot = quotePosixShellArg(rootName);
  const entryCheckLoop =
    'list=$(mktemp); tar -tzf "$arc" > "$list"; while IFS= read -r entry; do case "$entry" in /*|*../*|*/..|..|*".ssh"*|*".gnupg"*|*"server.local-owner"*|*".kiki/credentials"*|*".kiki/server"*) echo "Forbidden archive entry: $entry" >&2; exit 3 ;; esac; target="$rp/${entry#./}"; case "$target" in "$HOME/.ssh"|"$HOME/.ssh/"*|"$HOME/.gnupg"|"$HOME/.gnupg/"*|"$kh/credentials"|"$kh/credentials/"*|"$kh/server"|"$kh/server/"*|*"/.kiki/credentials"|*"/.kiki/credentials/"*|*"/.kiki/server"|*"/.kiki/server/"*|*"/server.local-owner") echo "Forbidden destination entry: $target" >&2; exit 3 ;; esac; done < "$list"; ';
  if (kind === 'directory') {
    return [
      REMOTE_POSIX_PATH,
      'set -eu; ',
      REMOTE_KIKI_HOME_SETUP,
      `p=${quotedPath}; `,
      'case "$p" in "~") p="$HOME" ;; "~/"*) p="$HOME/${p#~/}" ;; esac; ',
      'if [ -L "$p" ]; then echo "Symlink destination is not allowed: $p" >&2; exit 3; fi; ',
      'mkdir -p "$p"; ',
      'rp=$(cd "$p" && pwd -P); ',
      REMOTE_FORBIDDEN_PATH_GUARD,
      'arc=$(mktemp); list=""; trap \'rm -f "$arc" "$list"\' EXIT; cat > "$arc"; ',
      entryCheckLoop,
      'tar -xzf "$arc" -C "$rp"',
    ].join('');
  }
  return [
    REMOTE_POSIX_PATH,
    'set -eu; ',
    REMOTE_KIKI_HOME_SETUP,
    `p=${quotedPath}; `,
    'case "$p" in "~") p="$HOME" ;; "~/"*) p="$HOME/${p#~/}" ;; esac; ',
    'if [ -L "$p" ]; then echo "Symlink destination is not allowed: $p" >&2; exit 3; fi; ',
    'if [ -d "$p" ]; then rp=$(cd "$p" && pwd -P); ',
    REMOTE_FORBIDDEN_PATH_GUARD,
    'arc=$(mktemp); list=""; trap \'rm -f "$arc" "$list"\' EXIT; cat > "$arc"; ',
    entryCheckLoop,
    'tar -xzf "$arc" -C "$rp"; exit 0; fi; ',
    'parent=$(dirname "$p"); mkdir -p "$parent"; rparent=$(cd "$parent" && pwd -P); rp="$rparent/$(basename "$p")"; ',
    REMOTE_FORBIDDEN_PATH_GUARD,
    'tmp=$(mktemp -d "$rparent/.kiki-sync-XXXXXX"); trap \'rm -rf "$tmp"\' EXIT; ',
    'tar -xzf - -C "$tmp"; ',
    `mv "$tmp/"${quotedRoot} "$rp"`,
  ].join('');
}

function parseFramedRemoteArchive(raw: Buffer): { readonly kind: 'file' | 'directory'; readonly archive: Buffer } {
  const newline = raw.indexOf(0x0a);
  if (newline <= 0) {
    throw new Error('Remote file transfer returned a malformed archive header.');
  }
  const header = raw.subarray(0, newline).toString('utf8').trim();
  if (header !== 'KIKI-FILE' && header !== 'KIKI-DIR') {
    throw new Error(`Unexpected remote file transfer header: ${header}`);
  }
  return {
    kind: header === 'KIKI-FILE' ? 'file' : 'directory',
    archive: raw.subarray(newline + 1),
  };
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

  const files = group
    .command('files')
    .description('Pull or push files or build artifact directories over SSH/CCP or a trusted paired peer.');

  const runFilesPull = async (
    source: string,
    remotePath: string,
    localPath: string,
    options: SyncFilesCommandOptions,
    command: Command,
  ): Promise<void> => {
    const homeDir = resolveKikiHome((options.home ?? command.optsWithGlobals()['home']) as string | undefined);
    const connection = await (dependencies.ensureServer ?? ensureServer)({ homeDir });
    const client = (dependencies.createKlient ?? createKlient)({ endpoint: connection.url, token: connection.token });
    const stdout = dependencies.stdout ?? process.stdout;
    try {
      const resolvedLocal = resolveLocalPath(localPath);
      let receipt: SyncFilesTransferReceipt;
      if (isRemoteTarget(source)) {
        assertSafeRemotePosixPath(remotePath);
        const { invoke } = await resolveRemoteTarget(source, dependencies.runRemote ?? remoteCommand);
        const scratch = await mkdtemp(join(tmpdir(), 'kiki-sync-files-pull-'));
        try {
          const downloadPath = join(scratch, 'pull.kiki.bin');
          await invoke(buildRemoteFilePullScript(remotePath), undefined, downloadPath);
          const { kind, archive } = parseFramedRemoteArchive(await readFile(downloadPath));
          receipt = await client.rest!.sync.importFiles({
            destinationPath: resolvedLocal,
            kind,
            archiveBase64: archive.toString('base64'),
          });
        } finally {
          await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
        }
      } else {
        receipt = await client.rest!.sync.pullFilesFromPeer(source, {
          remotePath,
          localPath: resolvedLocal,
        });
      }
      if (options.json) {
        stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      } else {
        stdout.write(formatFilesReceipt('pull', source, receipt));
      }
    } finally {
      await client.close();
    }
  };

  const runFilesPush = async (
    target: string,
    localPath: string,
    remotePath: string,
    options: SyncFilesCommandOptions,
    command: Command,
  ): Promise<void> => {
    const homeDir = resolveKikiHome((options.home ?? command.optsWithGlobals()['home']) as string | undefined);
    const connection = await (dependencies.ensureServer ?? ensureServer)({ homeDir });
    const client = (dependencies.createKlient ?? createKlient)({ endpoint: connection.url, token: connection.token });
    const stdout = dependencies.stdout ?? process.stdout;
    try {
      const resolvedLocal = resolveLocalPath(localPath);
      let receipt: SyncFilesTransferReceipt;
      if (isRemoteTarget(target)) {
        assertSafeRemotePosixPath(remotePath);
        const exported = await client.rest!.sync.exportFiles({ path: resolvedLocal });
        const { invoke } = await resolveRemoteTarget(target, dependencies.runRemote ?? remoteCommand);
        const scratch = await mkdtemp(join(tmpdir(), 'kiki-sync-files-push-'));
        try {
          const uploadPath = join(scratch, 'push.tar.gz');
          await writeFile(uploadPath, Buffer.from(exported.archiveBase64, 'base64'), { mode: 0o600 });
          await invoke(buildRemoteFilePushScript(remotePath, exported.kind, exported.rootName), uploadPath);
          receipt = {
            kind: exported.kind,
            destinationPath: remotePath,
            fileCount: exported.fileCount,
            totalBytes: exported.totalBytes,
            files: [],
          };
        } finally {
          await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
        }
      } else {
        receipt = await client.rest!.sync.pushFilesToPeer(target, {
          localPath: resolvedLocal,
          remotePath,
        });
      }
      if (options.json) {
        stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      } else {
        stdout.write(formatFilesReceipt('push', target, receipt));
      }
    } finally {
      await client.close();
    }
  };

  files
    .command('pull <source> <remotePath> <localPath>')
    .description('Pull a remote file or directory from ccp:<runtimeId>, ssh://..., or a trusted paired peer.')
    .option('--home <dir>', 'Local Kiki home directory.')
    .option('--json', 'Output machine-readable JSON.')
    .action(async (source: string, remotePath: string, localPath: string, options: SyncFilesCommandOptions, command: Command) =>
      runFilesPull(source, remotePath, localPath, options, command),
    );

  files
    .command('push <target> <localPath> <remotePath>')
    .description('Push a local file or directory to ccp:<runtimeId>, ssh://..., or a trusted paired peer.')
    .option('--home <dir>', 'Local Kiki home directory.')
    .option('--json', 'Output machine-readable JSON.')
    .action(async (target: string, localPath: string, remotePath: string, options: SyncFilesCommandOptions, command: Command) =>
      runFilesPush(target, localPath, remotePath, options, command),
    );

  return group;
}
