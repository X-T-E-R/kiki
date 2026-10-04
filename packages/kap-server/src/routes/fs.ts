import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';

import { canonicalWorkspaceRoot } from '@kiki/agent-core-v2/_base/utils/paths';
import {
  ErrorCodes,
  IRuntimeResolver,
  IHostFileSystem,
  ISessionContext,
  ISessionWorkspaceContext,
  ITelemetryService,
  IWorkspaceFsService,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  isError2,
  type ISessionScopeHandle,
  type Scope,
} from '@kiki/agent-core-v2';
import {
  fsDiffRequestSchema,
  fsGitStatusRequestSchema,
  fsGrepRequestSchema,
  fsListManyRequestSchema,
  fsListRequestSchema,
  fsMkdirRequestSchema,
  fsReadRequestSchema,
  fsSearchRequestSchema,
  fsSearchResponseSchema,
  fsStatManyRequestSchema,
  fsStatRequestSchema,
  fsSuggestRequestSchema,
  fsSuggestResponseSchema,
} from '@kiki/agent-core-v2/workspace/workspaceFs/fs';
import { GitService } from '@kiki/agent-core-v2/app/git/gitService';
import { IBootstrapService } from '@kiki/agent-core-v2/app/bootstrap/bootstrap';
import type { IWorktreeService } from '@kiki/agent-core-v2/app/git/worktreeModel';
import { ITemporaryLocalRuntimeResolver, type TemporaryRuntimeLease } from '@kiki/agent-core-v2/workspace/workspaceInstance/workspaceInstanceManager';
import type { RuntimeCapability, RuntimeLease } from '@kiki/agent-core-v2/runtime/runtime';
import { WorkspaceFsService } from '@kiki/agent-core-v2/workspace/workspaceFs/fsService';
import { WorkspaceGitService } from '@kiki/agent-core-v2/workspace/workspaceGit/workspaceGitService';
import type { IWorkspaceContext } from '@kiki/agent-core-v2/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceDirs } from '@kiki/agent-core-v2/workspace/workspaceDirs/workspaceDirs';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import {
  launchDetached,
  openFileCommandFor,
  openInAppCommandFor,
  revealFileCommandFor,
} from '../lib/fileLaunch';
import { parseRangeHeader, pickHeader } from '../lib/httpRange';
import { requestLog } from '../lib/requestLog';
import { acquireSessionOperation, type SessionOperationLease } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  fsOpenInRequestSchema,
  fsOpenRequestSchema,
  fsRevealRequestSchema,
} from '../protocol/rest-fs';

const noRuntimeWorktrees = {
  forPath: async () => undefined,
} as unknown as IWorktreeService;

interface FsRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown; query: unknown; headers: Record<string, unknown> },
      reply: FsDownloadReply,
    ) => unknown,
  ): unknown;
}

interface FsDownloadReply {
  readonly raw: { once(event: 'finish' | 'close', listener: () => void): unknown };
  type(mime: string): FsDownloadReply;
  header(name: string, value: string | number): FsDownloadReply;
  code(status: number): FsDownloadReply;
  send(payload: unknown): unknown;
}

const sessionIdAndTailParamSchema = z.object({
  session_id: z.string().min(1),
  tail: z.string().min(1),
});

const fsDownloadQuerySchema = z.object({
  runtime_id: z.string().min(1).optional(),
});

const workspaceFsSearchBodySchema = fsSearchRequestSchema.extend({
  workspace: z.string().min(1),
  runtime_id: z.string().min(1).optional(),
});

