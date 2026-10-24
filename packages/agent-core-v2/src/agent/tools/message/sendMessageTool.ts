import { createHash } from 'node:crypto';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

import { createDecorator, type LiveRef, type ServicesAccessor, ref } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MESSAGE_DELIVERY_SENT_GUIDANCE } from '#/agent/delivery/deliveryReminder';
import { IAgentProfileService } from '#/agent/profile/profile';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import { IRoomMessageRouter, IUserMessageRouter, internalMessageChannel, routeUserMessage, type MessageAttachmentReceipt, type SendMessageReceipt } from '#/app/bot/messageRouting';
import { IBotService } from '#/app/bot/bot';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import { Error2, ErrorCodes } from '#/errors';

const AttachmentSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1).optional(),
  kind: z.string().min(1).optional().describe('Delivery intent, for example file, image, audio, voice, or video. Omitted means file; voice is never silently sent as a file.'),
  mime_type: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/u).optional(),
}).strict();

export const SendMessageToolInputSchema = z.object({
  text: z.string().max(20_000).optional(),
  to: z.string().min(1).optional(),
  reply_to: z.string().min(1).optional(),
  attachments: z.array(AttachmentSchema).max(32).optional(),
}).strict().refine((input) => (input.text?.trim().length ?? 0) > 0 || (input.attachments?.length ?? 0) > 0, {
  message: 'A message cannot be blank.',
});

type SendMessageToolInput = z.infer<typeof SendMessageToolInputSchema>;

export interface ISendMessageTool extends AgentTool<SendMessageToolInput> {
  readonly _serviceBrand: undefined;
}

export const ISendMessageTool = createDecorator<ISendMessageTool>('sendMessageTool');

type AttachmentInput = z.infer<typeof AttachmentSchema>;

export class SendMessageTool implements ISendMessageTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'SendMessage';
  readonly description = 'Send a complete message to the user, a room, or another Bot in message mode. Attachments may be sent without text; set each attachment kind explicitly for image, audio, voice, or video delivery. Channel receipts identify unsupported media and uncertain sends; never downgrade voice or automatically resend an unknown outcome. Do not split one message into sentences or repeat it in ordinary text. A final ordinary reply is delivered in full as a fallback; do not resend it. After successful delivery to the user, if the request is complete and no work remains, end the turn without a closing SendMessage or confirmation. Progress messages do not end ongoing work; continue any required tools or pending work.';
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
    @ref(IUserMessageRouter) private readonly userRouter: LiveRef<IUserMessageRouter>,
  ) {}

  resolveExecution(input: SendMessageToolInput): ToolExecution {
    if (this.delivery.effectiveMode() !== 'message') {
      return { output: 'SendMessage is available only in message delivery mode.', isError: true };
    }
    return {
      approvalRule: this.name,
      description: 'Sending a message',
      execute: async (ctx) => {
        const text = input.text ?? '';
        if (text.trim().length === 0 && (input.attachments?.length ?? 0) === 0) throw new Error2(ErrorCodes.REQUEST_INVALID, 'A message cannot be blank.');
        if (input.to !== undefined && input.to !== 'user' && !input.to.startsWith('@')) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, 'Recipient must be user or @Bot.');
        }
        const attachments = await this.copyAttachments(input.attachments ?? []);
        const identity = this.senderIdentity();
        const roomId = await this.roomId();
        let receipt: SendMessageReceipt;
        if (roomId !== undefined) {
          const router = this.roomRouter.current;
          if (router === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Room message delivery is unavailable.');
          receipt = await router.postBotMessage({ roomId, sessionId: this.session.sessionId, toolCallId: ctx.toolCallId, text, to: input.to, replyTo: input.reply_to, attachments });
        } else if (input.to !== undefined && input.to.startsWith('@')) {
          receipt = await this.bots.sendHandoff({
            sourceSessionId: this.session.sessionId, sourcePersonaId: identity.personaId, sourceName: identity.name,
            target: input.to, content: text, attachments, replyTo: input.reply_to, idempotencyKey: ctx.toolCallId,
          });
        } else {
          const message = { sessionId: this.session.sessionId, toolCallId: ctx.toolCallId, text, attachments, replyTo: input.reply_to, sender: identity };
          receipt = this.userRouter.current === undefined
            ? await routeUserMessage(message, [internalMessageChannel()])
            : await this.userRouter.current.sendMessage(message);
        }
        const notes: string[] = [];
        if (receipt.channels?.some((channel) => channel.status === 'unknown')) notes.push('Some channel outcomes are unknown. Do not resend automatically; inspect the channel receipt before deciding what to do.');
        if (receipt.deliveredTo.includes('user') && (receipt.delivery === undefined || receipt.delivery === 'delivered')) notes.push(MESSAGE_DELIVERY_SENT_GUIDANCE);
        return { output: JSON.stringify(toWireReceipt(receipt), null, 2), note: notes.length > 0 ? `<system>${notes.join(' ')}</system>` : undefined };
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
        mimeType: input.mime_type ?? mimeTypeFor(path),
        size: data.byteLength,
        kind: input.kind ?? 'file',
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
    '.gif': 'image/gif',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
  }[extension];
}

function toWireReceipt(receipt: SendMessageReceipt): Record<string, unknown> {
  return {
    message_id: receipt.messageId,
    delivered_to: receipt.deliveredTo,
    channels: receipt.channels?.map((channel) => ({
      channel_id: channel.channelId, status: channel.status, message_ids: channel.messageIds,
      unsupported: channel.unsupported, detail: channel.detail,
    })),
    ...(receipt.attachments === undefined ? {} : {
      attachments: receipt.attachments.map((attachment) => ({
        blob_id: attachment.blobId,
        path: attachment.path,
        kind: attachment.kind,
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
