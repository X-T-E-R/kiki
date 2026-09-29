import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from 'node:path';

import { IBootstrapService, ISshHostService, IWorkspaceService, type Scope } from '@kiki/agent-core-v2';
import { readSpaceHome } from '@kiki/agent-core-v2/app/bootstrap/spaceHome';
import { SshCredentialStore } from '@kiki/agent-core-v2/persistence/backends/node-fs/sshCredentialStore';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { listLiveServerInstances } from '../instanceRegistry';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  attachSpaceRequestSchema, createSpaceRequestSchema, spaceIdParamsSchema,
  spaceRecordSchema, spacesResponseSchema, deleteSpaceParamsSchema, deleteSpaceRequestSchema,
  updateSpaceRequestSchema, updateSpaceResponseSchema, sshCopyCandidatesResponseSchema,
} from '../protocol/rest-space';
import { parseActionSuffix } from './action-suffix';

type SpaceRecord = z.infer<typeof spaceRecordSchema>;
interface HomesRouteHost {
  get(path: string, options: { schema?: Record<string, unknown> }, handler: (req: { id: string }, reply: { send(payload: unknown): void }) => Promise<void>): unknown;
  post(path: string, options: { schema?: Record<string, unknown> }, handler: (req: { id: string; body: unknown }, reply: { send(payload: unknown): void }) => Promise<void>): unknown;
  patch(path: string, options: { schema?: Record<string, unknown> }, handler: (req: { id: string; params: unknown; body: unknown }, reply: { send(payload: unknown): void }) => Promise<void>): unknown;
  delete(path: string, options: { schema?: Record<string, unknown> }, handler: (req: { id: string; params: unknown }, reply: { send(payload: unknown): void }) => Promise<void>): unknown;
}

