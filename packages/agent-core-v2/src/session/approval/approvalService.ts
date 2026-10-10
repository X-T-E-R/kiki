import { randomUUID } from 'node:crypto';

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IInstantiationService } from '#/_base/di/instantiation';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionInteractionService, isInteractionCancellation, type InteractionCancellation } from '#/session/interaction/interaction';

import {
  type ApprovalRequest,
  type ApprovalResponse,
  type SshCredentialSubmission,
  ISessionApprovalService,
} from './approval';

export class SessionApprovalService implements ISessionApprovalService {
  declare readonly _serviceBrand: undefined;
  private readonly sshCredentials = new Map<string, SshCredentialSubmission>();

  constructor(
    @ISessionInteractionService private readonly interaction: ISessionInteractionService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {}

  request(req: ApprovalRequest): Promise<ApprovalResponse> {
    const automatic = this.yoloResponse(req);
    if (automatic !== undefined) return Promise.resolve(automatic);
    const origin = { agentId: req.agentId, turnId: req.turnId };
    if (!this.interaction.hasConsumer(origin)) return Promise.resolve({ decision: 'cancelled', cancellationReason: 'no_consumer' });
    return this.interaction.request<ApprovalRequest, ApprovalResponse | InteractionCancellation>({
      id: requestId(req),
      kind: 'approval',
      payload: req,
      origin,
      detached: this.isExternalDriver(req),
    }).then((response) => isInteractionCancellation(response)
      ? { decision: 'cancelled', cancellationReason: response.reason }
      : response);
  }

  private isExternalDriver(req: ApprovalRequest): boolean {
    try {
      return this.instantiation.invokeFunction((accessor) => {
        const handle = accessor.get(IAgentLifecycleService).get(req.agentId ?? 'main');
        return handle?.accessor.get(IAgentProfileService).data().driver === 'external';
      });
    } catch {
      return false;
    }
  }

  private yoloResponse(req: ApprovalRequest): ApprovalResponse | undefined {
    let yolo = false;
    try {
      yolo = this.instantiation.invokeFunction((accessor) => accessor.get(IAgentLifecycleService)
        .get(req.agentId ?? 'main')?.accessor.get(IAgentPermissionModeService).mode === 'yolo');
    } catch {
      return undefined;
    }
    if (!yolo) return undefined;
    if (req.display.kind !== 'external_permission') return { decision: 'approved' };
    const option = req.display.options.find((option) => option.kind === 'allow_once')
      ?? req.display.options.find((option) => option.kind === 'allow_always');
    return option === undefined
      ? { decision: 'cancelled', feedback: 'The external provider supplied no approval option.' }
      : { decision: 'approved', selectedOptionId: option.id };
  }

  enqueue(req: ApprovalRequest): ApprovalRequest & { readonly id: string } {
    const id = requestId(req);
    if (this.yoloResponse(req) !== undefined) return { ...req, id };
    this.interaction.enqueue<ApprovalRequest>({
      id,
      kind: 'approval',
      payload: req,
      origin: { agentId: req.agentId, turnId: req.turnId },
    });
    return { ...req, id };
  }

  decide(id: string, response: ApprovalResponse): void {
    const pending = this.interaction
      .listPending('approval')
      .find((entry) => entry.id === id)?.payload as ApprovalRequest | undefined;
    if (pending?.ssh !== undefined) {
      this.interaction.respond(id, { decision: 'cancelled' } satisfies ApprovalResponse);
      return;
    }
    if (pending?.display.kind === 'external_permission') {
      const selected = response.selectedOptionId;
      if (
        selected === undefined ||
        !pending.display.options.some((option) => option.id === selected)
      ) {
        this.interaction.respond(id, { decision: 'cancelled' } satisfies ApprovalResponse);
        return;
      }
    }
    this.interaction.respond(id, response);
  }

  decideSsh(id: string, response: ApprovalResponse, credential?: SshCredentialSubmission): void {
    const pending = this.interaction.listPending('approval')
      .find((entry) => entry.id === id)?.payload as ApprovalRequest | undefined;
    if (pending?.ssh === undefined) throw new Error('SSH approval not pending');
    if (pending.ssh.kind === 'host_key' && credential !== undefined) throw new Error('Host key confirmation cannot carry credentials');
    if (response.feedback !== undefined || response.selectedLabel !== undefined || response.selectedOptionId !== undefined) {
      throw new Error('SSH approval cannot carry feedback or option fields');
    }
    if (response.decision === 'approved' && credential !== undefined) this.sshCredentials.set(id, credential);
    this.interaction.respond(id, { decision: response.decision } satisfies ApprovalResponse);
  }

  takeSshCredential(id: string): SshCredentialSubmission | undefined {
    const value = this.sshCredentials.get(id);
    this.sshCredentials.delete(id);
    return value;
  }

  clearSshCredential(id: string): void {
    this.sshCredentials.delete(id);
  }

  listPending(): readonly ApprovalRequest[] {
    return this.interaction
      .listPending('approval')
      .map((i) => ({ ...(i.payload as ApprovalRequest), id: i.id }));
  }
}

function requestId(req: ApprovalRequest): string {
  return req.id ?? `approval_${randomUUID()}`;
}

registerScopedService(LifecycleScope.Session, ISessionApprovalService, SessionApprovalService, ScopeActivation.OnScopeCreated, 'approval');
