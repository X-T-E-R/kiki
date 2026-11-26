import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { readSpaceHome } from '@kiki/agent-core-v2/app/bootstrap/spaceHome';
import { mergeConfigCredentials } from '@kiki/agent-core-v2/app/config/credentials';
import { LEGACY_CREDENTIALS_KEY } from '@kiki/agent-core-v2/app/config/migrations';
import { z } from 'zod';
import { applySectionToToml } from '@kiki/agent-core-v2/app/config/toml';
import { spaceRecordSchema, settingsTransferPackageSchema, type PortableSpaceEncryption, type PortableSpaceDomain, type PortableSpaceEndpoint, type PortableSpaceExportReceipt, type PortableSpaceFormat, type PortableSpaceInspectResult, type PortableSpaceSecretMode, type PortableSpaceSessionSelection, type PortableSpaceUnlock } from '@kiki/protocol';
import type { SyncService } from '../sync/syncService';
import { decodeAge, encodeAge, formatRecipients, parseRecipients } from './ageCodec';
import { readLive, type LiveServices } from './liveSpace';
import { readHomeFiles } from './homeFiles';
import { sameUnit } from './mergeEngine';
import { checkedPath, git, gitRemote, missing, pathFormat, readBounded, readTree, scratch, writeFileAtomic, writeTree } from './spaceFiles';
import { packTarGz, safePortablePath, unpackTarGz } from './tarArchive';
import { encodeToml, filesFromUnits, FORK, object, parseToml, PLAIN, RECIPIENTS, SEALED, toUnitsWithExcluded, type ForkBase, type PortableSpaceTree, type Units } from './treeProjection';
import { defaultLabelForSubscriptionUrl, fetchSubscriptionArchive, sanitizeRemoteSubscriptionFiles, type UrlFetchOptions } from './urlSubscription';

export const NO_SESSIONS = { mode: 'none' } as const;
const REMOTE_ARCHIVE_LIMITS = { maxExpandedBytes: 32 * 1024 * 1024, maxFiles: 1024 } as const;
export interface LoadOptions {
  unlock?: PortableSpaceUnlock;
  sessions?: PortableSpaceSessionSelection;
  targetPlatform?: 'win32' | 'darwin' | 'linux';
  includeMemories?: boolean;
  includeCredentials?: boolean;
  ifNoneMatch?: string;
  ifNoneMatchOrigin?: string;
  signal?: AbortSignal;
  untrustedArchive?: boolean;
  readOnly?: boolean;
}
export interface LoadedSpaceTree extends PortableSpaceTree {
  matchedPassphrase?: string;
  etag?: string;
  usedExplicitIdentity?: boolean;
}
export type LoadedUrlTreeResult =
  | { readonly status: 'not_modified'; readonly etag?: string; readonly finalOrigin: string }
  | { readonly status: 'ok'; readonly tree: LoadedSpaceTree; readonly etag?: string; readonly finalOrigin: string };
export interface WriteOptions {
  format?: PortableSpaceFormat;
  secretMode?: PortableSpaceSecretMode;
  encryption?: PortableSpaceEncryption;
  gitInit?: boolean;
  replaceManaged?: boolean;
}

export function counts(units: Units) {
  const domains = new Map<PortableSpaceDomain, number>();
  for (const unit of units.values()) domains.set(unit.domain, (domains.get(unit.domain) ?? 0) + 1);
  return [...domains].map(([domain, count]) => ({ domain, count }));
}

export function inspectTree(endpoint: PortableSpaceEndpoint, tree: PortableSpaceTree): PortableSpaceInspectResult {
  const excluded = tree.excluded?.length ? tree.excluded : undefined;
  return {
    endpoint, label: tree.label, format: tree.format, spaceMode: tree.overlay ? 'overlay' : 'full',
    secretMode: tree.secretMode, encryptionMode: tree.encryptionMode, recipients: tree.recipients.map(({ recipient }) => recipient),
    unset: [...tree.unset], domains: counts(tree.units), items: [...tree.units].map(([id, unit]) => {
      const masked = unit.domain === 'credentials';
      const bytes = Buffer.isBuffer(unit.value) ? unit.value.length : undefined;
      const scalar = unit.value;
      return { id, domain: unit.domain, path: unit.path, label: unit.path.slice(0, 256), masked: masked || undefined, bytes,
        summary: masked ? 'Credential (masked)' : bytes === undefined ? JSON.stringify(unit.value).slice(0, 512) : undefined,
        scalarValue: !masked && (scalar === null || ['string', 'number', 'boolean'].includes(typeof scalar)) ? scalar as string | number | boolean | null : undefined };
    }), excluded,
  };
}

