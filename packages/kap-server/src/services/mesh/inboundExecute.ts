import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { MeshInboundExecuteInput } from '@kiki/protocol';
import {
  evaluateMeshApproval,
  getLiveSessionById,
  ISessionApprovalService,
  ISessionQuestionService,
  IWorkspaceService,
  type QuestionAnswers,
  type Scope,
} from '@kiki/agent-core-v2';
import { IWorkspacePersistence } from '@kiki/agent-core-v2/app/workspace/workspacePersistence';
import { MeshApprovalRejectedError, type MeshService } from './meshService';

const execFileAsync = promisify(execFile);
const MAX_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_BUFFER_BYTES = 256 * 1024;
const MAX_SYNC_FILES = 256;
const MAX_SYNC_FILE_BYTES = 4 * 1024 * 1024;

export interface InboundMeshExecutorOptions {
  readonly core: Scope;
  readonly homeDir: string;
  readonly getMeshService: () => MeshService;
}

/** Creates the real inbound mesh action executor wired into `MeshService.onInboundExecute` on target peers. */
export function createInboundMeshExecutor(
  options: InboundMeshExecutorOptions,
): (input: MeshInboundExecuteInput) => Promise<unknown> {
  const allowedRoots = async (): Promise<string[]> => {
    const roots = new Set<string>([resolve(options.homeDir)]);
    try {
      const persisted = await options.core.accessor.get(IWorkspacePersistence).load();
      for (const ws of persisted?.workspaces ?? []) {
        if (ws.root) roots.add(resolve(ws.root));
      }
    } catch {}
    try {
      for (const ws of await options.core.accessor.get(IWorkspaceService).list()) {
        if (ws.root) roots.add(resolve(ws.root));
      }
    } catch {}
    const resolved: string[] = [];
    for (const root of roots) {
      resolved.push(await realpath(root).catch(() => root));
    }
    return resolved;
  };

  const assertWithinAllowedRoots = async (candidate: string): Promise<string> => {
    const abs = resolve(candidate);
    const roots = await allowedRoots();
    const realCandidate = await resolveNearestRealpath(abs);
    const allowed = roots.some((root) => isPathContained(root, realCandidate));
    if (!allowed) {
      throw new Error(`Target path '${candidate}' is not allowed outside registered roots`);
    }
    return abs;
  };

  return async (input: MeshInboundExecuteInput): Promise<unknown> => {
    switch (input.operation) {
      case 'remote_command': {
        const rawCwd = typeof input.payload?.['cwd'] === 'string' ? input.payload['cwd'] : options.homeDir;
        const cwd = await assertWithinAllowedRoots(rawCwd);
        const shell = process.platform === 'win32' ? (process.env['COMSPEC'] ?? 'cmd.exe') : '/bin/sh';
        const args = process.platform === 'win32' ? ['/d', '/s', '/c', input.action] : ['-lc', input.action];
        try {
          const { stdout, stderr } = await execFileAsync(shell, args, {
            cwd,
            timeout: MAX_COMMAND_TIMEOUT_MS,
            maxBuffer: MAX_COMMAND_BUFFER_BYTES,
            windowsHide: true,
          });
          return { exitCode: 0, stdout, stderr, cwd };
        } catch (error) {
          const err = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
          const exitCode = typeof err.code === 'number' ? err.code : 1;
          return {
            exitCode,
            stdout: typeof err.stdout === 'string' ? err.stdout : '',
            stderr: typeof err.stderr === 'string' ? err.stderr : (err.message ?? 'Command failed'),
            cwd,
          };
        }
      }

      case 'remote_question': {
        if (input.sessionId === undefined) {
          throw new Error('Pending question not found');
        }
        const live = getLiveSessionById(options.core.accessor, input.sessionId);
        if (live === undefined) {
          throw new Error('Pending question not found');
        }
        const questionService = live.accessor.get(ISessionQuestionService);
        const pending = questionService.listPending();
        const requestedId = typeof input.payload?.['questionId'] === 'string' ? input.payload['questionId'] : undefined;
        const target = requestedId !== undefined
          ? pending.find((item) => item.id === requestedId)
          : pending[0];
        if (target === undefined || target.id === undefined) {
          throw new Error('Pending question not found');
        }
        let answers: QuestionAnswers;
        const rawAnswers = input.payload?.['answers'];
        if (rawAnswers !== null && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)) {
          answers = rawAnswers as QuestionAnswers;
        } else {
          const built: Record<string, string | true> = {};
          if (target.questions.length > 0) {
            for (const q of target.questions) {
              built[q.question] = input.action;
            }
          } else {
            built['answer'] = input.action;
          }
          answers = built;
        }
        questionService.answer(target.id, answers);
        return {
          resolved: true,
          sessionId: input.sessionId,
          questionId: target.id,
          answer: input.action,
        };
      }

      case 'file_sync': {
        const rawRoot = input.payload?.['targetRoot'];
        const rawFiles = input.payload?.['files'];
        if (typeof rawRoot !== 'string' || !Array.isArray(rawFiles) || rawFiles.length === 0) {
          throw new Error('file_sync payload requires targetRoot and non-empty files');
        }
        if (rawFiles.length > MAX_SYNC_FILES) {
          throw new Error(`file_sync exceeds maximum file count (${MAX_SYNC_FILES})`);
        }
        const verifiedRoot = await assertWithinAllowedRoots(rawRoot);
        await mkdir(verifiedRoot, { recursive: true });
        const realRoot = await realpath(verifiedRoot);
        const cas = options.getMeshService().casStaging;
        const appliedPaths: string[] = [];
        const stagedSha256s: string[] = [];
        let totalBytes = 0;

        for (const entry of rawFiles) {
          if (entry === null || typeof entry !== 'object') {
            throw new Error('Invalid file_sync entry');
          }
          const relPath = (entry as { relativePath?: unknown }).relativePath;
          const contentBase64 = (entry as { contentBase64?: unknown }).contentBase64;
          if (typeof relPath !== 'string' || typeof contentBase64 !== 'string') {
            throw new Error('Invalid file_sync entry fields');
          }
          const normalized = relPath.replaceAll('\\', '/');
          if (
            normalized === '' ||
            normalized.startsWith('/') ||
            isAbsolute(relPath) ||
            normalized.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
          ) {
            throw new Error(`file_sync path '${relPath}' is not allowed`);
          }
          const bytes = Buffer.from(contentBase64, 'base64');
          if (bytes.byteLength > MAX_SYNC_FILE_BYTES) {
            throw new Error(`file_sync file '${relPath}' exceeds maximum size`);
          }
          const dest = resolve(realRoot, normalized);
          if (!isPathContained(realRoot, dest)) {
            throw new Error(`file_sync path '${relPath}' escapes target root`);
          }
          const destParent = dirname(dest);
          const realParent = await resolveNearestRealpath(destParent);
          if (!isPathContained(realRoot, realParent)) {
            throw new Error(`file_sync path '${relPath}' escapes target root via symlink`);
          }
          const staged = await cas.stageBytes(bytes);
          await mkdir(destParent, { recursive: true });
          const confirmedParent = await realpath(destParent);
          if (!isPathContained(realRoot, confirmedParent)) {
            throw new Error(`file_sync path '${relPath}' escapes target root via symlink`);
          }
          await writeFile(dest, bytes);
          appliedPaths.push(normalized);
          stagedSha256s.push(staged.sha256);
          totalBytes += bytes.byteLength;
        }
        return {
          targetRoot: realRoot,
          appliedPaths,
          stagedSha256s,
          totalBytes,
        };
      }

      case 'interactive_login': {
        if (input.sessionId === undefined) {
          throw new MeshApprovalRejectedError(
            'interactive_login requires an active local session with human approval',
          );
        }
        const live = getLiveSessionById(options.core.accessor, input.sessionId);
        if (live === undefined) {
          throw new MeshApprovalRejectedError(
            'interactive_login requires an active local session with human approval',
          );
        }
        const approvalService = live.accessor.get(ISessionApprovalService);
        const approval = await evaluateMeshApproval({
          operation: 'interactive_login',
          permissionMode: 'manual',
          action: input.action,
          targetLabel: input.targetId,
          sessionId: input.sessionId,
          approvalService,
        });
        if (approval.decision !== 'approved') {
          throw new MeshApprovalRejectedError(
            approval.feedback ?? `Interactive login rejected (${approval.decision})`,
          );
        }
        return {
          approved: true,
          sessionId: input.sessionId,
          decision: approval.decision,
        };
      }

      default:
        throw new Error(`Unsupported inbound mesh operation '${input.operation}'`);
    }
  };
}

function isPathContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function resolveNearestRealpath(target: string): Promise<string> {
  let cursor = resolve(target);
  const trailing: string[] = [];
  for (;;) {
    try {
      const resolved = await realpath(cursor);
      return trailing.length === 0 ? resolved : join(resolved, ...trailing.toReversed());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) {
        return trailing.length === 0 ? cursor : join(cursor, ...trailing.toReversed());
      }
      trailing.push(relative(parent, cursor));
      cursor = parent;
    }
  }
}