const workspaceFsSuggestBodySchema = fsSuggestRequestSchema.extend({
  workspace: z.string().min(1),
  runtime_id: z.string().min(1).optional(),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const FS_ACTIONS = [
  'list',
  'read',
  'list_many',
  'stat',
  'stat_many',
  'mkdir',
  'search',
  'grep',
  'git_status',
  'diff',
  'open',
  'open-in',
  'reveal',
] as const;
type FsAction = (typeof FS_ACTIONS)[number];
const FS_TAIL_PREFIX = 'fs:';

interface RuntimeFsScope {
  readonly fs: IWorkspaceFsService;
  readonly hostFs: IHostFileSystem;
  readonly lease: RuntimeLease | TemporaryRuntimeLease;
}

function createRuntimeFs(
  core: Scope,
  workspaceId: string,
  roots: { readonly workDir: string; readonly additionalDirs?: readonly string[] },
  runtimeId: string,
  required: readonly RuntimeCapability[],
  draftLease?: TemporaryRuntimeLease,
): RuntimeFsScope {
  const lease = draftLease ?? core.accessor.get(IRuntimeResolver).acquire(
    { workspaceId, runtimeId },
    required,
  );
  try {
    const mapped = lease.runtime.workspace.mapRoots(roots);
    const workspace = {
      _serviceBrand: undefined,
      workspaceId,
      cwd: mapped.workDir,
      source: 'local',
      meta: {
        id: workspaceId,
        root: mapped.workDir,
        name: workspaceId,
        createdAt: 0,
        lastOpenedAt: 0,
      },
      persistenceScope: `sessions/${workspaceId}`,
    } satisfies IWorkspaceContext;
    const dirs = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      additionalDirs: mapped.additionalDirs ?? [],
      onDidChange: () => ({ dispose: () => {} }),
      addDir: async () => { throw new Error('runtime fs directories are immutable'); },
      mergeAdditionalDirs: async () => { throw new Error('runtime fs directories are immutable'); },
      sessionInfo: () => ({ workDir: mapped.workDir, additionalDirs: mapped.additionalDirs ?? [] }),
    } as unknown as IWorkspaceDirs;
    const resolver: IRuntimeResolver = {
      _serviceBrand: undefined,
      inspect: () => lease.runtime,
      acquire: (_binding, capabilities = []) => {
        const missing = capabilities.filter((capability) => !lease.runtime.capabilities.has(capability));
        if (missing.length > 0) throw new Error(`runtime ${runtimeId} missing capabilities: ${missing.join(', ')}`);
        return {
          runtime: lease.runtime,
          track: (resource) => lease.track(resource),
          dispose: () => {},
        };
      },
    };
    const mappedRoot = canonicalWorkspaceRoot(mapped.workDir);
    const mappedPrefix = mappedRoot.endsWith('/') ? mappedRoot : `${mappedRoot}/`;
    const instances = {
      findContaining: (cwd: string) => {
        const path = canonicalWorkspaceRoot(cwd);
        return path === mappedRoot || path.startsWith(mappedPrefix) ? { id: workspaceId } : undefined;
      },
    } as unknown as IWorkspaceInstanceManager;
    const git = new WorkspaceGitService(
      workspace,
      {
        current: new GitService(resolver, instances, lease.runtime.fs!, noRuntimeWorktrees),
        onDidChange: () => ({ dispose: () => {} }),
      },
    );
    return {
      fs: new WorkspaceFsService(
        workspace,
        dirs,
        lease.runtime.fs!,
        resolver,
        core.accessor.get(ITelemetryService),
        git,
        core.accessor.get(IBootstrapService),
        runtimeId,
      ),
      hostFs: lease.runtime.fs!,
      lease,
    };
  } catch (error) {
    if (draftLease === undefined) lease.dispose();
    throw error;
  }
}

function acquireSessionFs(
  core: Scope,
  session: ISessionScopeHandle,
  runtimeId: string,
  required: readonly RuntimeCapability[],
): RuntimeFsScope {
  const context = session.accessor.get(ISessionContext);
  const workspace = session.accessor.get(ISessionWorkspaceContext);
  return createRuntimeFs(core, context.workspaceId, workspace, runtimeId, required);
}

async function resolveWorkspaceFs(
  core: Scope,
  ref: string,
  runtimeId: string,
  required: readonly RuntimeCapability[],
): Promise<RuntimeFsScope | undefined> {
  const workspaces = core.accessor.get(IWorkspaceService);
  const ws = await workspaces.get(ref);
  if (ws === undefined) {
    if (!isAbsolute(ref) || runtimeId !== 'local') return undefined;
    const lease = await core.accessor.get(ITemporaryLocalRuntimeResolver).acquire(ref, required);
    try {
      let directory = false;
      try {
        directory = (await lease.runtime.fs!.stat(ref)).isDirectory;
      } catch {
        directory = false;
      }
      if (!directory) {
        await lease.dispose();
        return undefined;
      }
      return createRuntimeFs(core, ref, { workDir: ref }, runtimeId, required, lease);
    } catch (error) {
      await lease.dispose();
      throw error;
    }
  }
  await core.accessor
    .get(IWorkspaceInstanceManager)
    .getOrCreate({ workspaceId: ws.id, root: ws.root });
  return createRuntimeFs(core, ws.id, { workDir: ws.root }, runtimeId, required);
}

export function registerFsRoutes(app: FsRouteHost, core: Scope): void {
  const fsActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/{tail}',
      params: sessionIdAndTailParamSchema,
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_IS_DIRECTORY]: {},
        [ErrorCode.FS_IS_BINARY]: {},
        [ErrorCode.FS_TOO_LARGE]: {},
        [ErrorCode.FS_TOO_MANY_RESULTS]: {},
        [ErrorCode.FS_PATH_ESCAPES_SESSION]: {},
        [ErrorCode.FS_GREP_TIMEOUT]: {},
        [ErrorCode.FS_GIT_UNAVAILABLE]: {},
        [ErrorCode.FS_ALREADY_EXISTS]: {},
      },
      description:
        'Filesystem action dispatcher. Supported actions: list, read, list_many, stat, stat_many, mkdir, search, grep, git_status, diff, open, open-in, reveal.',
      tags: ['fs'],
      operationId: 'fsAction',
    },
    async (req, reply) => {
      const { session_id, tail } = req.params as { session_id: string; tail: string };

      if (!tail.startsWith(FS_TAIL_PREFIX)) {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`, req.id),
        );
        return;
      }

      const action = tail.slice(FS_TAIL_PREFIX.length);
      if (!(FS_ACTIONS as readonly string[]).includes(action)) {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`, req.id),
        );
        return;
      }
      const fsAction = action as FsAction;

      let operation: SessionOperationLease | undefined;
      let runtimeFs: RuntimeFsScope | undefined;
      try {
        operation = await acquireSessionOperation(core, session_id, 'operation');
        const result = z.object({ runtime_id: z.string().min(1).optional() }).passthrough().safeParse(req.body ?? {});
        if (!result.success) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'request body must be an object', req.id));
          return;
        }
        const { runtime_id, ...request } = result.data;
        const runtimeId = runtime_id ?? 'local';
        req.body = request;
        const required: RuntimeCapability[] = ['fs'];
        if (fsAction === 'search' || fsAction === 'grep' || fsAction === 'git_status' || fsAction === 'diff') {
          required.push('process');
        }
        runtimeFs = operation.handle === undefined && fsAction === 'search'
          ? await resolveWorkspaceFs(core, session_id, runtimeId, required)
          : operation.handle === undefined
            ? undefined
            : acquireSessionFs(core, operation.handle, runtimeId, required);
        if (runtimeFs === undefined) {
          reply.send(
            errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
          );
          return;
        }
        if ((fsAction === 'open' || fsAction === 'open-in' || fsAction === 'reveal') && runtimeFs.lease.runtime.identity.runtimeId !== 'local') {
          throw new Error(`filesystem action ${fsAction} is unavailable on runtime ${runtimeId}`);
        }
        switch (fsAction) {
          case 'list':
            await handleList(runtimeFs.fs, req, reply);
            return;
          case 'read':
            await handleRead(runtimeFs.fs, req, reply);
            return;
          case 'list_many':
            await handleListMany(runtimeFs.fs, req, reply);
            return;
          case 'stat':
            await handleStat(runtimeFs.fs, req, reply);
            return;
          case 'stat_many':
            await handleStatMany(runtimeFs.fs, req, reply);
            return;
          case 'mkdir':
            await handleMkdir(runtimeFs.fs, req, reply);
            return;
          case 'search':
            await handleSearch(runtimeFs.fs, req, reply);
            return;
          case 'grep':
            await handleGrep(runtimeFs.fs, req, reply);
            return;
          case 'git_status':
            await handleGitStatus(runtimeFs.fs, req, reply);
            return;
          case 'diff':
            await handleDiff(runtimeFs.fs, req, reply);
            return;
          case 'open':
            await handleOpen(runtimeFs.fs, req, reply);
            return;
          case 'open-in':
            await handleOpenIn(runtimeFs.fs, session_id, req, reply);
            return;
          case 'reveal':
            await handleReveal(runtimeFs.fs, req, reply);
            return;
        }
      } catch (err) {
        sendMappedError(reply, req, err);
      } finally {
        await runtimeFs?.lease.dispose();
        operation?.dispose();
      }
    },
  );
  app.post(
    fsActionRoute.path,
    fsActionRoute.options,
    fsActionRoute.handler as unknown as Parameters<FsRouteHost['post']>[2],
  );

  const workspaceSearchRoute = defineRoute(
    {
      method: 'POST',
      path: '/workspace/fs::search',
      body: workspaceFsSearchBodySchema,
      success: { data: fsSearchResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.FS_TOO_MANY_RESULTS]: {},
      },
      description:
        'Search files without a session. `workspace` accepts a registered workspace id or an absolute root without registering it.',
      tags: ['fs'],
      operationId: 'workspaceFsSearch',
    },
    async (req, reply) => {
      const { workspace, runtime_id, ...searchRequest } = req.body;
      let runtimeFs: RuntimeFsScope | undefined;
      try {
        runtimeFs = await resolveWorkspaceFs(core, workspace, runtime_id ?? 'local', ['fs', 'process']);
        if (runtimeFs === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.WORKSPACE_NOT_FOUND,
              `workspace ${workspace} does not exist`,
              req.id,
            ),
          );
          return;
        }
        const data = await runtimeFs.fs.search(searchRequest);
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        sendMappedError(reply, req, err);
      } finally {
        await runtimeFs?.lease.dispose();
      }
    },
  );
  app.post(
    workspaceSearchRoute.path,
    workspaceSearchRoute.options,
    workspaceSearchRoute.handler as unknown as Parameters<FsRouteHost['post']>[2],
  );

  const workspaceSuggestRoute = defineRoute(
    {
      method: 'POST',
      path: '/workspace/fs::suggest',
      body: workspaceFsSuggestBodySchema,
      success: { data: fsSuggestResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description:
        'Suggest file and directory candidates without a session. `workspace` accepts a registered workspace id or an absolute root without registering it.',
      tags: ['fs'],
      operationId: 'workspaceFsSuggest',
    },
    async (req, reply) => {
      const { workspace, runtime_id, ...suggestRequest } = req.body;
      let runtimeFs: RuntimeFsScope | undefined;
      try {
        runtimeFs = await resolveWorkspaceFs(core, workspace, runtime_id ?? 'local', ['fs']);
        if (runtimeFs === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.WORKSPACE_NOT_FOUND,
              `workspace ${workspace} does not exist`,
              req.id,
            ),
          );
          return;
        }
        const data = await runtimeFs.fs.suggest(suggestRequest);
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        sendMappedError(reply, req, err);
      } finally {
        await runtimeFs?.lease.dispose();
      }
    },
  );
  app.post(
    workspaceSuggestRoute.path,
    workspaceSuggestRoute.options,
    workspaceSuggestRoute.handler as unknown as Parameters<FsRouteHost['post']>[2],
  );

  const downloadRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/fs/*',
      querystring: fsDownloadQuerySchema,
      rawResponse: {
        200: { type: 'string', format: 'binary' },
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_ESCAPES_SESSION]: {},
      },
      description: 'Download a file from the session workspace',
      tags: ['fs'],
      operationId: 'downloadFile',
    },
    async (req, reply) => {
      const { session_id } = req.params as { session_id: string };
      const wildcard = (req.params as Record<string, unknown>)['*'] as string;

      const DOWNLOAD_SUFFIX = ':download';
      if (!wildcard.endsWith(DOWNLOAD_SUFFIX)) {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${wildcard}`, req.id),
        );
        return;
      }
      const relPath = wildcard.slice(0, -DOWNLOAD_SUFFIX.length);
      if (relPath.length === 0) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'path is empty', req.id));
        return;
      }

      let operation: SessionOperationLease | undefined;
      let runtimeFs: RuntimeFsScope | undefined;
      let stream: Readable | undefined;
      try {
        operation = await acquireSessionOperation(core, session_id, 'operation');
        if (operation.handle === undefined) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id));
          return;
        }
        runtimeFs = acquireSessionFs(core, operation.handle, req.query.runtime_id ?? 'local', ['fs']);
        const resolved = await runtimeFs.fs.resolveDownload(relPath);
        const r = reply as unknown as FsDownloadReply;
        const ifNoneMatch = pickHeader(req.headers, 'if-none-match');
        if (ifNoneMatch !== undefined && ifNoneMatch === resolved.etag) {
          r.code(304).header('etag', resolved.etag).send('');
          return;
        }

        r.header('etag', resolved.etag);
        r.header('last-modified', resolved.modifiedAt.toUTCString());
        r.header('content-disposition', `attachment; filename="${sanitizeFilename(resolved.relative)}"`);
        r.type(resolved.mime);
        const range = parseRangeHeader(pickHeader(req.headers, 'range'), resolved.size);
        if (range !== null) {
          r.code(206)
            .header('content-length', String(range.length))
            .header('content-range', `bytes ${range.start}-${range.end}/${resolved.size}`);
        } else {
          r.code(200).header('content-length', String(resolved.size));
        }
        stream = createRuntimeReadStream(runtimeFs, resolved.absolute, range?.start ?? 0, range?.length ?? resolved.size);
        const downloadStream = stream;
        r.raw.once('finish', () => operation?.dispose());
        r.raw.once('close', () => { downloadStream.destroy(); operation?.dispose(); });
        downloadStream.on('error', (error: unknown) => {
          requestLog(req)?.warn({ session_id, path: relPath, err: error }, 'fs download stream error');
          downloadStream.destroy();
        });
        return r.send(downloadStream) as unknown as void;
      } catch (err) {
        if (stream !== undefined) {
          stream.destroy();
          operation?.dispose();
        }
        sendMappedError(reply, req, err);
      } finally {
        if (stream === undefined) {
          await runtimeFs?.lease.dispose();
          operation?.dispose();
        }
      }
    },
  );
  app.get(
    downloadRoute.path,
    downloadRoute.options,
    downloadRoute.handler as unknown as Parameters<FsRouteHost['get']>[2],
  );
}

function createRuntimeReadStream(
  runtimeFs: RuntimeFsScope,
  path: string,
  start: number,
  length: number,
): Readable {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    let offset = start;
    let remaining = length;
    while (remaining > 0) {
      const chunk = await runtimeFs.hostFs.readBytes(path, Math.min(64 * 1024, remaining), offset);
      if (chunk.byteLength === 0) break;
      offset += chunk.byteLength;
      remaining -= chunk.byteLength;
      yield chunk;
    }
  }
  const stream = Readable.from(chunks());
  const tracked = runtimeFs.lease.track({ dispose: () => { stream.destroy(); } });
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    tracked.dispose();
    void Promise.resolve(runtimeFs.lease.dispose()).catch((error: unknown) => {
      stream.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  };
  stream.once('end', release);
  stream.once('close', release);
  return stream;
}

type Req = { id: string; body: unknown };
type Reply = { send(payload: unknown): unknown };

async function handleList(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsListRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.list(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleRead(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsReadRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.read(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleListMany(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsListManyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.listMany(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleStat(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsStatRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.stat(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleStatMany(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsStatManyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.statMany(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleMkdir(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsMkdirRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.mkdir(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleSearch(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsSearchRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.search(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleGrep(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsGrepRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.grep(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleGitStatus(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsGitStatusRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.gitStatus(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleDiff(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsDiffRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.diff(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleOpen(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsOpenRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const resolved = await fs.resolvePath(parsed.data.path);
  await launchDetached(openFileCommandFor(resolved.absolute, parsed.data.line));
  reply.send(okEnvelope({ opened: true as const }, req.id));
}

async function handleReveal(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsRevealRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const resolved = await fs.resolvePath(parsed.data.path);
  await launchDetached(revealFileCommandFor(resolved.absolute));
  reply.send(okEnvelope({ revealed: true as const }, req.id));
}

async function handleOpenIn(fs: IWorkspaceFsService, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsOpenInRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body = parsed.data;
  const resolved = await fs.resolvePath(body.path);
  try {
    await launchDetached(
      openInAppCommandFor(body.app_id, resolved.absolute, {
        line: body.line,
        isDirectory: resolved.isDirectory,
      }),
    );
  } catch (err) {
    requestLog(req)?.warn(
      { session_id: sessionId, app_id: body.app_id, err },
      'fs open-in launch failed',
    );
    reply.send(
      errEnvelope(
        ErrorCode.INTERNAL_ERROR,
        `failed to open in ${body.app_id}: ${err instanceof Error ? err.message : String(err)}`,
        req.id,
      ),
    );
    return;
  }
  reply.send(okEnvelope({ opened: true as const }, req.id));
}

function sendMappedError(reply: Reply, req: { id: string }, err: unknown): void {
  const requestId = req.id;
  const log = requestLog(req);
  if (isError2(err)) {
    switch (err.code) {
      case ErrorCodes.FS_PATH_ESCAPES:
        reply.send(errEnvelope(ErrorCode.FS_PATH_ESCAPES_SESSION, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_PATH_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_IS_DIRECTORY:
        reply.send(errEnvelope(ErrorCode.FS_IS_DIRECTORY, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_ALREADY_EXISTS:
        reply.send(errEnvelope(ErrorCode.FS_ALREADY_EXISTS, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_IS_BINARY:
        reply.send(errEnvelope(ErrorCode.FS_IS_BINARY, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_TOO_LARGE:
        reply.send(errEnvelope(ErrorCode.FS_TOO_LARGE, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_TOO_MANY_RESULTS:
        reply.send(errEnvelope(ErrorCode.FS_TOO_MANY_RESULTS, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_GREP_TIMEOUT:
        reply.send(errEnvelope(ErrorCode.FS_GREP_TIMEOUT, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_GIT_UNAVAILABLE:
        reply.send(errEnvelope(ErrorCode.FS_GIT_UNAVAILABLE, err.message, requestId, err.stack));
        return;
      case ErrorCodes.SESSION_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.OS_FS_NOT_FOUND:
      case ErrorCodes.OS_FS_NOT_DIRECTORY:
        reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.OS_FS_IS_DIRECTORY:
        reply.send(errEnvelope(ErrorCode.FS_IS_DIRECTORY, err.message, requestId, err.stack));
        return;
      case ErrorCodes.OS_FS_ALREADY_EXISTS:
        reply.send(errEnvelope(ErrorCode.FS_ALREADY_EXISTS, err.message, requestId, err.stack));
        return;
      case ErrorCodes.OS_FS_PERMISSION_DENIED:
        reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, err.message, requestId, err.stack));
        return;
    }
  }
  log?.error({ err }, 'fs request failed');
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}

function buildValidationEnvelope(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const details = issues.map((i) => ({
    path: i.path.map((p) => String(p)).join('.'),
    message: i.message,
  }));
  const first = details[0];
  const msg =
    first === undefined
      ? 'validation failed'
      : first.path === ''
        ? first.message
        : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}

function sanitizeFilename(rel: string): string {
  const segs = rel.split('/');
  const base = segs[segs.length - 1] ?? rel;
  return base.replace(/"/g, '\\"');
}