function readFork(bytes: Buffer | undefined): ForkBase | undefined {
  if (!bytes) return;
  const data = object(JSON.parse(bytes.toString('utf8')));
  if (typeof data['forkId'] !== 'string' || !/^[a-f0-9-]{36}$/.test(data['forkId']) || typeof data['createdAt'] !== 'string') throw new Error('Invalid portable fork metadata');
  const hashes = object(data['unitHashes']);
  for (const value of Object.values(hashes)) if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid portable fork unit hash');
  return { forkId: data['forkId'], createdAt: data['createdAt'], unitHashes: hashes as Record<string, string> };
}

export function endpointKey(endpoint: PortableSpaceEndpoint): string {
  if (endpoint.kind === 'live') return `live:${endpoint.spaceId}`;
  if (endpoint.kind === 'git') return `git:${gitRemote(endpoint.repo)}#${endpoint.ref ?? ''}/${endpoint.subpath ?? ''}`;
  if (endpoint.kind === 'url') return `url:${endpoint.url}`;
  const path = resolve(endpoint.path).replaceAll('\\', '/');
  return `${endpoint.kind}:${process.platform === 'win32' ? path.toLowerCase() : path}`;
}

export function endpointForPath(path: string, format = pathFormat(path)): PortableSpaceEndpoint {
  return format === 'dir' ? { kind: 'dir', path } : { kind: 'archive', path };
}

export function resealOptions(tree: LoadedSpaceTree, encryption?: PortableSpaceEncryption): WriteOptions {
  if (tree.encryptionMode === 'x25519' && !tree.recipients.length && encryption === undefined) throw new Error('This archive has no recipient roster; supply recipients before resealing');
  return { format: tree.format, secretMode: tree.secretMode, replaceManaged: true, encryption: encryption ?? (tree.encryptionMode === 'passphrase' ? { mode: 'passphrase', passphrase: tree.matchedPassphrase } : undefined) };
}

function equalEndpointContent(a: PortableSpaceTree, b: PortableSpaceTree): boolean {
  return a.units.size === b.units.size && [...a.units].every(([id, unit]) => sameUnit(unit, b.units.get(id)))
    && a.overlay === b.overlay && a.unset.size === b.unset.size && [...a.unset].every((mask) => b.unset.has(mask));
}

export class SpaceEndpoints {
  readonly home: string;
  readonly recipientsFile: string;

  constructor(
    readonly live: LiveServices,
    readonly sync: SyncService,
    private readonly urlFetchOptions?: Pick<UrlFetchOptions, 'fetchFn' | 'lookupFn' | 'allowLoopback'>,
  ) {
    this.home = live.bootstrap.homeDir;
    this.recipientsFile = join(this.home, 'credentials', 'space-recipients.txt');
  }

  async liveEndpoint(spaceId: string): Promise<{ path: string; name: string }> {
    const { bootstrap } = this.live;
    const current = bootstrap.spaceId ?? 'main';
    if (spaceId === current) return { path: this.home, name: bootstrap.space?.name ?? 'main' };
    if (current !== 'main') throw new Error(`Connect to Space ${spaceId} before operating on its live Home`);
    const records = await missing(readBounded(join(this.home, 'homes.json')));
    const record = records && z.array(spaceRecordSchema).parse(JSON.parse(records.toString('utf8'))).find((entry) => entry.id === spaceId);
    if (!record || !isAbsolute(record.path)) throw new Error(`Unknown registered Space: ${spaceId}`);
    const path = await realpath(record.path);
    const { space } = readSpaceHome(path);
    const base = space?.baseHomeDir && await realpath(space.baseHomeDir);
    if (space?.id !== spaceId || !base || endpointKey(endpointForPath(base, 'dir')) !== endpointKey(endpointForPath(await realpath(this.home), 'dir'))) throw new Error('Registered Space identity or base Home changed');
    return { path, name: space.name };
  }

