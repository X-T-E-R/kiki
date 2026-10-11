import path from 'node:path';
import { mediaGenerateInputSchema, mediaActionSchema, type MediaRequest, type MediaInputRef, type MediaJob, type PluginMediaApi } from '@kiki/protocol';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IPluginMediaService } from '#/app/pluginMedia/pluginMedia';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentPluginMediaService } from './pluginMedia';
import { mediaTask } from './mediaTask';
import { IRequestIdentityRegistry } from '#/session/requestIdentity/requestIdentityRegistry';

export class AgentPluginMediaService extends Service implements IAgentPluginMediaService {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IPluginMediaService private readonly media: IPluginMediaService,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @ISessionMediaStore private readonly files: ISessionMediaStore,
    @IRequestIdentityRegistry private readonly identities: IRequestIdentityRegistry,
  ) {
    super();
    const recovery = tasks.registerMediaRecovery?.(async (info) => {
      try {
        await this.owned(info.jobId);
        return mediaTask(this.media, info.jobId);
      } catch { return undefined; }
    });
    if (recovery !== undefined) this._register(recovery);
  }

  api(requestId: string, admittedRequest?: MediaRequest): PluginMediaApi {
    return {
      generate: async (raw) => {
        const input = mediaGenerateInputSchema.parse(raw);
        if (admittedRequest === undefined || JSON.stringify(input.request) !== JSON.stringify(admittedRequest)) throw new Error('Media input changed after tool/path admission. Retry with the current request.');
        const snapshot = await this.identities.snapshot({ agentId: this.agent.agentId, turnKey: `media:${input.request_id ?? requestId}`, parentAgentId: this.agent.parentAgentId, compactionWindow: 0, logicalIdKind: 'uuidv4' });
        const identity = { ...snapshot };
        Reflect.deleteProperty(identity, 'setTurnState');
        const job = await this.media.start({ ...input, request_id: input.request_id ?? requestId }, {
          sessionId: this.session.sessionId, agentId: this.agent.agentId, mediaScope: this.session.scope('media'), identity, parentAgentId: this.agent.parentAgentId,
        });
        if (!['running', 'pending'].includes(job.state)) return job;
        const taskId = await this.attach(job, input.execution === 'background');
        if (input.execution === 'auto') {
          await this.tasks.waitForForegroundRelease(taskId);
          const result = await this.media.job(job.job_id);
          if (!['running', 'pending'].includes(result.state)) await this.tasks.suppressTerminalNotification(taskId);
          return result;
        }
        return this.media.job(job.job_id);
      },
      media: async (raw) => {
        const input = mediaActionSchema.parse(raw);
        if (input.action === 'capabilities') {
          const { action: _action, ...query } = input;
          return this.media.capabilities(query, {
            workspaceId: this.session.workspaceId,
            sessionId: this.session.sessionId,
          });
        }
        if (input.action === 'voices') {
          const { action: _action, ...query } = input;
          return this.media.voices(query, {
            workspaceId: this.session.workspaceId,
            sessionId: this.session.sessionId,
          });
        }
        await this.owned(input.job_id);
        if (input.action === 'cancel') return this.cancel(input.job_id);
        if (input.action === 'resume') return this.resume(input.job_id);
        return this.media.job(input.job_id);
      },
    };
  }

  async cancel(jobId: string): Promise<MediaJob> {
    await this.owned(jobId);
    return this.media.cancel(jobId);
  }

  async resume(jobId: string): Promise<MediaJob> {
    await this.owned(jobId);
    const job = await this.media.resume(jobId);
    if (['running', 'pending'].includes(job.state)) await this.attach(job, true);
    return this.media.job(jobId);
  }

  async resolveInput(ref: MediaInputRef): Promise<MediaInputRef> {
    if (!('file_id' in ref)) return ref;
    const file = await this.files.open(ref.file_id);
    if (file?.path === undefined) throw new Error('Session media input is missing or unavailable as a local file');
    return { path: file.path };
  }

  async snapshotInput(ref: MediaInputRef, key: string, fs: IHostFileSystem, signal: AbortSignal): Promise<MediaInputRef> {
    if ('url' in ref) return ref;
    if ('file_id' in ref) {
      const file = await this.files.open(ref.file_id);
      if (file === undefined) throw new Error('Session media input not found');
      return { path: await this.media.stageInput(`${this.session.sessionId}/${key}`, file.name, file.stream(), signal) };
    }
    const stat = await fs.stat(ref.path);
    if (!stat.isFile) throw new Error('Media input must be a file');
    const chunks = async function* () {
      for (let offset = 0; offset < stat.size;) {
        signal.throwIfAborted();
        const bytes = await fs.readBytes(ref.path, Math.min(256 * 1024, stat.size - offset), offset);
        if (bytes.byteLength === 0) throw new Error('Media input was truncated while reading');
        offset += bytes.byteLength;
        yield bytes;
      }
    };
    return { path: await this.media.stageInput(`${this.session.sessionId}/${key}`, path.basename(ref.path), chunks(), signal) };
  }

  private async owned(id: string) {
    const record = await this.media.stored(id);
    if (record.owner.sessionId !== this.session.sessionId || record.owner.agentId !== this.agent.agentId) throw new Error('Media job belongs to another session or agent');
    return record;
  }

  private async attach(job: MediaJob, detached: boolean): Promise<string> {
    if (job.task_id !== undefined && this.tasks.getTask(job.task_id)?.status === 'running') return job.task_id;
    const id = this.tasks.registerTask(mediaTask(this.media, job.job_id), {
      detached, detachTimeoutMs: detached ? undefined : 15_000, autoBackgroundOnTimeout: true,
    });
    await this.media.bindTask(job.job_id, id);
    return id;
  }
}

registerScopedService(LifecycleScope.Agent, IAgentPluginMediaService, AgentPluginMediaService, ScopeActivation.OnScopeCreated, 'pluginMedia');
