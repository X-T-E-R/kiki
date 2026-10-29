import { createHash } from 'node:crypto';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

import { createDecorator, IInstantiationService, type LiveRef, type ServicesAccessor, ref } from '#/_base/di/instantiation';
import { isAbortError } from '#/_base/utils/abort';
import { isSendMessageToolActive } from '#/agent/toolPolicy/sendMessageAdmission';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MESSAGE_DELIVERY_SENT_GUIDANCE } from '#/agent/delivery/deliveryReminder';
import { IAgentProfileService } from '#/agent/profile/profile';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import { IRoomMessageRouter, IUserMessageRouter, internalMessageChannel, routeUserMessage, type MessageAttachmentReceipt, type SendMessageReceipt } from '#/app/bot/messageRouting';
import { IBotService } from '#/app/bot/bot';
import { ISessionMediaStore, type SessionMediaFile } from '#/agent/media/sessionMediaStore';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ExecutableToolContext, ToolExecution } from '#/tool/toolContract';
import { Error2, ErrorCodes } from '#/errors';

const AttachmentSchema = z.union([
  z.object({
    path: z.string().min(1),
    title: z.string().min(1).optional(),
    kind: z.string().min(1).optional().describe('Delivery intent, for example file, image, audio, voice, or video. Omitted means file; voice is never silently sent as a file.'),
    mime_type: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/u).optional(),
  }).strict(),
  z.object({
    file_id: z.string().min(1),
    title: z.string().min(1).optional(),
    kind: z.string().min(1).optional().describe('Delivery intent, for example file, image, audio, voice, or video. Omitted is inferred from the stored media type.'),
    mime_type: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/u).optional(),
  }).strict(),
]);

const MessageBatchItemSchema = z.object({
  text: z.string().max(20_000).optional(),
  attachments: z.array(AttachmentSchema).max(32).optional(),
  reply_to: z.string().min(1).optional(),
  mention_ids: z.array(z.string().min(1).max(1024)).max(1000).optional(),
}).strict().refine((input) => (input.text?.trim().length ?? 0) > 0 || (input.attachments?.length ?? 0) > 0, {
  message: 'A message cannot be blank.',
});

export const SendMessageToolInputSchema = z.object({
  text: z.string().max(20_000).optional(),
  to: z.string().min(1).optional(),
  channel: z.string().min(1).optional().describe('One output channel ID; independent of the legacy user or @Bot recipient.'),
  channels: z.array(z.string().min(1)).min(1).max(32).optional().describe('Explicit output channel IDs. Omit to send to all enabled outputs bound to this thread.'),
  reply_to: z.string().min(1).optional(),
  mention_ids: z.array(z.string().min(1).max(1024)).max(1000).optional(),
  attachments: z.array(AttachmentSchema).max(32).optional(),
  messages: z.array(MessageBatchItemSchema).min(1).max(32).optional(),
  end_turn: z.boolean().optional().describe('Set true for the final answer when the request is complete and no work remains; omit for progress updates. Skips the tool continuation only after full user delivery and when this is the step’s only tool call. Pending messages and goal work still run.'),
}).strict().superRefine((input, ctx) => {
  const hasBatch = input.messages !== undefined;
  const hasLegacyContent = input.text !== undefined || input.attachments !== undefined || input.reply_to !== undefined || input.mention_ids !== undefined;
  if (hasBatch && hasLegacyContent) {
    ctx.addIssue({ code: 'custom', path: ['messages'], message: 'messages cannot be combined with text, attachments, or reply_to.' });
    return;
  }
  if (!hasBatch && ((input.text?.trim().length ?? 0) === 0 && (input.attachments?.length ?? 0) === 0)) {
    ctx.addIssue({ code: 'custom', message: 'A message cannot be blank.' });
  }
});

type SendMessageToolInput = z.infer<typeof SendMessageToolInputSchema>;

export interface ISendMessageTool extends AgentTool<SendMessageToolInput> {
  readonly _serviceBrand: undefined;
}

export const ISendMessageTool = createDecorator<ISendMessageTool>('sendMessageTool');

type AttachmentInput = z.infer<typeof AttachmentSchema>;
type SendMessageItemInput = {
  readonly text?: string;
  readonly attachments?: readonly AttachmentInput[];
  readonly reply_to?: string;
  readonly mention_ids?: readonly string[];
  readonly to?: string;
  readonly channel?: string;
  readonly channels?: readonly string[];
};

