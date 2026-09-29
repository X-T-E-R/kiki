import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

export type {
  ExternalPermissionDisplay,
  ExternalPermissionOption,
} from '#/tool/toolInputDisplay';

export interface SshCredentialSubmission {
  readonly password?: string;
  readonly privateKeyPath?: string;
  readonly privateKeyContents?: string;
  readonly passphrase?: string;
  readonly answers?: readonly string[];
  readonly save?: 'session' | 'workspace' | 'global';
}

export interface SshApprovalDetail {
  readonly kind: 'login' | 'host_key';
  readonly hostname: string;
  readonly user: string;
  readonly port: number;
  readonly proxyJump?: string;
  readonly proxyCommand?: string;
  readonly algorithm?: string;
  readonly fingerprint?: string;
  readonly prompts?: readonly { readonly prompt: string; readonly echo: boolean }[];
}

export interface ApprovalRequest {
  readonly ssh?: SshApprovalDetail;
  readonly id?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
  readonly selectedOptionId?: string;
  readonly reviewer?: { readonly backend: 'model' | 'jev'; readonly reason: string; readonly confidence: number };
}

export interface ISessionApprovalService {
  readonly _serviceBrand: undefined;

  request(req: ApprovalRequest): Promise<ApprovalResponse>;
  enqueue(req: ApprovalRequest): ApprovalRequest & { readonly id: string };
  decide(id: string, response: ApprovalResponse): void;
  decideSsh(id: string, response: ApprovalResponse, credential?: SshCredentialSubmission): void;
  takeSshCredential(id: string): SshCredentialSubmission | undefined;
  clearSshCredential(id: string): void;
  listPending(): readonly ApprovalRequest[];
}

export const ISessionApprovalService: ServiceIdentifier<ISessionApprovalService> =
  createDecorator<ISessionApprovalService>('sessionApprovalService');
