import type { ContextMessage } from '#/agent/contextMemory/types';
import { newMessageId } from '#/agent/contextMemory/messageId';
import type { MessageDeliveryOrigin } from '#/agent/contextMemory/messageDelivery';
import { StepRequest, type StepRequestOptions, type TurnSeed } from '#/agent/loop/stepRequest';
import type { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';

export interface PromptBatchMessage {
  readonly message: ContextMessage;
  readonly captions: readonly string[];
  readonly alreadyMaterialized?: boolean;
}

abstract class UserMessageStepRequest extends StepRequest {
  protected readonly message: ContextMessage;
  protected readonly batch: readonly PromptBatchMessage[];

  constructor(
    message: ContextMessage,
    captions: readonly string[],
    private readonly reminders: IAgentSystemReminderService,
    options?: StepRequestOptions,
    batch?: readonly PromptBatchMessage[],
  ) {
    super(options);
    this.message = { ...message, id: message.id ?? newMessageId() };
    this.batch = (batch ?? [{ message: this.message, captions }]).map(item => ({
      ...item, message: { ...item.message, id: item.message.id ?? newMessageId() },
    }));
  }

  override get turnSeed(): TurnSeed {
    return { input: this.message.content, origin: this.message.origin ?? { kind: 'unknown' } };
  }

  override onWillMaterialize(): void {
    for (const item of this.batch) {
      if (item.alreadyMaterialized) continue;
      for (const caption of item.captions) {
        this.reminders.appendSystemReminder(caption, {
          kind: 'injection',
          variant: 'image_compression',
          ownerPromptId: item.message.id,
        });
      }
    }
  }

  resolveContextMessages(): readonly ContextMessage[] {
    return this.batch.filter(item => !item.alreadyMaterialized && item.message.content.length > 0).map(item => item.message);
  }
}

export class PromptStepRequest extends UserMessageStepRequest {
  readonly kind = 'prompt';

  constructor(
    message: ContextMessage,
    captions: readonly string[],
    reminders: IAgentSystemReminderService,
    _providerType: string | undefined,
    private readonly alreadyMaterialized = false,
    deliveryOrigin?: MessageDeliveryOrigin,
    private readonly promptId?: string,
    batch?: readonly PromptBatchMessage[],
    private readonly recordBatch?: () => void,
    private readonly hookMessages: readonly ContextMessage[] = [],
    private readonly parentReceiptManaged?: boolean,
  ) {
    super(message, captions, reminders, { admission: 'newTurn', deliveryOrigin }, batch);
  }

  override get turnSeed(): TurnSeed {
    return {
      input: this.message.content,
      origin: this.message.origin ?? { kind: 'unknown' },
      promptId: this.promptId ?? this.message.id,
      parentReceiptManaged: this.parentReceiptManaged,
    };
  }

  override onWillMaterialize(): void {
    this.recordBatch?.();
    if (!this.alreadyMaterialized) super.onWillMaterialize();
  }

  override resolveContextMessages(): readonly ContextMessage[] {
    return [...(this.alreadyMaterialized ? [] : super.resolveContextMessages()), ...this.hookMessages];
  }
}

export class SteerStepRequest extends UserMessageStepRequest {
  readonly kind = 'steer';

  constructor(
    message: ContextMessage,
    captions: readonly string[],
    reminders: IAgentSystemReminderService,
    _providerType: string | undefined,
    private readonly recordSteer: (message: ContextMessage) => void,
    private readonly forgetSteer: (request: SteerStepRequest) => void,
    admission: 'activeTurnOnly' | 'activeOrNewTurn' = 'activeTurnOnly',
    deliveryOrigin?: MessageDeliveryOrigin,
    private readonly hookMessages: readonly ContextMessage[] = [],
    batch?: readonly PromptBatchMessage[],
  ) {
    super(message, captions, reminders, {
      mergeable: true,
      turnScoped: false,
      admission,
      deliveryOrigin,
    }, batch);
  }

  override onWillMaterialize(): void {
    this.recordSteer(this.message);
    super.onWillMaterialize();
  }

  override resolveContextMessages(): readonly ContextMessage[] {
    return [...super.resolveContextMessages(), ...this.hookMessages];
  }

  protected override onSettled(): void {
    this.forgetSteer(this);
  }
}

export class RetryStepRequest extends StepRequest {
  readonly kind = 'retry';

  constructor(private readonly parentReceiptManaged?: boolean) {
    super({ admission: 'newTurn' });
  }

  override get turnSeed(): TurnSeed {
    return { input: [], origin: { kind: 'retry' }, parentReceiptManaged: this.parentReceiptManaged };
  }

  resolveContextMessages(): readonly ContextMessage[] {
    return [];
  }
}
