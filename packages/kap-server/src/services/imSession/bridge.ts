import { Error2, ErrorCodes } from '@kiki/agent-core-v2';
import { ImIdentityAlreadyBoundError, ImSessionBridge as CoreImSessionBridge } from '@kiki-dsh/im-bridge-core/bridge';
import { MessageRoutingError } from '@kiki-dsh/im-bridge-core/userMessageRouting';

import type { ImSessionBridgeOptions } from './ports';

export { ImIdentityAlreadyBoundError };

export class ImSessionBridge extends CoreImSessionBridge {
  constructor(options: ImSessionBridgeOptions) {
    super(options as ConstructorParameters<typeof CoreImSessionBridge>[0]);
  }

  override async sendUserMessage(
    input: Parameters<CoreImSessionBridge['sendUserMessage']>[0],
  ): Promise<Awaited<ReturnType<CoreImSessionBridge['sendUserMessage']>>> {
    try {
      return await super.sendUserMessage(input);
    } catch (error) {
      if (error instanceof MessageRoutingError) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, error.message, { details: error.details, cause: error });
      }
      throw error;
    }
  }
}