export class SendMessageTool implements ISendMessageTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'SendMessage';
  readonly description = 'Send one complete message or an ordered messages batch to this thread’s enabled bound outputs, a room, or another Bot. Use either the legacy text/attachments/reply_to fields or messages items, never both. Omit channel/channels for bound-output fan-out, or name explicit channel IDs; unbound channels require the borrowing policy. Attachments may be sent without text; set each attachment kind explicitly for image, audio, voice, or video delivery. Channel receipts identify unsupported media and uncertain sends; never downgrade voice or automatically resend an unknown outcome. Do not split one message into sentences or repeat it in ordinary text. A final ordinary reply is delivered in full as a fallback; do not resend it. For the final answer, if the request is complete and no work remains, set end_turn=true. It skips the tool continuation only after full user delivery and when this is the step’s only tool call; goal work and queued messages still run. Omit end_turn for progress messages and continue any required tools or pending work. Do not send a closing SendMessage or ordinary-text confirmation.';
  readonly parameters = toInputJsonSchema(SendMessageToolInputSchema);

  constructor(
    @ISessionContext private readonly session: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionWorkspaceInfo private readonly workspaceInfo: ISessionWorkspaceInfo,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IBlobStore private readonly blobs: IBlobStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBotService private readonly bots: IBotService,
    @ref(IRoomMessageRouter) private readonly roomRouter: LiveRef<IRoomMessageRouter>,
    @ref(IUserMessageRouter) private readonly userRouter: LiveRef<IUserMessageRouter>,
    @ISessionMediaStore private readonly media?: ISessionMediaStore,
  ) {}

  resolveExecution(input: SendMessageToolInput): ToolExecution {
    if (this.agent.agentId !== 'main' || !this.instantiation.invokeFunction(isSendMessageToolActive)) {
      return { output: 'SendMessage is disabled by the active capability or tool policy.', isError: true };
    }
    return {
      approvalRule: this.name,
      description: 'Sending a message',
      execute: async (ctx) => input.messages === undefined
        ? this.singleResult(input, ctx)
        : this.batchResult(input, ctx),
    };
  }

  private async singleResult(input: SendMessageToolInput, ctx: ExecutableToolContext): Promise<{ output: string; note?: string; stopTurn?: boolean }> {
    const receipt = await this.sendOne(input, ctx);
    const notes = notesForReceipt(receipt);
    return {
      output: JSON.stringify(toWireReceipt(receipt), null, 2),
      note: notes.length > 0 ? `<system>${notes.join(' ')}</system>` : undefined,
      stopTurn: input.end_turn === true && fullyDeliveredToUser(receipt) ? true : undefined,
    };
  }

  private async batchResult(input: SendMessageToolInput, ctx: ExecutableToolContext): Promise<{ output: string; note?: string; stopTurn?: boolean }> {
    const messages: Record<string, unknown>[] = [];
    const notes = new Set<string>();
    const batch = input.messages!;
    let fullyDelivered = batch.length > 0;
    for (let index = 0; index < batch.length; index++) {
      const itemCallId = `${ctx.toolCallId}:item:${index}`;
      if (ctx.signal.aborted) {
        fullyDelivered = false;
        for (let cancelled = index; cancelled < batch.length; cancelled++) {
          messages.push(stoppedWireReceipt(cancelled, `${ctx.toolCallId}:item:${cancelled}`, 'cancelled', 'Message batch cancelled before this item was sent.'));
        }
        break;
      }
      const item = batch[index]!;
      const itemInput: SendMessageItemInput = {
        text: item.text,
        attachments: item.attachments,
        reply_to: item.reply_to,
        mention_ids: item.mention_ids,
        to: input.to,
        channel: input.channel,
        channels: input.channels,
      };
      try {
        const receipt = await this.sendOne(itemInput, { ...ctx, toolCallId: itemCallId });
        messages.push({ index, ...toWireReceipt(receipt) });
        fullyDelivered = fullyDelivered && fullyDeliveredToUser(receipt);
        for (const note of notesForReceipt(receipt)) notes.add(note);
      } catch (error) {
        fullyDelivered = false;
        const cancelled = ctx.signal.aborted || isAbortError(error);
        messages.push(stoppedWireReceipt(index, itemCallId, cancelled ? 'cancelled' : 'not_sent', errorMessage(error)));
        const detail = cancelled ? 'Message batch cancelled before this item was sent.' : 'Message batch stopped after a previous item was not sent.';
        for (let unsent = index + 1; unsent < batch.length; unsent++) {
          messages.push(stoppedWireReceipt(unsent, `${ctx.toolCallId}:item:${unsent}`, cancelled ? 'cancelled' : 'not_sent', detail));
        }
        break;
      }
    }
    return {
      output: JSON.stringify({ messages }, null, 2),
      note: notes.size > 0 ? `<system>${[...notes].join(' ')}</system>` : undefined,
      stopTurn: input.end_turn === true && fullyDelivered ? true : undefined,
    };
  }

  private async sendOne(input: SendMessageItemInput, ctx: { readonly toolCallId: string; readonly signal: AbortSignal }): Promise<SendMessageReceipt> {
    if (!this.instantiation.invokeFunction(isSendMessageToolActive)) throw new Error2(ErrorCodes.REQUEST_INVALID, 'SendMessage is disabled by the active capability or tool policy.');
    const text = input.text ?? '';
    if (text.trim().length === 0 && (input.attachments?.length ?? 0) === 0) throw new Error2(ErrorCodes.REQUEST_INVALID, 'A message cannot be blank.');
    if (input.to !== undefined && input.to !== 'user' && !input.to.startsWith('@')) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Recipient must be user or @Bot.');
    }
    const attachments = await this.copyAttachments(input.attachments ?? []);
    const identity = this.senderIdentity();
    const roomId = await this.roomId();
    if ((input.mention_ids?.length ?? 0) > 0 && (roomId !== undefined || input.to?.startsWith('@'))) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Platform mentions require user output channel routing.');
    if ((input.channel !== undefined || input.channels !== undefined) && (roomId !== undefined || input.to?.startsWith('@'))) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Output channels cannot be combined with Room or @Bot routing.');
    }
    if (roomId !== undefined) {
      const router = this.roomRouter.current;
      if (router === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Room message delivery is unavailable.');
      return router.postBotMessage({ roomId, sessionId: this.session.sessionId, toolCallId: ctx.toolCallId, text, to: input.to, replyTo: input.reply_to, attachments });
    }
    if (input.to !== undefined && input.to.startsWith('@')) {
      return this.bots.sendHandoff({
        sourceSessionId: this.session.sessionId, sourcePersonaId: identity.personaId, sourceName: identity.name,
        target: input.to, content: text, attachments, replyTo: input.reply_to, idempotencyKey: ctx.toolCallId,
      });
    }
    const message = { sessionId: this.session.sessionId, toolCallId: ctx.toolCallId, text, attachments, replyTo: input.reply_to, mentionIds: input.mention_ids, sender: identity, channel: input.channel, channels: input.channels, signal: ctx.signal };
    return this.userRouter.current === undefined
      ? routeUserMessage(message, [internalMessageChannel()])
      : this.userRouter.current.sendMessage(message);
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
    const roots = inputs.some((input) => 'path' in input) ? await this.allowedRoots() : [];
    const copied: MessageAttachmentReceipt[] = [];
    for (const input of inputs) {
      let path: string;
      let name: string | undefined;
      let storedMediaType: string | undefined;
      let data: Uint8Array;
      if ('file_id' in input) {
        const file = this.media === undefined ? undefined : await this.media.open(input.file_id);
        if (file === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, `Attachment file_id is not available in this session: ${input.file_id}`);
        path = file.path ?? input.file_id;
        name = file.name;
        storedMediaType = file.mediaType;
        data = await readMediaFile(file);
        if (data.byteLength !== file.size) throw new Error2(ErrorCodes.REQUEST_INVALID, `Attachment file_id changed while being read: ${input.file_id}`);
      } else {
        const candidate = isAbsolute(input.path) ? input.path : resolve(this.session.cwd, input.path);
        path = await this.fs.realpath(candidate).catch(() => {
          throw new Error2(ErrorCodes.REQUEST_INVALID, `Attachment path does not exist: ${input.path}`);
        });
        if (!roots.some((root) => within(root, path))) {
          throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `Attachment path is outside the workspace or Bot directory: ${input.path}`);
        }
        const stat = await this.fs.stat(path);
        if (!stat.isFile) throw new Error2(ErrorCodes.REQUEST_INVALID, `Attachment is not a file: ${input.path}`);
        data = await this.fs.readBytes(path);
      }
      const hash = createHash('sha256').update(data).digest('hex');
      await this.blobs.put(this.agent.scope('blobs'), hash, data);
      copied.push({
        blobId: `blobref:${this.agent.agentId}:${hash}`,
        path,
        title: input.title ?? name,
        mimeType: input.mime_type ?? storedMediaType ?? mimeTypeFor(path),
        size: data.byteLength,
        kind: input.kind ?? (storedMediaType === undefined ? 'file' : messageKindForMime(storedMediaType)),
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

function fullyDeliveredToUser(receipt: SendMessageReceipt): boolean {
  return receipt.deliveredTo.includes('user') &&
    (receipt.delivery === undefined || receipt.delivery === 'delivered') &&
    (receipt.channels === undefined || receipt.channels.every((channel) => channel.status === 'delivered'));
}

function notesForReceipt(receipt: SendMessageReceipt): readonly string[] {
  const notes: string[] = [];
  if (receipt.channels?.some((channel) => channel.status === 'unknown')) notes.push('Some channel outcomes are unknown. Do not resend automatically; inspect the channel receipt before deciding what to do.');
  if (receipt.deliveredTo.includes('user') && (receipt.delivery === undefined || receipt.delivery === 'delivered')) notes.push(MESSAGE_DELIVERY_SENT_GUIDANCE);
  return notes;
}

function stoppedWireReceipt(index: number, toolCallId: string, delivery: 'cancelled' | 'not_sent', detail: string): Record<string, unknown> {
  return { index, message_id: `send:${toolCallId}`, delivered_to: [], delivery, detail };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readMediaFile(file: SessionMediaFile): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of file.stream()) chunks.push(chunk);
  const data = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}

function messageKindForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  return 'file';
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
      unsupported: channel.unsupported, detail: channel.detail, borrowed: channel.borrowed,
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
    isSendMessageToolActive(accessor);
}

registerAgentToolService(ISendMessageTool, SendMessageTool, {
  name: 'SendMessage',
  domain: 'message',
  when: mainMessageSession,
});
