import type {
  ImAnswerResult,
  ImCredentialInstance,
  ImInboundIdentity,
  ImPendingApproval,
  ImPendingQuestion,
  ImQuestionAnswer,
  ImSessionBridgeOptions as CoreImSessionBridgeOptions,
  ImSessionPorts as CoreImSessionPorts,
  ImSubmitResult as CoreImSubmitResult,
  ImVisibleMedia,
  ImVisibleReply,
  WechatQrLoginPort,
} from '@kiki-dsh/im-bridge-core/ports';

export type {
  ImAnswerResult,
  ImCredentialInstance,
  ImInboundIdentity,
  ImPendingApproval,
  ImPendingQuestion,
  ImQuestionAnswer,
  ImVisibleMedia,
  ImVisibleReply,
  WechatQrLoginPort,
};

export interface ImSubmitResult extends Omit<CoreImSubmitResult, 'deliveryState'> {
  readonly deliveryState: CoreImSubmitResult['deliveryState'] | 'accepted';
}

export interface ImSessionPorts extends Omit<CoreImSessionPorts, 'sessions'> {
  readonly sessions: Omit<CoreImSessionPorts['sessions'], 'submit' | 'steer'> & {
    submit(input: Parameters<CoreImSessionPorts['sessions']['submit']>[0]): Promise<ImSubmitResult>;
    steer(sessionId: string, promptId: string): Promise<'accepted' | Awaited<ReturnType<CoreImSessionPorts['sessions']['steer']>>>;
  };
}

export interface ImSessionBridgeOptions extends Omit<CoreImSessionBridgeOptions, 'ports'> {
  readonly ports: ImSessionPorts;
}
