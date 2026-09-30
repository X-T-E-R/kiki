import { createHash, randomUUID } from 'node:crypto';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

import { createDecorator, type LiveRef, type ServicesAccessor, ref } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentProfileService } from '#/agent/profile/profile';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import { IRoomMessageRouter, type MessageAttachmentReceipt, type SendMessageReceipt } from '#/app/bot/messageRouting';
import { IBotService } from '#/app/bot/bot';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import { Error2, ErrorCodes } from '#/errors';

const AttachmentSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1).optional(),
}).strict();

export const SendMessageToolInputSchema = z.object({
  text: z.string().min(1).max(20_000),
  to: z.string().min(1).optional(),
  reply_to: z.string().min(1).optional(),
  attachments: z.array(AttachmentSchema).max(32).optional(),
}).strict();

type SendMessageToolInput = z.infer<typeof SendMessageToolInputSchema>;

export interface ISendMessageTool extends AgentTool<SendMessageToolInput> {
  readonly _serviceBrand: undefined;
}

export const ISendMessageTool = createDecorator<ISendMessageTool>('sendMessageTool');

interface AttachmentInput {
  readonly path: string;
  readonly title?: string;
}

export class SendMessageTool implements ISendMessageTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'SendMessage';
  readonly description = 'Send a message to the user, a room, or another Bot. Ordinary assistant text is not delivered in message mode. Do not send empty confirmations, and do not repeat a message in ordinary text.';
  readonly parameters = toInputJsonSchema(SendMessageToolInputSchema);

  constructor(
    @ISessionContext private readonly session: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionWorkspaceInfo private readonly workspaceInfo: ISessionWorkspaceInfo,
    @ISessionDeliveryService private readonly delivery: ISessionDeliveryService,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IBlobStore private readonly blobs: IBlobStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBotService private readonly bots: IBotService,
    @ref(IRoomMessageRouter) private readonly roomRouter: LiveRef<IRoomMessageRouter>,
  ) {}

  resolveExecution(input: SendMessageToolInput): ToolExecution {
    if (this.delivery.effectiveMode() !== 'message') {
      return { output: 'SendMessage is available only in message delivery mode.', isError: true };
    }
    return {
      approvalRule: this.name,
      description: 'Sending a message',
      execute: async (ctx) => {
        const attachments = await this.copyAttachments(input.attachments ?? []);
        const identity = this.senderIdentity();
        const roomId = await this.roomId();
        let receipt: SendMessageReceipt;
        if (input.text.trim().length === 0) throw new Error2(ErrorCodes.REQUEST_INVALID, 'A message cannot be blank.');
        if (input.to !== undefined && input.to !== 'user' && !input.to.startsWith('@')) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, 'Recipient must be user or @Bot.');
        }
        if (roomId !== undefined) {
          const router = this.roomRouter.current;
          if (router === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Room message delivery is unavailable.');
          receipt = await router.postBotMessage({
            roomId,
            sessionId: this.session.sessionId,
            toolCallId: ctx.toolCallId,
            text: input.text,
            to: input.to,
            replyTo: input.reply_to,
            attachments,
          });
        } else if (input.to !== undefined && input.to.startsWith('@')) {
          receipt = await this.bots.sendHandoff({
            sourceSessionId: this.session.sessionId,
            sourcePersonaId: identity.personaId,
            sourceName: identity.name,
            target: input.to,
            content: input.text,
            attachments,
            replyTo: input.reply_to,
            idempotencyKey: ctx.toolCallId,
          });
        } else {
          receipt = {
            messageId: `msg_${randomUUID()}`,
            deliveredTo: ['user'],
            attachments: attachments.length > 0 ? attachments : undefined,
            sender: identity,
          };
        }
        return { output: JSON.stringify(toWireReceipt(receipt), null, 2) };
      },
    };
  }

  private senderIdentity(): { readonly sessionId: string; readonly personaId?: string; readonly name?: string } {
    const persona = this.profile.data().persona?.definition;
    return {
      sessionId: this.session.sessionId,
      personaId: persona?.id,
      name: persona?.name,
    };
  }

  private async roomId(): Promise<string | undefined> {
    const custom = (await this.metadata.read()).custom;
    const roomId = custom?.['room_member_of'];
    return typeof roomId === 'string' && roomId.length > 0 ? roomId : undefined;
  }

  private async copyAttachments(inputs: readonly AttachmentInput[]): Promise<readonly MessageAttachmentReceipt[]> {
    if (inputs.length === 0) return [];
    const roots = await this.allowedRoots();
    const copied: MessageAttachmentReceipt[] = [];
    for (const input of inputs) {
      const candidate = isAbsolute(input.path) ? input.path : resolve(this.session.cwd, input.path);
      const path = await this.fs.realpath(candidate).catch(() => {
        throw new Error2(ErrorCodes.REQUEST_INVALID, `Attachment path does not exist: ${input.path}`);
      });
      if (!roots.some((root) => within(root, path))) {
        throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `Attachment path is outside the workspace or Bot directory: ${input.path}`);
      }
      const stat = await this.fs.stat(path);
      if (!stat.isFile) throw new Error2(ErrorCodes.REQUEST_INVALID, `Attachment is not a file: ${input.path}`);
      const data = await this.fs.readBytes(path);
      const hash = createHash('sha256').update(data).digest('hex');
      await this.blobs.put(this.agent.scope('blobs'), hash, data);
      copied.push({
        blobId: `blobref:${this.agent.agentId}:${hash}`,
        path,
        title: input.title,
        mimeType: mimeTypeFor(path),
        size: data.byteLength,
      });
    }
    return copied;
  }

  private async allowedRoots(): Promise<readonly string[]> {
    await this.workspaceInfo.ready;
    const candidates = [this.session.cwd, ...this.workspaceInfo.additionalDirs, resolve(this.bootstrap.homeDir, 'bots')];
    const roots: string[] = [];
    for (const candidate of candidates) {
      const path = await this.fs.realpath(candidate).catch(() => undefined);
      if (path !== undefined) roots.push(path);
    }
    return roots;
  }
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}

