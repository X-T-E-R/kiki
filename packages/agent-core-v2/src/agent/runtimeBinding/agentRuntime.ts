import { createDecorator, IInstantiationService, ref, type LiveRef, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Emitter, Event } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { IFlagService } from '#/app/flag/flag';
import { NATIVE_SSH_FLAG_ID } from '#/app/ssh/flag';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { SshRuntime } from '#/runtime/sshRuntime';
import type { TrustUnknownKey } from '@kiki/kaos/ssh-connection';
import type { SshCredentialSubmission } from '#/session/approval/approval';
import type { Runtime, RuntimeBinding, RuntimeCapability, RuntimeLease } from '#/runtime/runtime';
import { runtimeStatusAllows, type RuntimeGenerationSnapshot } from '#/runtime/runtimeRegistry';
import {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';

import { IAgentRuntimeBindingService } from './runtimeBinding';

export interface AgentRuntimeBindingSnapshot {
  readonly binding: RuntimeBinding;
  readonly available: boolean;
  readonly runtime?: RuntimeGenerationSnapshot;
}

export interface IAgentRuntimeService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<void>;
  inspect(): Runtime;
  isAvailable(required?: readonly RuntimeCapability[]): boolean;
  acquire(required?: readonly RuntimeCapability[]): RuntimeLease;
  nativeSshEnabled?(): boolean;
  approveSshTarget?(host: string, fingerprint: string, trustUnknown?: TrustUnknownKey,
    credential?: SshCredentialSubmission,
    keyboardInteractive?: (prompts: readonly { prompt: string; echo: boolean }[]) => Promise<readonly string[]>): void;
  prepareFor?(host?: string): Promise<Runtime>;
  acquireFor?(host: string | undefined, required?: readonly RuntimeCapability[]): RuntimeLease;
}

export const IAgentRuntimeService: ServiceIdentifier<IAgentRuntimeService> =
  createDecorator<IAgentRuntimeService>('agentRuntimeService');

export function inspectAgentRuntime(service: IAgentRuntimeService): Runtime {
  return service.inspect();
}

export function snapshotAgentRuntimeBinding(
  bindingService: IAgentRuntimeBindingService,
  runtimeService: IAgentRuntimeService,
): AgentRuntimeBindingSnapshot {
  const binding = bindingService.current;
  try {
    const runtime = runtimeService.inspect();
    return {
      binding,
      available: runtimeService.isAvailable(),
      runtime: {
        runtimeId: runtime.identity.runtimeId,
        generation: runtime.identity.generation,
        status: runtime.status,
        capabilities: [...runtime.capabilities],
      },
    };
  } catch {
    return { binding, available: false };
  }
}

export class AgentRuntimeService implements IAgentRuntimeService {
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange = Event.filter(this.changeEmitter.event, () => !this.changeEmitter.isDisposed);
  private readonly bindingSubscription: IDisposable;
  private readonly workspaceSubscription: IDisposable;
  private readonly scopeSubscription: IDisposable;
  private registrySubscription: IDisposable | undefined;
  private readonly approvedSshTargets = new Map<string, { fingerprint: string; trustUnknown?: TrustUnknownKey;
    credential?: SshCredentialSubmission;
    keyboardInteractive?: (prompts: readonly { prompt: string; echo: boolean }[]) => Promise<readonly string[]> }>();

  constructor(
    @IAgentRuntimeBindingService private readonly binding: IAgentRuntimeBindingService,
    @IRuntimeResolver private readonly resolver: IRuntimeResolver,
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @IInstantiationService instantiation: IInstantiationService,
    @IFlagService private readonly flags: IFlagService,
    @ref(IAgentPermissionModeService) private readonly permissionMode: LiveRef<IAgentPermissionModeService>,
  ) {
    this.bindingSubscription = this.binding.onDidChange(() => this.rebind());
    this.workspaceSubscription = this.workspaces.onDidChange((change) => {
      if (change.workspaceId === this.binding.current.workspaceId) this.rebind();
    });
    this.bindRegistry();
    this.scopeSubscription = instantiation.onWillDispose(() => this.dispose());
  }

