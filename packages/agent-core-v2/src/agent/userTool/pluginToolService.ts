import { createHash } from 'node:crypto';

import {
  mediaGenerateInputSchema,
  mediaRequestSchema,
  pluginMessageBatchReceiptSchema,
  pluginMessageReceiptSchema,
  pluginMessageSendInputSchema,
  type MediaRequest,
  type PluginMessageBatchItemReceipt,
  type PluginMessageBatchReceipt,
  type PluginMessagesApi,
  type PluginMessageReceipt,
  type PluginMessageSendInput,
  type PluginMessageSendReceipt,
} from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';
import { IAgentPluginMediaService, mediaInputRefs } from '#/agent/pluginMedia/pluginMedia';
import { dispose, type IDisposable } from '#/_base/di/lifecycle';
import { isAbortError } from '#/_base/utils/abort';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IPluginHostService } from '#/app/plugin/pluginHostService';
import type { PluginTool } from '#/app/plugin/contributions';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentRuntimeService, inspectAgentRuntime, inspectAgentWorkspaceRoots } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolExecutorService, type ToolExecutionResult } from '#/agent/toolExecutor/toolExecutor';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { isWithinDirectory, resolveRealPathAccess, resolveRealPathAccessPath, type WorkspaceConfig } from '#/tool/path-access';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import type { ToolCall } from '#/kosong/contract/message';
import type { ExecutableTool, ExecutableToolContext, ToolAccesses, ToolExecution } from '#/tool/toolContract';
import { Error2, ErrorCodes } from '#/errors';

export interface IAgentPluginToolService {
  readonly _serviceBrand: undefined;
  ready(): Promise<void>;
}
export const IAgentPluginToolService = createDecorator<IAgentPluginToolService>('agentPluginToolService');