function mimeTypeFor(path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  return {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  }[extension];
}

function toWireReceipt(receipt: SendMessageReceipt): Record<string, unknown> {
  return {
    message_id: receipt.messageId,
    delivered_to: receipt.deliveredTo,
    ...(receipt.attachments === undefined ? {} : {
      attachments: receipt.attachments.map((attachment) => ({
        blob_id: attachment.blobId,
        path: attachment.path,
        ...(attachment.title === undefined ? {} : { title: attachment.title }),
        ...(attachment.mimeType === undefined ? {} : { mime_type: attachment.mimeType }),
        ...(attachment.size === undefined ? {} : { size: attachment.size }),
      })),
    }),
    ...(receipt.sender === undefined ? {} : {
      sender: {
        ...(receipt.sender.personaId === undefined ? {} : { persona_id: receipt.sender.personaId }),
        ...(receipt.sender.name === undefined ? {} : { name: receipt.sender.name }),
        session_id: receipt.sender.sessionId,
      },
    }),
    ...(receipt.handoff === undefined ? {} : {
      handoff: {
        target_persona_id: receipt.handoff.targetPersonaId,
        target_session_id: receipt.handoff.targetSessionId,
        target_name: receipt.handoff.targetName,
        ...(receipt.handoff.messageId === undefined ? {} : { message_id: receipt.handoff.messageId }),
      },
    }),
    ...(receipt.deduplicated === undefined ? {} : { deduplicated: receipt.deduplicated }),
    ...(receipt.delivery === undefined ? {} : { delivery: receipt.delivery }),
  };
}

function mainMessageSession(accessor: ServicesAccessor): boolean {
  return accessor.get(IAgentScopeContext).agentId === 'main' &&
    accessor.get(ISessionDeliveryService).effectiveMode() === 'message';
}

registerAgentToolService(ISendMessageTool, SendMessageTool, {
  name: 'SendMessage',
  domain: 'message',
  when: mainMessageSession,
});