  inspect(): Runtime {
    return this.resolver.inspect(this.binding.current);
  }

  isAvailable(required: readonly RuntimeCapability[] = []): boolean {
    try {
      const runtime = this.inspect();
      return runtimeStatusAllows(runtime, required) && required.every((capability) => runtime.capabilities.has(capability));
    } catch {
      return false;
    }
  }

  acquire(required: readonly RuntimeCapability[] = []): RuntimeLease {
    return this.resolver.acquire(this.binding.current, required);
  }

  nativeSshEnabled(): boolean {
    return this.flags.enabled(NATIVE_SSH_FLAG_ID);
  }

  approveSshTarget(host: string, fingerprint: string, trustUnknown?: TrustUnknownKey,
    credential?: SshCredentialSubmission,
    keyboardInteractive?: (prompts: readonly { prompt: string; echo: boolean }[]) => Promise<readonly string[]>): void {
    this.approvedSshTargets.set(host, { fingerprint, trustUnknown, credential, keyboardInteractive });
  }

  private bindingFor(host?: string): RuntimeBinding {
    if (host === undefined) return this.binding.current;
    if (!this.nativeSshEnabled()) throw new Error('Native SSH is disabled');
    return {
      workspaceId: this.binding.current.workspaceId,
      runtimeId: host === 'local' ? 'local' : `ssh:${host}`,
    };
  }

  async prepareFor(host?: string): Promise<Runtime> {
    const binding = this.bindingFor(host);
    if (binding.runtimeId.startsWith('ssh:')) {
      if (!this.nativeSshEnabled()) throw new Error('Native SSH is disabled');
      const hostId = binding.runtimeId.slice(4);
      const approval = this.approvedSshTargets.get(hostId);
      if (approval === undefined) throw new Error('SSH target has not passed the connection gate');
      await this.workspaces.prepareSshRuntime(binding.workspaceId);
      const runtime = this.resolver.inspect(binding);
      if (!(runtime instanceof SshRuntime)) throw new Error('SSH target does not provide an SSH runtime');
      await runtime.connect(this.permissionMode.current!.mode === 'yolo', approval.fingerprint,
        approval.trustUnknown, approval.credential, approval.keyboardInteractive);
      this.approvedSshTargets.set(hostId, { fingerprint: approval.fingerprint,
        trustUnknown: approval.trustUnknown, keyboardInteractive: approval.keyboardInteractive });
    }
    return this.resolver.inspect(binding);
  }

  acquireFor(host: string | undefined, required: readonly RuntimeCapability[] = []): RuntimeLease {
    return this.resolver.acquire(this.bindingFor(host), required);
  }

  dispose(): void {
    if (this.changeEmitter.isDisposed) return;
    this.changeEmitter.dispose();
    for (const subscription of [
      this.scopeSubscription,
      this.registrySubscription,
      this.workspaceSubscription,
      this.bindingSubscription,
    ]) {
      const result = subscription?.dispose();
      if (isPromiseLike(result)) result.catch(onUnexpectedError);
    }
  }

  private rebind(): void {
    if (this.changeEmitter.isDisposed) return;
    this.bindRegistry();
    this.changeEmitter.fire();
  }

  private bindRegistry(): void {
    const previous = this.registrySubscription?.dispose();
    if (isPromiseLike(previous)) previous.catch(onUnexpectedError);
    const binding = this.binding.current;
    const workspace = this.workspaces.get(binding.workspaceId);
    this.registrySubscription = workspace?.runtimes.onDidChange((change) => {
      if (change.runtimeId !== this.binding.current.runtimeId) return;
      const current = workspace.runtimes.current(change.runtimeId);
      if (change.current !== undefined && change.current !== current) return;
      this.changeEmitter.fire();
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRuntimeService,
  AgentRuntimeService,
  ScopeActivation.OnDemand,
  'agentRuntimeBinding',
);
