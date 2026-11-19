import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import { IFlagService } from '#/app/flag/flag';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { kikiDefinitionReadRoots } from '#/app/bootstrap/definitionReadRoots';
import type { Model } from '#/kosong/model/catalog';
import { type ModelRequester } from '#/kosong/model/modelRequester';
import { IAgentRuntimeService, inspectAgentWorkspaceRoots } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { join } from 'pathe';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';

import { IImageConfigBridge } from './imageConfigBridge';
import { IAgentMediaToolsRegistrar } from './mediaTools';
import { createVideoUploader, registerMediaTools } from './registerMediaTools';

export const mediaRegisteredKeyKey = defineState<string | undefined>(
  'media.registeredKey',
  () => undefined as string | undefined,
);

export class AgentMediaToolsRegistrar extends Service implements IAgentMediaToolsRegistrar {
  declare readonly _serviceBrand: undefined;

  private registration: IDisposable | undefined;

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IEventBus eventBus: IEventBus,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentStateService private readonly states: IAgentStateService,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
    @IBootstrapService private readonly bootstrap?: IBootstrapService,
    @ISessionContext private readonly session?: ISessionContext,
    @ref(ICpuWorkerService) private readonly cpuWorkerRef?: LiveRef<ICpuWorkerService>,
    @ref(IImageConfigBridge) private readonly imageConfigRef?: LiveRef<IImageConfigBridge>,
  ) {
    super();
    this.states.contributeState(mediaRegisteredKeyKey);
    this.refresh();
    this._register(eventBus.subscribe(AgentStatusUpdated, () => this.refresh()));
    this._register(this.runtime.onDidChange(() => this.refresh()));
    this._register(toDisposable(() => this.registration?.dispose()));
  }

  private get registeredKey(): string | undefined {
    return this.states.get(mediaRegisteredKeyKey);
  }

  private set registeredKey(value: string | undefined) {
    this.states.set(mediaRegisteredKeyKey, value);
  }

  private tryResolveModel(alias: string): Model | undefined {
    if (alias === '') return undefined;
    try {
      return this.profile.getRuntimeModel(alias, this.profile.getRecipeModelSettings(alias));
    } catch {
      return undefined;
    }
  }

  refresh(): void {
    const capabilities = this.profile.getModelCapabilities();
    const modelAlias = this.profile.getModel();
    const providerType = this.profile.getModelProviderType();
    if (!this.runtime.isAvailable(['fs'])) {
      const key = [
        modelAlias,
        String(capabilities.image_in),
        String(capabilities.video_in),
        String(capabilities.audio_in),
        'runtime-unavailable',
      ].join('|');
      if (key === this.registeredKey) return;
      this.registeredKey = key;
      const previous = this.registration?.dispose();
      if (isPromiseLike(previous)) previous.catch(onUnexpectedError);
      this.registration = undefined;
      return;
    }
    const inspected = this.runtime.inspect();
    const identityKey = [
      inspected.identity.workspaceId,
      inspected.identity.runtimeId,
      inspected.identity.generation,
    ].join('|');
    const model = this.tryResolveModel(modelAlias);
    const configuredImagePolicy = model?.imagePolicy;
    const imagePolicy =
      configuredImagePolicy !== undefined &&
      !this.flags.enabled('image_format_conversion') &&
      configuredImagePolicy.convertUnsupported !== 'off'
        ? { acceptedTypes: configuredImagePolicy.acceptedTypes, convertUnsupported: 'off' as const }
        : configuredImagePolicy;
    const key = [
      modelAlias,
      providerType ?? '',
      model?.protocol ?? '',
      imagePolicy === undefined
        ? ''
        : `${[...imagePolicy.acceptedTypes].toSorted().join(',')}:${imagePolicy.convertUnsupported}`,
      String(capabilities.image_in),
      String(capabilities.video_in),
      String(capabilities.audio_in),
      identityKey,
      inspected.status,
      inspected.environment.pathClass,
      String(inspected.capabilities.has('fs')),
    ].join('|');
    if (key === this.registeredKey) return;
    this.registeredKey = key;
    const previous = this.registration?.dispose();
    if (isPromiseLike(previous)) previous.catch(onUnexpectedError);
    const workspaceCtx = this.workspaceCtx;
    const skillCatalog = this.skillCatalog;
    const runtime = this.runtime;
    const session = this.session;
    const imageConfigRef = this.imageConfigRef;
    const definitionRoots = kikiDefinitionReadRoots(this.bootstrap);
    let requester: ModelRequester | undefined;
    if (model !== undefined) {
      try {
        requester = this.profile.getRuntimeRequester(modelAlias, this.profile.getRecipeModelSettings(modelAlias));
      } catch {
        requester = undefined;
      }
    }
    this.registration = registerMediaTools(this.toolRegistry, {
      runtime,
      workspace: {
        get workspaceDir() {
          return inspectAgentWorkspaceRoots(runtime, workspaceCtx).workDir;
        },
        get additionalDirs() {
          return inspectAgentWorkspaceRoots(runtime, workspaceCtx).additionalDirs ?? [];
        },
        get definitionReadRoots() {
          return [...skillCatalog?.catalog.getSkillRoots() ?? [], ...definitionRoots];
        },
        get sessionAttachmentsReadRoot() {
          return session === undefined ? undefined : join(session.sessionDir, 'attachments');
        },
      },
      capabilities,
      videoUploader: createVideoUploader(requester, {
        client: this.telemetry,
        props: {
          model: modelAlias,
          provider_type: model?.providerType ?? model?.protocol,
          protocol: model?.protocol,
        },
      }),
      inlineVideoSupported: model?.protocol !== 'openai' && model?.protocol !== 'openai_responses',
      providerType,
      imagePolicy,
      telemetry: this.telemetry,
      cpuWorker: this.cpuWorkerRef?.current,
      imageLimits: imageConfigRef === undefined ? undefined : {
        get maxEdgePx() {
          return imageConfigRef.current?.maxEdgePx;
        },
        get readByteBudget() {
          return imageConfigRef.current?.readByteBudget;
        },
      },
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMediaToolsRegistrar,
  AgentMediaToolsRegistrar,
  ScopeActivation.OnScopeCreated,
  'media',
);