function samePath(a: string, b: string): boolean {
  const left = normalize(resolve(a));
  const right = normalize(resolve(b));
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function readHomes(main: string): Promise<SpaceRecord[]> {
  try {
    return z.array(spaceRecordSchema).parse(JSON.parse(await readFile(join(main, 'homes.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeHomes(main: string, records: SpaceRecord[]): Promise<void> {
  const path = join(main, 'homes.json');
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function childRecord(path: string, main: string): SpaceRecord {
  const result = readSpaceHome(path);
  if (result.space === undefined || result.diagnostic !== undefined) {
    throw new Error(result.diagnostic ?? 'No valid home.toml exists in this space');
  }
  if (result.space.baseHomeDir === undefined || !samePath(result.space.baseHomeDir, main)) {
    throw new Error('The space must inherit from this main home');
  }
  return { id: result.space.id, name: result.space.name, color: result.space.color, path };
}

function spaceView(record: SpaceRecord): SpaceRecord & { credentials_shared?: boolean } {
  const space = readSpaceHome(record.path).space;
  return space?.id === record.id
    ? { ...record, name: space.name, color: space.color, credentials_shared: space.inherit.credentials === 'shared' }
    : record;
}

function listResponse(main: string, records: SpaceRecord[]) {
  return { items: [
    { id: 'main', name: 'Main space', path: main, primary: true, credentials_shared: true },
    ...records.map((record) => ({ ...spaceView(record), primary: false })),
  ] };
}

function withCredentialMode(text: string, mode: 'shared' | 'isolated'): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const header = /^[ \t]*\[inherit\][ \t]*(?:#.*)?(?:\r?\n|$)/m.exec(text);
  if (header === null) return `${text.trimEnd()}${newline}${newline}[inherit]${newline}credentials = "${mode}"${newline}`;
  const start = header.index + header[0].length;
  const tail = text.slice(start);
  const next = /^[ \t]*\[[^\]\r\n]+\]/m.exec(tail);
  const end = next === null ? text.length : start + next.index;
  const section = text.slice(start, end);
  const authored = /^([ \t]*credentials[ \t]*=[ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*')/m;
  const replaced = authored.test(section)
    ? section.replace(authored, (_match, prefix: string) => `${prefix}"${mode}"`)
    : `credentials = "${mode}"${newline}${section}`;
  return text.slice(0, start) + replaced + text.slice(end);
}

async function retainedIsolatedSshEntries(home: string): Promise<number | undefined> {
  const directory = join(home, 'credentials', 'ssh');
  try {
    const files = await readdir(directory);
    const manifest = await readFile(join(directory, 'keyring-accounts.json'), 'utf8')
      .then((text) => JSON.parse(text) as unknown)
      .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : undefined);
    if (!Array.isArray(manifest) || !manifest.every((account) => typeof account === 'string')) return undefined;
    return new Set([
      ...manifest.map((account: string) => account.slice(account.lastIndexOf('/') + 1)),
      ...files.filter((file) => file.endsWith('.secret')).map((file) => file.slice(0, -'.secret'.length)),
    ]).size;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : undefined;
  }
}

function requireMainSpace(scope: Scope): string {
  const bootstrap = scope.accessor.get(IBootstrapService);
  if (bootstrap.spaceId !== undefined) throw new Error('Manage spaces from the main space window');
  return bootstrap.homeDir;
}

type SshCredentialAccess = Pick<SshCredentialStore, 'read' | 'save'>;
type SshCredentialFactory = (home: string, spaceId?: string) => SshCredentialAccess;
const defaultCredentialFactory: SshCredentialFactory = (home, spaceId) => new SshCredentialStore(home, undefined, spaceId);
type SshCopyTarget = { hostId: string; workspaceId?: string };
type SshCopyCandidate = SshCopyTarget & { name: string; credential_kinds: ('password' | 'passphrase')[] };

async function savedSshCandidates(scope: Scope, main: string, factory: SshCredentialFactory): Promise<SshCopyCandidate[]> {
  const source = factory(main);
  const hosts = scope.accessor.get(ISshHostService);
  const workspaces = await scope.accessor.get(IWorkspaceService).list();
  const candidates: SshCopyCandidate[] = [];
  for (const workspaceId of [undefined, ...workspaces.map((workspace) => workspace.id)]) {
    for (const host of await hosts.list(workspaceId)) {
      if (host.source !== 'kiki') continue;
      const account = JSON.stringify([workspaceId ?? '', host.id]);
      const credential_kinds: ('password' | 'passphrase')[] = [];
      for (const kind of ['password', 'passphrase'] as const) {
        if (await source.read(account, kind) !== undefined) credential_kinds.push(kind);
      }
      if (credential_kinds.length > 0) candidates.push({ hostId: host.id, workspaceId, name: host.name, credential_kinds });
    }
  }
  return candidates;
}

async function copySavedSsh(
  scope: Scope, main: string, record: SpaceRecord,
  choice: true | { hosts: SshCopyTarget[] }, factory: SshCredentialFactory,
): Promise<number> {
  const candidates = await savedSshCandidates(scope, main, factory);
  const selected = choice === true ? candidates : choice.hosts.map((target) => {
    const candidate = candidates.find((item) => item.hostId === target.hostId && item.workspaceId === target.workspaceId);
    if (candidate === undefined) throw new Error(`No saved SSH credential for ${target.hostId} in the selected main-space workspace`);
    return candidate;
  });
  const source = factory(main);
  const isolated = factory(record.path, record.id);
  const seen = new Set<string>();
  let copied = 0;
  for (const target of selected) {
    const account = JSON.stringify([target.workspaceId ?? '', target.hostId]);
    if (seen.has(account)) continue;
    seen.add(account);
    for (const kind of target.credential_kinds) {
      const value = await source.read(account, kind);
      if (value === undefined) throw new Error(`Saved SSH ${kind} changed during copying for ${target.hostId}`);
      await isolated.save(account, kind, value);
      copied++;
    }
  }
  return copied;
}

export function registerHomesRoutes(app: HomesRouteHost, scope: Scope, credentialFactory: SshCredentialFactory = defaultCredentialFactory): void {
  let writes: Promise<void> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const task = writes.then(work);
    writes = task.then(() => undefined, () => undefined);
    return task;
  }
  const main = scope.accessor.get(IBootstrapService).baseHomeDir ?? scope.accessor.get(IBootstrapService).homeDir;
  const list = defineRoute({
    method: 'GET', path: '/homes', success: { data: spacesResponseSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'List registered spaces and the main space without starting their backends', tags: ['homes'],
  }, async (req, reply) => {
    try {
      const records = await readHomes(main);
      reply.send(okEnvelope(listResponse(main, records), req.id));
    } catch (error) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `Cannot read spaces: ${String(error)}`, req.id));
    }
  });
  app.get(list.path, list.options, list.handler as Parameters<HomesRouteHost['get']>[2]);

  const create = defineRoute({
    method: 'POST', path: '/homes', body: createSpaceRequestSchema,
    success: { data: spaceRecordSchema }, errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Create a new space and register it in the main home', tags: ['homes'],
  }, async (req, reply) => {
    try {
      const record = await serialized(async () => {
        const base = requireMainSpace(scope);
        if (!isAbsolute(req.body.path) || samePath(req.body.path, base)) throw new Error('Space path must be a distinct absolute directory');
        const path = normalize(req.body.path);
        const records = await readHomes(base);
        if (records.some((item) => samePath(item.path, path))) throw new Error('This space is already registered');
        await mkdir(dirname(path), { recursive: true });
        await mkdir(path);
        const id = `h-${randomBytes(8).toString('hex')}`;
        const inherit = req.body.inherit ?? {};
        const lines = [
          'schema = 1', `id = ${JSON.stringify(id)}`, `name = ${JSON.stringify(req.body.name)}`,
          ...(req.body.color === undefined ? [] : [`color = ${JSON.stringify(req.body.color)}`]),
          `base = ${JSON.stringify(base)}`, '', '[inherit]',
          ...Object.entries(inherit).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), '',
        ];
        await writeFile(join(path, 'home.toml'), lines.join('\n'), { flag: 'wx', mode: 0o600 });
        const created = childRecord(path, base);
        await writeHomes(base, [...records, created]);
        return created;
      });
      reply.send(okEnvelope(record, req.id));
    } catch (error) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `Cannot create space: ${String(error)}`, req.id));
    }
  });
  app.post(create.path, create.options, create.handler as Parameters<HomesRouteHost['post']>[2]);

  const attach = defineRoute({
    method: 'POST', path: '/homes:attach', body: attachSpaceRequestSchema,
    success: { data: spaceRecordSchema }, errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Register an existing space with this main home without changing its files', tags: ['homes'],
  }, async (req, reply) => {
    try {
      const record = await serialized(async () => {
        const base = requireMainSpace(scope);
        if (!isAbsolute(req.body.path) || samePath(req.body.path, base)) throw new Error('Space path must be a distinct absolute directory');
        const record = childRecord(normalize(req.body.path), base);
        const records = await readHomes(base);
        if (records.some((item) => item.id === record.id || samePath(item.path, record.path))) throw new Error('This space is already registered');
        await writeHomes(base, [...records, record]);
        return record;
      });
      reply.send(okEnvelope(record, req.id));
    } catch (error) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `Cannot attach space: ${String(error)}`, req.id));
    }
  });
  app.post(attach.path, attach.options, attach.handler as Parameters<HomesRouteHost['post']>[2]);

  const candidates = defineRoute({
    method: 'GET', path: '/homes/{id}/ssh-copy-candidates', params: spaceIdParamsSchema,
    success: { data: sshCopyCandidatesResponseSchema }, errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'List main-space Kiki SSH hosts with saved password or passphrase eligible for explicit copying into an isolated space', tags: ['homes'],
  }, async (req, reply) => {
    try {
      const base = requireMainSpace(scope);
      const entry = (await readHomes(base)).find((record) => record.id === req.params.id);
      if (entry === undefined) throw new Error('Space is not registered');
      childRecord(entry.path, base);
      if (readSpaceHome(entry.path).space?.inherit.credentials !== 'shared') throw new Error('Only shared-credential spaces can copy main SSH secrets');
      reply.send(okEnvelope({ hosts: await savedSshCandidates(scope, base, credentialFactory) }, req.id));
    } catch (error) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `Cannot list SSH copy candidates: ${String(error)}`, req.id));
    }
  });
  app.get(candidates.path, candidates.options, candidates.handler as Parameters<HomesRouteHost['get']>[2]);

  const update = defineRoute({
    method: 'PATCH', path: '/homes/{id}', params: spaceIdParamsSchema,
    body: updateSpaceRequestSchema, success: { data: updateSpaceResponseSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Change an existing space credential mode; a running backend keeps its old mode until restart', tags: ['homes'],
  }, async (req, reply) => {
    try {
      const result = await serialized(async () => {
        const base = requireMainSpace(scope);
        const records = await readHomes(base);
        const record = records.find((entry) => entry.id === req.params.id);
        if (record === undefined) throw new Error('Space is not registered');
        const metadata = childRecord(record.path, base);
        if (metadata.id !== record.id) throw new Error('Space identity changed since registration');
        const space = readSpaceHome(record.path).space;
        if (space === undefined) throw new Error('Space home.toml is invalid');
        const previous = space.inherit.credentials;
        const desired = req.body.inherit.credentials;
        const copyChoice = req.body.copy_ssh_credentials;
        if (copyChoice !== undefined && (previous !== 'shared' || desired !== 'isolated')) {
          throw new Error('SSH copying only applies when changing from shared to isolated credentials');
        }
        const file = join(record.path, 'home.toml');
        const liveBefore = await listLiveServerInstances(record.path);
        const copied = copyChoice === undefined || copyChoice === false ? 0
          : await copySavedSsh(scope, base, record, copyChoice, credentialFactory);
        if (previous !== desired) {
          const contents = await readFile(file, 'utf8');
          const temporary = `${file}.tmp-${randomUUID()}`;
          try {
            await writeFile(temporary, withCredentialMode(contents, desired), { flag: 'wx', mode: 0o600 });
            await rename(temporary, file);
          } finally {
            await rm(temporary, { force: true });
          }
          if (readSpaceHome(record.path).space?.inherit.credentials !== desired) throw new Error('Updated home.toml did not preserve the space identity');
        }
        const modifiedAt = (await stat(file)).mtimeMs;
        const liveAfter = await listLiveServerInstances(record.path);
        const restartRequired = [...liveBefore, ...liveAfter].some((instance) => instance.startedAt <= modifiedAt);
        const retained = previous === 'isolated' && desired === 'shared'
          ? await retainedIsolatedSshEntries(record.path) : undefined;
        return {
          space: { ...spaceView(record), credentials_shared: desired === 'shared' },
          restart_required: restartRequired,
          copied_ssh_entries: copied,
          ...(retained === undefined ? {} : { retained_isolated_ssh_entries: retained }),
        };
      });
      reply.send(okEnvelope(result, req.id));
    } catch (error) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `Cannot update space: ${String(error)}`, req.id));
    }
  });
  app.patch(update.path, update.options, update.handler as Parameters<HomesRouteHost['patch']>[2]);

  const erase = defineRoute({
    method: 'POST', path: '/homes/{tail}', params: deleteSpaceParamsSchema,
    body: deleteSpaceRequestSchema,
    success: { data: spacesResponseSchema }, errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Permanently delete a registered space after exact-name confirmation, only while no backend is running', tags: ['homes'],
  }, async (req, reply) => {
    const action = parseActionSuffix({ tail: req.params.tail, allowedActions: ['delete'], resourceLabel: 'space' });
    if (action.kind !== 'action' || !spaceIdParamsSchema.safeParse({ id: action.id }).success) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Unsupported space action', req.id));
      return;
    }
    try {
      const records = await serialized(async () => {
        const base = requireMainSpace(scope);
        const current = await readHomes(base);
        const entry = current.find((item) => item.id === action.id);
        if (entry === undefined) throw new Error('Space is not registered');
        const path = normalize(entry.path);
        const metadata = childRecord(path, base);
        if (metadata.id !== entry.id || metadata.name !== req.body.confirm_name) throw new Error('Space identity or confirmed name does not match');
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Space path must be a real directory');
        const target = await realpath(path);
        const mainPath = await realpath(base);
        const fold = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
        if (samePath(target, mainPath) || fold(mainPath).startsWith(`${fold(target)}${sep}`) || samePath(target, parse(target).root)) {
          throw new Error('Space path cannot contain the main home or a filesystem root');
        }
        if ((await listLiveServerInstances(path)).length > 0) throw new Error('Close this space window and backend before deletion');
        await rm(path, { recursive: true, force: false });
        const next = current.filter((item) => item.id !== entry.id);
        await writeHomes(base, next);
        return next;
      });
      reply.send(okEnvelope(listResponse(main, records), req.id));
    } catch (error) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `Cannot delete space: ${String(error)}`, req.id));
    }
  });
  app.post(erase.path, erase.options, erase.handler as Parameters<HomesRouteHost['post']>[2]);

  const remove = defineRoute({
    method: 'DELETE', path: '/homes/{id}', params: spaceIdParamsSchema,
    success: { data: spacesResponseSchema }, errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Remove a space from the launcher list without deleting its files', tags: ['homes'],
  }, async (req, reply) => {
    try {
      const records = await serialized(async () => {
        const base = requireMainSpace(scope);
        const current = await readHomes(base);
        if (!current.some((item) => item.id === req.params.id)) throw new Error('Space is not registered');
        const next = current.filter((item) => item.id !== req.params.id);
        await writeHomes(base, next);
        return next;
      });
      reply.send(okEnvelope(listResponse(main, records), req.id));
    } catch (error) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `Cannot remove space: ${String(error)}`, req.id));
    }
  });
  app.delete(remove.path, remove.options, remove.handler as Parameters<HomesRouteHost['delete']>[2]);
}