  async assertWritable(endpoint: PortableSpaceEndpoint): Promise<void> {
    if (endpoint.kind === 'live') {
      if (endpoint.spaceId !== (this.live.bootstrap.spaceId ?? 'main')) throw new Error(`Connect to Space ${endpoint.spaceId} to write its live Home`);
      if (this.live.bootstrap.configReadOnly) throw new Error('This live Home is read-only');
      return;
    }
    if (endpoint.kind === 'url') {
      throw new Error('URL subscription endpoints are read-only');
    }
    if (endpoint.kind === 'git') {
      const branch = endpoint.ref;
      if (!branch || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)) throw new Error('Git publication requires an explicit branch');
      const ref = `refs/heads/${branch}`;
      await git(this.home, ['check-ref-format', ref]);
      const heads = await git(this.home, ['ls-remote', '--heads', '--', gitRemote(endpoint.repo), ref]);
      if (!heads.split('\n').some((line) => line.split('\t')[1] === ref)) throw new Error('Git publication requires a branch, not a tag');
      return;
    }
    const path = resolve(endpoint.path);
    const entry = await missing(lstat(path));
    if (entry && (endpoint.kind === 'dir' ? !entry.isDirectory() : !entry.isFile())) throw new Error('Portable Space destination is not writable');
    if (entry) await access(path, constants.W_OK);
    let parent = entry?.isDirectory() ? path : dirname(path);
    while (!await missing(stat(parent))) parent = dirname(parent);
    await access(parent, constants.W_OK);
    if (endpoint.kind === 'dir') await this.assertPortableDirectory(path);
  }

  private async assertPortableDirectory(destination: string): Promise<void> {
    const path = await missing(realpath(destination)) ?? resolve(destination);
    const key = endpointKey(endpointForPath(path, 'dir'));
    for (const home of [this.home, this.live.bootstrap.baseHomeDir]) {
      if (home && endpointKey(endpointForPath(await missing(realpath(home)) ?? resolve(home), 'dir')) === key) throw new Error('Use a live endpoint to modify a Kiki Home');
    }
    for (const marker of ['home.toml', 'server.local-owner', 'server.json', 'homes.json', 'config.local.toml']) {
      if (await missing(lstat(join(path, marker)))) throw new Error('Use a live endpoint to modify a Kiki Home');
    }
  }

  private async readRegisteredHome(path: string, options: LoadOptions): Promise<Map<string, Buffer>> {
    if (options.sessions && options.sessions.mode !== 'none') throw new Error('Connect to the registered Space to export its live sessions');
    const files = await readHomeFiles(path, this.live.bootstrap.osHomeDir, options.includeCredentials !== false);
    if (options.includeCredentials !== false) {
      const [sidecar, legacy] = await Promise.all([PLAIN, LEGACY_CREDENTIALS_KEY].map(async (name) => missing(readBounded(await checkedPath(path, name)))));
      if (sidecar && legacy && !sidecar.equals(legacy)) throw new Error('Old and new credentials.toml differ in registered Space');
      if (sidecar || legacy) files.set(PLAIN, encodeToml(mergeConfigCredentials(parseToml(sidecar ?? legacy), parseToml(files.get(PLAIN)))));
    }
    return files;
  }

  async knownRecipients(): Promise<ReturnType<typeof parseRecipients>> {
    return parseRecipients((await missing(readBounded(this.recipientsFile)))?.toString('utf8') ?? '');
  }

  private legacy(bytes: Buffer): Map<string, Buffer> {
    const bundle = settingsTransferPackageSchema.parse(JSON.parse(bytes.toString('utf8')));
    const config = {};
    for (const [key, value] of Object.entries(bundle.config)) applySectionToToml(config, key, value, this.live.registry);
    const files = new Map([['config.toml', encodeToml(config)]]);
    const mcp = Object.fromEntries(bundle.resources.flatMap((resource) => resource.kind === 'mcp' ? [[resource.key, resource.value] as const] : []));
    if (Object.keys(mcp).length) files.set('mcp.json', Buffer.from(JSON.stringify({ mcpServers: mcp })));
    for (const resource of bundle.resources) if (resource.kind === 'profile') files.set(safePortablePath(resource.key), Buffer.from(resource.text));
    if (bundle.preferences?.settings) files.set('space-preferences.json', Buffer.from(JSON.stringify({ schema: 2, preferences: bundle.preferences.settings })));
    return files;
  }

  private async decodeArchiveBytes(
    bytes: Buffer,
    nameHint: string,
    unlock?: PortableSpaceUnlock,
    untrusted = false,
    readOnly = false,
  ): Promise<{
    files: Map<string, Buffer>;
    format: PortableSpaceFormat;
    encryptionMode: PortableSpaceTree['encryptionMode'];
    matchedPassphrase?: string;
  }> {
    let encryptionMode: PortableSpaceTree['encryptionMode'] = 'none';
    let matchedPassphrase: string | undefined;
    const format: PortableSpaceFormat = pathFormat(nameHint) === 'age'
      || bytes.subarray(0, 21).toString('ascii') === 'age-encryption.org/v1'
      || bytes.subarray(0, 14).toString('ascii') === '-----BEGIN AGE'
      ? 'age'
      : 'tgz';
    const unpackOptions = untrusted ? REMOTE_ARCHIVE_LIMITS : undefined;
    let files: Map<string, Buffer>;
    if (format === 'age') {
      const decoded = await decodeAge(bytes, unlock, this.sync, undefined, readOnly);
      encryptionMode = decoded.mode;
      if (decoded.mode === 'passphrase') matchedPassphrase = decoded.matchedPassphrase;
      files = unpackTarGz(decoded.bytes, unpackOptions);
    } else if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      files = unpackTarGz(bytes, unpackOptions);
    } else {
      files = this.legacy(bytes);
    }
    return { files, format, encryptionMode, matchedPassphrase };
  }

  private async buildLoadedTree(
    rawFiles: Map<string, Buffer>,
    format: PortableSpaceFormat,
    encryptionMode: PortableSpaceTree['encryptionMode'],
    matchedPassphrase: string | undefined,
    label: string,
    options: LoadOptions,
    untrusted = false,
    etag?: string,
    subscriptionOrigin?: string,
  ): Promise<LoadedSpaceTree> {
    const files = new Map(rawFiles);
    let effectiveEncryption = encryptionMode;
    let effectivePassphrase = matchedPassphrase;
    const sealed = files.get(SEALED);
    if (sealed) {
      if (files.has(PLAIN)) throw new Error('Portable Space contains both plain and sealed credentials');
      if (options.includeCredentials !== false) {
        const decoded = await decodeAge(sealed, options.unlock, this.sync, undefined, options.readOnly === true);
        if (format !== 'age') {
          effectiveEncryption = decoded.mode;
          if (decoded.mode === 'passphrase') effectivePassphrase = decoded.matchedPassphrase;
        }
        files.set(PLAIN, decoded.bytes);
      }
      files.delete(SEALED);
    }
    const sanitized = untrusted ? sanitizeRemoteSubscriptionFiles(files, subscriptionOrigin) : { files, excluded: [] };
    const { units, excluded: projectedExcluded } = toUnitsWithExcluded(sanitized.files, this.live.registry);
    const excluded = [...sanitized.excluded, ...projectedExcluded];
    for (const [id, item] of units) if (item.domain === 'memories' && options.includeMemories === false || item.domain === 'credentials' && options.includeCredentials === false) units.delete(id);
    const overlay = parseToml(sanitized.files.get('overlay.toml'));
    const unset = overlay['unset'] ?? [];
    if (sanitized.files.has('overlay.toml') && (overlay['schema'] !== 1 || overlay['mode'] !== 'overlay' || !Array.isArray(unset) || unset.some((item) => typeof item !== 'string' || item.length === 0))) throw new Error('Invalid portable overlay.toml');
    const recipients = parseRecipients(sanitized.files.get(RECIPIENTS)?.toString('utf8') ?? '');
    return {
      units,
      excluded: excluded.length ? excluded : undefined,
      unset: new Set(unset as string[]),
      overlay: overlay['mode'] === 'overlay',
      recipients,
      format,
      secretMode: [...units.values()].some((item) => item.domain === 'credentials') ? (sealed || format === 'age' ? 'sealed' : 'plain') : 'none',
      encryptionMode: effectiveEncryption,
      matchedPassphrase: effectivePassphrase,
      label: label.slice(0, 256) || 'Portable Space',
      fork: readFork(sanitized.files.get(FORK)),
      etag,
    };
  }

  async loadUrl(
    endpoint: Extract<PortableSpaceEndpoint, { kind: 'url' }>,
    options: LoadOptions = {},
  ): Promise<LoadedUrlTreeResult> {
    const fetched = await fetchSubscriptionArchive(endpoint.url, {
      ifNoneMatch: options.ifNoneMatch,
      ifNoneMatchOrigin: options.ifNoneMatchOrigin,
      fetchFn: this.urlFetchOptions?.fetchFn,
      lookupFn: this.urlFetchOptions?.lookupFn,
      allowLoopback: this.urlFetchOptions?.allowLoopback,
      signal: options.signal,
    });
    if (fetched.status === 'not_modified') {
      return { status: 'not_modified', etag: fetched.etag, finalOrigin: fetched.finalOrigin };
    }
    const pathname = new URL(endpoint.url).pathname;
    const decoded = await this.decodeArchiveBytes(fetched.bytes, pathname, options.unlock, true, options.readOnly === true);
    const tree = await this.buildLoadedTree(
      decoded.files,
      decoded.format,
      decoded.encryptionMode,
      decoded.matchedPassphrase,
      defaultLabelForSubscriptionUrl(endpoint.url),
      options,
      true,
      fetched.etag,
      fetched.finalOrigin,
    );
    return { status: 'ok', tree, etag: fetched.etag, finalOrigin: fetched.finalOrigin };
  }

  async load(endpoint: PortableSpaceEndpoint, options: LoadOptions = {}): Promise<LoadedSpaceTree> {
    if (endpoint.kind === 'url') {
      const result = await this.loadUrl(endpoint, { ...options, ifNoneMatch: undefined });
      if (result.status !== 'ok') throw new Error('Unexpected 304 response while loading URL source');
      return result.tree;
    }
    let files: Map<string, Buffer>;
    let format: PortableSpaceFormat = 'dir';
    let encryptionMode: PortableSpaceTree['encryptionMode'] = 'none';
    let matchedPassphrase: string | undefined;
    let label: string;
    switch (endpoint.kind) {
      case 'live': {
        const space = await this.liveEndpoint(endpoint.spaceId);
        label = space.name;
        files = endpoint.spaceId === (this.live.bootstrap.spaceId ?? 'main')
          ? await readLive(this.live, options.sessions ?? NO_SESSIONS, options.targetPlatform, options.includeMemories, options.includeCredentials)
          : await this.readRegisteredHome(space.path, options);
        break;
      }
      case 'dir':
        label = basename(resolve(endpoint.path));
        files = await readTree(endpoint.path, false);
        break;
      case 'git':
        label = endpoint.repo;
        files = await scratch(async (root) => {
          const destination = join(root, 'repo');
          await git(root, ['clone', '--depth', '1', ...(endpoint.ref ? ['--branch', endpoint.ref] : []), '--', gitRemote(endpoint.repo), destination]);
          return readTree(endpoint.subpath ? await checkedPath(destination, endpoint.subpath) : destination, false);
        });
        break;
      case 'archive': {
        label = basename(resolve(endpoint.path));
        const bytes = await readBounded(endpoint.path);
        const decoded = await this.decodeArchiveBytes(bytes, endpoint.path, options.unlock, options.untrustedArchive === true, options.readOnly === true);
        files = decoded.files;
        format = decoded.format;
        encryptionMode = decoded.encryptionMode;
        matchedPassphrase = decoded.matchedPassphrase;
        break;
      }
    }
    return this.buildLoadedTree(files, format, encryptionMode, matchedPassphrase, label, options, options.untrustedArchive === true);
  }

  async destination(input: string): Promise<PortableSpaceEndpoint> {
    const metadata = await missing(stat(input));
    return endpointForPath(input, metadata?.isDirectory() ? 'dir' : pathFormat(input));
  }

  async publish(endpoint: Extract<PortableSpaceEndpoint, { kind: 'git' }>, tree: PortableSpaceTree, before: PortableSpaceTree, options: WriteOptions, unlock?: PortableSpaceUnlock): Promise<void> {
    const branch = endpoint.ref;
    if (!branch || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)) throw new Error('Git publication requires an explicit branch');
    const remote = gitRemote(endpoint.repo);
    await scratch(async (scratchRoot) => {
      const checkout = join(scratchRoot, 'repo');
      await git(scratchRoot, ['check-ref-format', `refs/heads/${branch}`]);
      await git(scratchRoot, ['clone', '--depth', '1', '--branch', branch, '--', remote, checkout]);
      if (await git(checkout, ['branch', '--show-current']) !== branch) throw new Error('Git publication requires a branch, not a tag');
      const target = endpoint.subpath ? await checkedPath(checkout, endpoint.subpath) : checkout;
      const fresh = await this.load({ kind: 'dir', path: target }, { unlock });
      if (!equalEndpointContent(fresh, before)) throw new Error('Git branch changed since preview');
      const opts = { ...options, format: 'dir' as const, secretMode: options.secretMode === 'plain' ? 'sealed' as const : options.secretMode };
      await this.write(target, tree, opts);
      await git(target, ['add', '--all', '--', '.']);
      if (!(await git(target, ['diff', '--cached', '--name-only']))) return;
      await git(target, ['-c', 'user.name=Kiki Portable Spaces', '-c', 'user.email=kiki-space@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Update portable Kiki Space']);
      await git(target, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
    });
  }

  async write(destination: string, tree: PortableSpaceTree, options: WriteOptions = {}): Promise<PortableSpaceExportReceipt> {
    const format = options.format ?? pathFormat(destination);
    const secretMode = options.secretMode ?? (format === 'tgz' ? 'none' : 'sealed');
    const units = secretMode === 'none' ? new Map([...tree.units].filter(([, unit]) => unit.domain !== 'credentials')) : tree.units;
    const files = filesFromUnits(units);
    const plain = files.get(PLAIN);
    const actualSecretMode = plain ? (format === 'age' ? 'sealed' : secretMode) : 'none';
    if (tree.overlay) files.set('overlay.toml', encodeToml({ schema: 1, mode: 'overlay', unset: [...tree.unset] }));
    if (tree.fork) files.set(FORK, Buffer.from(`${JSON.stringify(tree.fork, null, 2)}\n`));
    let encryptionMode: PortableSpaceTree['encryptionMode'] = 'none';
    const known = tree.recipients.length ? tree.recipients : await this.knownRecipients();
    const roster = [...known];
    if (!tree.recipients.length && (format === 'age' || secretMode === 'sealed' && plain) && options.encryption?.mode !== 'passphrase' && !options.encryption?.recipients?.length) {
      const { recipient } = await this.sync.ensureDeviceKeypair();
      if (!roster.some((entry) => entry.recipient === recipient)) roster.unshift({ recipient });
    }
    const attachRoster = (recipients: string[]) => {
      if (recipients.length) {
        const labels = new Map(roster.map((entry) => [entry.recipient, entry]));
        files.set(RECIPIENTS, Buffer.from(`${formatRecipients(recipients.map((recipient) => labels.get(recipient) ?? recipient))}\n`));
      }
    };
    let bytes: number;
    if (format === 'age') {
      let encryption = options.encryption;
      if (encryption?.mode !== 'passphrase') {
        const recipientValues = encryption?.recipients?.length ? encryption.recipients : roster.length ? roster.map((entry) => entry.recipient) : [(await this.sync.ensureDeviceKeypair()).recipient];
        attachRoster(recipientValues);
        encryption = { mode: 'x25519', recipients: recipientValues };
      }
      const result = await encodeAge(packTarGz(files), encryption, [], this.sync);
      encryptionMode = result.mode;
      bytes = result.bytes.length;
      await writeFileAtomic(destination, result.bytes, 0o600);
    } else {
      if (secretMode === 'sealed' && plain) {
        const result = await encodeAge(plain, options.encryption, roster.map(({ recipient }) => recipient), this.sync);
        files.delete(PLAIN);
        files.set(SEALED, result.bytes);
        attachRoster(result.recipients);
        encryptionMode = result.mode;
      } else if (tree.recipients.length) attachRoster(tree.recipients.map((entry) => entry.recipient));
      if (format === 'dir') {
        bytes = [...files.values()].reduce((total, file) => total + file.length, 0);
        await this.assertPortableDirectory(destination);
        await writeTree(destination, files, options.gitInit === true, options.replaceManaged === true);
      } else {
        const buffer = packTarGz(files);
        bytes = buffer.length;
        await writeFileAtomic(destination, buffer, actualSecretMode === 'plain' ? 0o600 : 0o644);
      }
    }
    const excluded = tree.excluded?.length ? tree.excluded : undefined;
    return { destination, format, spaceMode: tree.overlay ? 'overlay' : 'full', secretMode: actualSecretMode, encryptionMode, domains: counts(units), totalItems: units.size, bytes, excluded };
  }
}
