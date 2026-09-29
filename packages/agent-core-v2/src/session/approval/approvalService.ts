import { randomUUID } from 'node:crypto';

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ISessionInteractionService } from '#/session/interaction/interaction';

import {
  type ApprovalRequest,
  type ApprovalResponse,
  type SshCredentialSubmission,
  ISessionApprovalService,
} from './approval';

export class SessionApprovalService implements ISessionApprovalService {
  declare readonly _serviceBrand: undefined;
  private readonly sshCredentials = new Map<string, SshCredentialSubmission>();

  constructor(@ISessionInteractionService private readonly interaction: ISessionInteractionService) {}

  request(req: ApprovalRequest): Promise<ApprovalResponse> {
    const origin = { agentId: req.agentId, turnId: req.turnId };
    if (!this.interaction.hasConsumer(origin)) return Promise.resolve({ decision: 'cancelled' });
    return this.interaction.request<ApprovalRequest, ApprovalResponse>({
      id: requestId(req),
      kind: 'approval',
      payload: req,
      origin,
    });
  }

  enqueue(req: ApprovalRequest): ApprovalRequest & { readonly id: string } {
    const id = requestId(req);
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