export class AgentPluginToolService extends Service implements IAgentPluginToolService {
  declare readonly _serviceBrand: undefined;
  private readonly registrations = new Map<string, { readonly disposable: IDisposable; readonly definition: PluginTool; readonly pluginId: string }>();
  private refreshQueue: Promise<void> = Promise.resolve();
  private readonly refreshes = new Set<Promise<void>>();
  private readonly messageCalls = new Map<string, PluginMessageCall>();
  private revision = 0;
  private closing = false;

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IPluginHostService private readonly hosts: IPluginHostService,
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentPluginMediaService private readonly media?: IAgentPluginMediaService,
    @IPluginUsageService private readonly usage?: IPluginUsageService,
    @ISessionContext private readonly session?: ISessionContext,
    @ISessionMediaStore private readonly attachmentStore?: ISessionMediaStore,
    @IAgentScopeContext private readonly agentContext?: IAgentScopeContext,
    @IAgentToolExecutorService private readonly toolExecutor?: IAgentToolExecutorService,
    @IAtomicTomlDocumentStore private readonly messageDocuments?: IAtomicTomlDocumentStore,
  ) {
    super();
    this._register(this.plugins.onDidReload((event) => {
      event.waitUntil(this.queueRefresh());
    }));
    if (this.usage !== undefined) this._register(this.usage.onDidChange((event) => {
      if (event.workspaceId !== this.session?.workspaceId ||
        (event.sessionId !== undefined && event.sessionId !== this.session?.sessionId)) return;
      event.waitUntil(this.queueRefresh());
    }));
    this._register(this.registry.registerPreparation(async () => {
      try { await this.ready(); }
      catch (error) { onUnexpectedError(error); }
    }));
    void this.queueRefresh().catch(() => undefined);
  }

  async ready(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.refreshQueue;
      await pending;
    } while (pending !== this.refreshQueue);
  }

  private queueRefresh(): Promise<void> {
    const revision = ++this.revision;
    const work = this.refresh(revision);
    this.refreshQueue = work;
    this.refreshes.add(work);
    void work.then(() => this.refreshes.delete(work), () => this.refreshes.delete(work));
    return work;
  }

  private async refresh(revision: number): Promise<void> {
    const admission = await Promise.all([...this.registrations].map(async ([name, entry]) => ({
      name,
      entry,
      allowed: this.usage === undefined || await this.usage.allows(this.session?.workspaceId, entry.pluginId, this.session?.sessionId),
    })));
    if (this.closing || revision !== this.revision) return;
    for (const { name, entry, allowed } of admission) {
      if (allowed) continue;
      void entry.disposable.dispose();
      this.registrations.delete(name);
    }
    const definitions = await this.hosts.list();
    const wanted = new Map<string, { readonly pluginId: string; readonly definition: PluginTool }>();
    for (const { pluginId, definition } of definitions) {
      if (this.usage !== undefined && !await this.usage.allows(this.session?.workspaceId, pluginId, this.session?.sessionId)) continue;
      wanted.set(`plugin__${pluginId.replaceAll('-', '_')}__${definition.name}`, { pluginId, definition });
    }
    if (this.closing || revision !== this.revision) return;
    for (const [name, entry] of this.registrations) {
      if (JSON.stringify(wanted.get(name)?.definition) === JSON.stringify(entry.definition)) continue;
      void entry.disposable.dispose();
      this.registrations.delete(name);
    }
    if (this.closing || revision !== this.revision) return;
    for (const [name, { pluginId, definition }] of wanted) {
      if (this.registry.resolve(name) !== undefined) continue;
      const tool: ExecutableTool = {
        name,
        description: definition.description,
        parameters: definition.parameters ?? { type: 'object', properties: {} },
        resolveExecution: (args) => this.resolveExecution(name, pluginId, definition, args),
      };
      const disposable = this._register(this.registry.register(tool, { source: 'plugin', disclosure: definition.disclosure }));
      this.registrations.set(name, { disposable, definition, pluginId });
    }
  }

  private messagesApi(pluginId: string, context: ExecutableToolContext): PluginMessagesApi {
    let sequence = 0;
    return {
      send: (raw: PluginMessageSendInput) => {
        const input = pluginMessageSendInputSchema.parse(raw);
        const requestKey = input.request_id === undefined ? `generated:${++sequence}` : `explicit:${input.request_id}`;
        const callScope = input.request_id === undefined ? context.toolCallId : '';
        const callId = messageCallId(pluginId, this.session?.sessionId ?? 'unknown-session', this.agentContext?.agentId ?? 'unknown-agent', callScope, requestKey);
        const fingerprint = canonicalJson(input);
        const previous = this.messageCalls.get(callId);
        if (previous !== undefined) {
          if (previous.fingerprint !== fingerprint) return Promise.reject(new Error2(ErrorCodes.REQUEST_INVALID, 'Message request_id was already used with a different payload.'));
          return previous.promise;
        }
        const execute = (progress?: (receipt: PluginMessageBatchReceipt) => Promise<void>) => input.messages === undefined
          ? this.executePluginMessage(input, callId, context)
          : this.executePluginMessageBatch(input, pluginId, requestKey, context, callScope, progress);
        const promise = input.request_id === undefined ? execute() : this.durableMessage(input, callId, fingerprint, pluginId, requestKey, execute);
        this.messageCalls.set(callId, { fingerprint, promise });
        return promise;
      },
    };
  }

  private async durableMessage(input: PluginMessageSendInput, callId: string, fingerprint: string, pluginId: string, requestKey: string,
    execute: (progress?: (receipt: PluginMessageBatchReceipt) => Promise<void>) => Promise<PluginMessageSendReceipt>): Promise<PluginMessageSendReceipt> {
    if (this.messageDocuments === undefined || this.agentContext === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Durable message receipts are unavailable.');
    const store = this.messageDocuments;
    const scope = this.agentContext.scope('plugin-messages');
    const key = `${callId.slice('plugin-message:'.length)}.json`;
    const unknown = (id: string): PluginMessageReceipt => ({ message_id: `send:${id}`, delivered_to: [], delivery: 'pending', detail: 'Message request was admitted; its final outcome was not recorded. Do not resend automatically.' });
    const initial: PluginMessageSendReceipt = input.messages === undefined ? unknown(callId) : { messages: input.messages.map((_, index) => ({ index, ...unknown(messageCallId(pluginId, this.session?.sessionId ?? 'unknown-session', this.agentContext!.agentId, '', `${requestKey}:item:${index}`)) })) };
    let current = JSON.stringify({ fingerprint, receipt: initial });
    if (!await store.compareAndSetText(scope, key, undefined, current)) {
      const text = await store.getText(scope, key);
      if (text === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Message receipt disappeared; delivery was not retried.');
      const stored = JSON.parse(text) as { fingerprint: string; receipt: unknown };
      if (stored.fingerprint !== fingerprint) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Message request_id was already used with a different payload.');
      return pluginMessageReceiptSchema.or(pluginMessageBatchReceiptSchema).parse(stored.receipt);
    }
    const save = async (receipt: PluginMessageSendReceipt) => {
      const next = JSON.stringify({ fingerprint, receipt });
      if (!await store.compareAndSetText(scope, key, current, next)) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Message receipt changed concurrently; delivery was not retried.');
      current = next;
    };
    try {
      const receipt = await execute(async (progress) => {
        const pending = (initial as PluginMessageBatchReceipt).messages;
        await save({ messages: [...progress.messages, ...pending.slice(progress.messages.length)] });
      });
      await save(receipt);
      return receipt;
    } catch (error) {
      if (input.messages === undefined && error instanceof PluginMessageNotSentError) {
        const receipt: PluginMessageReceipt = { message_id: `send:${callId}`, delivered_to: [], delivery: 'undeliverable', detail: error.message };
        await save(receipt);
        return receipt;
      }
      return pluginMessageReceiptSchema.or(pluginMessageBatchReceiptSchema).parse((JSON.parse(current) as { receipt: unknown }).receipt);
    }
  }

  private async executePluginMessageBatch(
    input: PluginMessageSendInput,
    pluginId: string,
    requestKey: string,
    context: ExecutableToolContext,
    callScope: string,
    progress?: (receipt: PluginMessageBatchReceipt) => Promise<void>,
  ): Promise<PluginMessageBatchReceipt> {
    const messages: PluginMessageBatchItemReceipt[] = [];
    const batch = input.messages!;
    for (let index = 0; index < batch.length; index++) {
      const itemCallId = messageCallId(pluginId, this.session?.sessionId ?? 'unknown-session', this.agentContext?.agentId ?? 'unknown-agent', callScope, `${requestKey}:item:${index}`);
      if (context.signal.aborted) {
        for (let cancelled = index; cancelled < batch.length; cancelled++) {
          const cancelledCallId = cancelled === index ? itemCallId : messageCallId(pluginId, this.session?.sessionId ?? 'unknown-session', this.agentContext?.agentId ?? 'unknown-agent', callScope, `${requestKey}:item:${cancelled}`);
          messages.push(cancelledMessageReceipt(cancelled, cancelledCallId, 'Message batch cancelled before this item was sent.'));
        }
        break;
      }
      const item = batch[index]!;
      const itemInput = {
        to: input.to,
        channel: input.channel,
        channels: input.channels,
        ...item,
      };
      try {
        const receipt = await this.executePluginMessage(itemInput, itemCallId, context);
        messages.push({ index, ...receipt });
      } catch (error) {
        const cancelled = context.signal.aborted || isAbortError(error);
        messages.push(error instanceof PluginMessageNotSentError
          ? failedMessageReceipt(index, itemCallId, errorMessage(error))
          : { index, message_id: `send:${itemCallId}`, delivered_to: [], delivery: 'pending', detail: `Message outcome is unknown: ${errorMessage(error)}. Do not resend automatically.` });
        const detail = cancelled ? 'Message batch cancelled before this item was sent.' : 'Message batch stopped after a previous item was not sent.';
        for (let unsent = index + 1; unsent < batch.length; unsent++) {
          const unsentCallId = messageCallId(pluginId, this.session?.sessionId ?? 'unknown-session', this.agentContext?.agentId ?? 'unknown-agent', callScope, `${requestKey}:item:${unsent}`);
          messages.push(cancelled ? cancelledMessageReceipt(unsent, unsentCallId, detail) : failedMessageReceipt(unsent, unsentCallId, detail));
        }
        break;
      }
      await progress?.({ messages });
    }
    return pluginMessageBatchReceiptSchema.parse({ messages });
  }

  private async executePluginMessage(
    input: PluginMessageSendInput | { readonly text?: string; readonly attachments?: PluginMessageSendInput['attachments']; readonly reply_to?: string; readonly to?: string; readonly channel?: string; readonly channels?: readonly string[] },
    toolCallId: string,
    context: ExecutableToolContext,
  ): Promise<PluginMessageReceipt> {
    if (this.toolExecutor === undefined || this.registry.resolve('SendMessage') === undefined) {
      throw new PluginMessageNotSentError(ErrorCodes.REQUEST_INVALID, 'SendMessage is disabled by the active capability or tool policy.');
    }
    const args = { ...input };
    Reflect.deleteProperty(args, 'request_id');
    const call: ToolCall = {
      type: 'function',
      id: toolCallId,
      name: 'SendMessage',
      arguments: JSON.stringify(args),
    };
    let result: ToolExecutionResult | undefined;
    let definitelyNotSent = false;
    const observation = this.toolExecutor.hooks.onDidExecuteTool.register(`plugin-message-receipt:${toolCallId}`, async (event, next) => {
      await next();
      if (event.toolCall.id === toolCallId) definitelyNotSent = ['preflight-rejected', 'resolution-failed', 'vetoed', 'skipped'].includes(event.outcome);
    });
    try {
      for await (const item of this.toolExecutor.execute([call], {
        signal: context.signal,
        turnId: context.turnId,
        step: context.step,
        deduplicationKey: toolCallId,
        trace: context.trace,
      })) {
        result = item;
        break;
      }
    } finally { await observation.dispose(); }
    if (result === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'SendMessage did not return a receipt.');
    if (result.result.isError === true) {
      const output = typeof result.result.output === 'string' ? result.result.output : 'SendMessage failed.';
      throw definitelyNotSent ? new PluginMessageNotSentError(ErrorCodes.REQUEST_INVALID, output) : new Error2(ErrorCodes.REQUEST_INVALID, output);
    }
    if (typeof result.result.output !== 'string') throw new Error2(ErrorCodes.REQUEST_INVALID, 'SendMessage returned an invalid receipt.');
    return pluginMessageReceiptSchema.parse(JSON.parse(result.result.output));
  }

  private async resolveExecution(name: string, pluginId: string, definition: PluginTool, args: unknown): Promise<ToolExecution> {
    const inspected = inspectAgentRuntime(this.runtime);
    const view = new RuntimeWorkspaceView(inspected, inspectAgentWorkspaceRoots(this.runtime, this.workspaceCtx));
    const workspace: WorkspaceConfig = { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
    const env = { _serviceBrand: undefined, ...inspected.environment, ready: Promise.resolve() };
    const fileTargets: { field?: string; inputIndex?: number; raw: string; path: string; operation: 'read' | 'write' }[] = [];
    let request: MediaRequest | undefined;
    if (definition.mediaInputs === true) {
      if (this.media === undefined) return { isError: true, output: 'Media host is unavailable' };
      request = mediaRequestSchema.parse((args as { request?: unknown })?.request);
    }
    const accesses: ToolAccesses[number][] = [];
    const lease = this.runtime.acquire(['fs']);
    try {
      if (lease.runtime.identity.generation !== inspected.identity.generation) {
        return { isError: true, output: 'Runtime changed before plugin file admission. Retry the tool call.' };
      }
      for (const access of definition.accesses) {
        if (access.kind === 'all') { accesses.push(access); continue; }
        const field = /^\$\.([A-Za-z][A-Za-z0-9_]*)$/.exec(access.path);
        if (field === null) return { isError: true, output: `Unsupported plugin file target: ${access.path}` };
        const raw = typeof args === 'object' && args !== null && !Array.isArray(args)
          ? (args as Record<string, unknown>)[field[1]!] : undefined;
        if (typeof raw !== 'string' || raw.length === 0) {
          return { isError: true, output: `Plugin file target $.${field[1]} must be a path string.` };
        }
        const operation = access.operation === 'read' || access.operation === 'search' ? 'read' as const : 'write' as const;
        const admitted = await resolveRealPathAccess(raw, { env, workspace, operation }, lease.runtime.fs!);
        fileTargets.push({ field: field[1]!, raw, path: admitted.path, operation });
        accesses.push({ ...access, path: admitted.path, implicitExternal: admitted.implicitExternal });
      }
      if (request !== undefined) {
        for (const [inputIndex, ref] of mediaInputRefs(request).entries()) {
          if (!('path' in ref)) continue;
          const admitted = await resolveRealPathAccess(ref.path, { env, workspace, operation: 'read' }, lease.runtime.fs!);
          fileTargets.push({ inputIndex, raw: ref.path, path: admitted.path, operation: 'read' });
          accesses.push({ kind: 'file', operation: 'read', path: admitted.path, implicitExternal: admitted.implicitExternal });
        }
      }
    } finally { lease.dispose(); }
    const path = fileTargets[0]?.path;
    const pathOptions = { cwd: workspace.workspaceDir, pathClass: env.pathClass, homeDir: env.homeDir };
    return {
      accesses,
      approvalRule: path === undefined ? definition.approvalRule ?? name : literalRulePattern(name, path),
      matchesRule: path === undefined ? undefined : (ruleArgs) => matchesPathRuleSubject(ruleArgs, path, pathOptions),
      execute: async (context) => {
        if (this.usage !== undefined && !await this.usage.allows(this.session?.workspaceId, pluginId, this.session?.sessionId)) {
          return { isError: true, output: `Plugin ${pluginId} is disabled in this session.` };
        }
        const current = this.runtime.acquire(['fs']);
        try {
          if (current.runtime.identity.generation !== inspected.identity.generation) {
            return { isError: true, output: 'Runtime changed after plugin file admission. Retry the tool call.' };
          }
          for (const target of fileTargets) {
            const actual = await resolveRealPathAccessPath(target.raw, { env, workspace, operation: target.operation }, current.runtime.fs!);
            if ((env.pathClass === 'win32' ? actual.toLowerCase() : actual) !==
              (env.pathClass === 'win32' ? target.path.toLowerCase() : target.path)) {
              return { isError: true, output: `Plugin file target changed after path admission: admitted "${target.path}", actual "${actual}". Use the actual absolute path or resolve a changed link first.` };
            }
          }
          const resolvedArgs = { ...(args as Record<string, unknown>) };
          const admittedRequest = request === undefined ? undefined : structuredClone(request);
          const refs = admittedRequest === undefined ? [] : mediaInputRefs(admittedRequest);
          const approvedPaths: string[] = [];
          for (const target of fileTargets) {
            if (target.field !== undefined) resolvedArgs[target.field] = target.path;
            else if (target.inputIndex !== undefined) Object.assign(refs[target.inputIndex]!, { path: target.path });
            if (isWithinDirectory(target.path, view.workDir, env.pathClass)) continue;
            const missingCreate = definition.name === 'office_create' &&
              await current.runtime.fs!.stat(target.path).then(() => false, () => true);
            approvedPaths.push(missingCreate ? current.runtime.path.dirname(target.path) : target.path);
          }
          const requestId = refs.length === 0 ? context.toolCallId : mediaGenerateInputSchema.shape.request_id.parse(resolvedArgs['request_id']) ?? context.toolCallId;
          for (const [index, ref] of refs.entries()) {
            const snapshot = await this.media!.snapshotInput(ref, `${requestId}/${index}`, current.runtime.fs!, context.signal);
            if (snapshot !== ref) {
              for (const key of Object.keys(ref)) Reflect.deleteProperty(ref, key);
              Object.assign(ref, snapshot);
            }
          }
          if (admittedRequest !== undefined) resolvedArgs['request'] = admittedRequest;
          const scope = {
            workspaceRoot: view.workDir,
            approvedPaths,
            imageIn: this.profile.getModelCapabilities().image_in,
            workspaceId: this.session?.workspaceId,
            media: this.media?.api(context.toolCallId, admittedRequest),
            attachmentStore: this.attachmentStore,
            messages: this.messagesApi(pluginId, context),
          };
          return await this.hosts.execute(pluginId, definition.name, resolvedArgs, context.signal, context.onUpdate, scope, definition);
        } finally { current.dispose(); }
      },
    };
  }

  override async dispose(): Promise<void> {
    this.closing = true;
    this.revision++;
    await Promise.allSettled(this.refreshes);
    await dispose([...this.registrations.values()].map((entry) => entry.disposable));
    this.registrations.clear();
    this.messageCalls.clear();
    await super.dispose();
  }
}

class PluginMessageNotSentError extends Error2 {}

type PluginMessageCall = {
  readonly fingerprint: string;
  readonly promise: Promise<PluginMessageSendReceipt>;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function messageCallId(pluginId: string, sessionId: string, agentId: string, toolCallId: string, requestId: string): string {
  const digest = createHash('sha256').update(canonicalJson([pluginId, sessionId, agentId, toolCallId, requestId])).digest('hex').slice(0, 32);
  return `plugin-message:${digest}`;
}

function cancelledMessageReceipt(index: number, messageId: string, detail: string): PluginMessageBatchItemReceipt {
  return { index, message_id: `send:${messageId}`, delivered_to: [], delivery: 'cancelled', detail };
}

function failedMessageReceipt(index: number, messageId: string, detail: string): PluginMessageBatchItemReceipt {
  return { index, message_id: `send:${messageId}`, delivered_to: [], delivery: 'not_sent', detail };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerScopedService(LifecycleScope.Agent, IAgentPluginToolService, AgentPluginToolService, ScopeActivation.OnScopeCreated, 'plugin');
