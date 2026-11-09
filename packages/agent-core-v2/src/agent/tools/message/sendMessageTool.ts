import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

import { createDecorator, IInstantiationService, type LiveRef, type ServiceIdentifier, type ServicesAccessor, ref } from '#/_base/di/instantiation';
import { isAbortError } from '#/_base/utils/abort';
import { isSendMessageToolActive } from '#/agent/toolPolicy/sendMessageAdmission';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MESSAGE_DELIVERY_SENT_GUIDANCE } from '#/agent/delivery/deliveryReminder';
import { IAgentProfileService } from '#/agent/profile/profile';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService, type IHostProcess } from '#/os/interface/hostProcess';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import {
  IRoomMessageRouter,
  IUserMessageRouter,
  internalMessageChannel,
  routeUserMessage,
  supportsMessageMedia,
  type MessageAttachmentReceipt,
  type MessageChannelBinding,
  type MessageChannelReceipt,
  type SendMessageReceipt,
  type UserMessageInput,
} from '#/app/bot/messageRouting';
import { IBotService } from '#/app/bot/bot';
import { ISessionMediaStore, type SessionMediaFile } from '#/agent/media/sessionMediaStore';
import { IPluginMediaService } from '#/app/pluginMedia/pluginMedia';
import { IPluginSettingsService } from '#/app/plugin/pluginSettingsService';
import { IRequestIdentityRegistry } from '#/session/requestIdentity/requestIdentityRegistry';
import type { MediaJob } from '@kiki/protocol';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ExecutableToolContext, ToolExecution } from '#/tool/toolContract';
import { Error2, ErrorCodes } from '#/errors';
import { SEND_MESSAGE_SECTION, SendMessageVoiceModeSchema, type SendMessageConfig, type SendMessageVoiceMode } from './configSection';

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

export const SendMessageTtsInputSchema = z.object({
  mode: SendMessageVoiceModeSchema.optional().describe('Voice delivery mode: none (no voice), append (keep text and attach native voice), or only (send native voice without text).'),
  text: z.string().max(20_000).optional().describe('Optional separate narration text to synthesize into speech instead of the message text.'),
  provider: z.string().min(1).optional().describe('Optional TTS provider override (for example kiki-media/openai-speech).'),
  model: z.string().min(1).optional().describe('Optional TTS model override.'),
  voice: z.string().min(1).optional().describe('Optional TTS voice identifier override.'),
  language: z.string().min(1).optional().describe('Optional language hint for TTS synthesis.'),
  format: z.string().min(1).optional().describe('Optional output audio format hint (for example opus, ogg, mp3, wav).'),
  sample_rate_hz: z.number().int().positive().optional().describe('Optional audio sample rate in Hz.'),
  options: z.record(z.string(), z.unknown()).optional().describe('Optional provider-specific TTS options.'),
}).strict();

export type SendMessageTtsInput = z.infer<typeof SendMessageTtsInputSchema>;

const MessageBatchItemSchema = z.object({
  text: z.string().max(20_000).optional(),
  attachments: z.array(AttachmentSchema).max(32).optional(),
  reply_to: z.string().min(1).optional(),
  mention_ids: z.array(z.string().min(1).max(1024)).max(1000).optional(),
  voice_mode: SendMessageVoiceModeSchema.optional().describe('Optional per-message voice delivery mode override: none, append, or only.'),
  tts: SendMessageTtsInputSchema.optional().describe('Optional per-message TTS configuration and narration text override.'),
}).strict().refine((input) => (input.text?.trim().length ?? 0) > 0 || (input.attachments?.length ?? 0) > 0 || (input.tts?.text?.trim().length ?? 0) > 0, {
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
  voice_mode: SendMessageVoiceModeSchema.optional().describe('Voice delivery mode: none (default unless configured in Settings), append (keep text and attach native voice), or only (send native voice without text).'),
  tts: SendMessageTtsInputSchema.optional().describe('Optional TTS synthesis configuration, provider/voice/model overrides, and separate speech text.'),
  messages: z.array(MessageBatchItemSchema).min(1).max(32).optional(),
  end_turn: z.boolean().optional().describe('Set true for the final answer when the request is complete and no work remains; omit for progress updates. Skips the tool continuation after confirmed user delivery when every tool call in the step is a confirmed SendMessage. Pending messages and goal work still run.'),
}).strict().superRefine((input, ctx) => {
  const hasBatch = input.messages !== undefined;
  const hasLegacyContent = input.text !== undefined || input.attachments !== undefined || input.reply_to !== undefined || input.mention_ids !== undefined || input.tts?.text !== undefined;
  if (hasBatch && hasLegacyContent) {
    ctx.addIssue({ code: 'custom', path: ['messages'], message: 'messages cannot be combined with text, attachments, or reply_to.' });
    return;
  }
  if (!hasBatch && ((input.text?.trim().length ?? 0) === 0 && (input.attachments?.length ?? 0) === 0 && (input.tts?.text?.trim().length ?? 0) === 0)) {
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
  readonly voice_mode?: SendMessageVoiceMode;
  readonly tts?: SendMessageTtsInput;
  readonly top_voice_mode?: SendMessageVoiceMode;
  readonly top_tts?: SendMessageTtsInput;
  readonly to?: string;
  readonly channel?: string;
  readonly channels?: readonly string[];
};

type ResolvedTtsConfig = {
  readonly mode: SendMessageVoiceMode;
  readonly explicitVoiceRequest: boolean;
  readonly speechText: string;
  readonly provider?: string;
  readonly model?: string;
  readonly voice?: string;
  readonly language?: string;
  readonly format?: string;
  readonly sampleRateHz?: number;
  readonly options?: Record<string, unknown>;
  readonly ffmpegPath?: string;
};

type ExtendedReceipt = SendMessageReceipt & {
  readonly voiceOnly?: boolean;
};

function optionalService<T>(instantiation: IInstantiationService, id: ServiceIdentifier<T>): T | undefined {
  try {
    return instantiation.invokeFunction((accessor) => accessor.get(id));
  } catch {
    return undefined;
  }
}

export class SendMessageTool implements ISendMessageTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'SendMessage';
  readonly description = 'Send one complete message or an ordered messages batch to this thread’s enabled bound outputs, a room, or another Bot. Use either the legacy text/attachments/reply_to fields or messages items, never both. Omit channel/channels for bound-output fan-out, or name explicit channel IDs; unbound channels require the borrowing policy. Attachments may be sent without text; set each attachment kind explicitly for image, audio, voice, or video delivery. Native TTS voice synthesis can be controlled per message or batch via voice_mode (none, append, only) and tts (mode, text, provider, model, voice, language, format, sample_rate_hz, options); omitted fields use Settings defaults. Channel receipts identify unsupported media and uncertain sends; never downgrade voice or automatically resend an unknown outcome. Do not split one message into sentences or repeat it in ordinary text. A final ordinary reply is delivered in full as a fallback; do not resend it. For the final answer, if the request is complete and no work remains, set end_turn=true. It skips the tool continuation after confirmed user delivery when every tool call in the step is a confirmed SendMessage; goal work and queued messages still run. Omit end_turn for progress messages and continue any required tools or pending work. Do not send a closing SendMessage or ordinary-text confirmation.';
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

  private async singleResult(input: SendMessageToolInput, ctx: ExecutableToolContext): Promise<{ output: string; note?: string; stopTurn?: boolean; userDeliveryConfirmed?: boolean }> {
    const receipt = await this.sendOne(input, ctx);
    const notes = notesForReceipt(receipt);
    const userDeliveryConfirmed = confirmedUserDelivery(receipt, input);
    return {
      output: JSON.stringify(toWireReceipt(receipt), null, 2),
      note: notes.length > 0 ? `<system>${notes.join(' ')}</system>` : undefined,
      userDeliveryConfirmed: userDeliveryConfirmed ? true : undefined,
      stopTurn: input.end_turn === true && userDeliveryConfirmed ? true : undefined,
    };
  }

  private async batchResult(input: SendMessageToolInput, ctx: ExecutableToolContext): Promise<{ output: string; note?: string; stopTurn?: boolean; userDeliveryConfirmed?: boolean }> {
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
        voice_mode: item.voice_mode,
        tts: item.tts,
        top_voice_mode: input.voice_mode,
        top_tts: input.tts,
        to: input.to,
        channel: input.channel,
        channels: input.channels,
      };
      try {
        const receipt = await this.sendOne(itemInput, { ...ctx, toolCallId: itemCallId });
        messages.push({ index, ...toWireReceipt(receipt) });
        fullyDelivered = fullyDelivered && confirmedUserDelivery(receipt, itemInput);
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
      userDeliveryConfirmed: fullyDelivered ? true : undefined,
      stopTurn: input.end_turn === true && fullyDelivered ? true : undefined,
    };
  }

  private resolveTtsConfig(input: SendMessageItemInput): ResolvedTtsConfig {
    const configService = optionalService(this.instantiation, IConfigService);
    const settings = configService?.get<SendMessageConfig | undefined>(SEND_MESSAGE_SECTION);
    const explicitMode = input.tts?.mode
      ?? input.voice_mode
      ?? input.top_tts?.mode
      ?? input.top_voice_mode;
    const explicitVoiceRequest = explicitMode !== undefined
      || (explicitMode !== 'none' && (input.tts !== undefined || input.top_tts !== undefined));
    const mode: SendMessageVoiceMode = explicitMode
      ?? settings?.voiceMode
      ?? 'none';
    const rawSpeech = input.tts?.text !== undefined && input.tts.text.trim().length > 0
      ? input.tts.text
      : input.text ?? '';
    return {
      mode,
      explicitVoiceRequest,
      speechText: rawSpeech,
      provider: nonEmptyString(input.tts?.provider ?? input.top_tts?.provider ?? settings?.ttsProvider),
      model: nonEmptyString(input.tts?.model ?? input.top_tts?.model ?? settings?.ttsModel),
      voice: nonEmptyString(input.tts?.voice ?? input.top_tts?.voice ?? settings?.ttsVoice),
      language: nonEmptyString(input.tts?.language ?? input.top_tts?.language ?? settings?.ttsLanguage),
      format: nonEmptyString(input.tts?.format ?? input.top_tts?.format ?? settings?.ttsFormat),
      sampleRateHz: input.tts?.sample_rate_hz ?? input.top_tts?.sample_rate_hz ?? settings?.ttsSampleRateHz,
      options: input.tts?.options ?? input.top_tts?.options ?? settings?.ttsOptions,
      ffmpegPath: nonEmptyString(settings?.ffmpegPath) ?? 'ffmpeg',
    };
  }

  private async sendOne(input: SendMessageItemInput, ctx: { readonly toolCallId: string; readonly signal: AbortSignal }): Promise<ExtendedReceipt> {
    if (!this.instantiation.invokeFunction(isSendMessageToolActive)) throw new Error2(ErrorCodes.REQUEST_INVALID, 'SendMessage is disabled by the active capability or tool policy.');
    if (input.to !== undefined && input.to !== 'user' && !input.to.startsWith('@')) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Recipient must be user or @Bot.');
    }
    const identity = this.senderIdentity();
    const roomId = await this.roomId();
    const isRoomOrBot = roomId !== undefined || (input.to !== undefined && input.to.startsWith('@'));
    if ((input.mention_ids?.length ?? 0) > 0 && isRoomOrBot) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Platform mentions require user output channel routing.');
    if ((input.channel !== undefined || input.channels !== undefined) && isRoomOrBot) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Output channels cannot be combined with Room or @Bot routing.');
    }

    const resolvedTts = this.resolveTtsConfig(input);
    const tts: ResolvedTtsConfig = isRoomOrBot && !resolvedTts.explicitVoiceRequest
      ? { ...resolvedTts, mode: 'none' }
      : resolvedTts;
    const rawText = input.text ?? '';
    if (tts.mode === 'none') {
      if (rawText.trim().length === 0 && (input.attachments?.length ?? 0) === 0) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'A message cannot be blank.');
      }
    } else if (tts.speechText.trim().length === 0) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'TTS voice synthesis requires non-empty text or tts.text.');
    }
    const deliveredText = tts.mode === 'only'
      ? ''
      : tts.mode === 'append' && rawText.trim().length === 0
        ? tts.speechText
        : rawText;
    const baseAttachments = await this.copyAttachments(input.attachments ?? []);
    if (roomId !== undefined) {
      const channelId = `room:${roomId}`;
      if (tts.mode === 'only' && baseAttachments.length === 0) {
        return {
          messageId: `send:${ctx.toolCallId}`,
          deliveredTo: [],
          sender: identity,
          delivery: 'undeliverable',
          voiceOnly: true,
          channels: [{ channelId, status: 'unsupported', unsupported: ['voice'] }],
        };
      }
      const router = this.roomRouter.current;
      if (router === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Room message delivery is unavailable.');
      const receipt = await router.postBotMessage({ roomId, sessionId: this.session.sessionId, toolCallId: ctx.toolCallId, text: deliveredText, to: input.to, replyTo: input.reply_to, attachments: baseAttachments });
      if (tts.mode === 'none') return receipt;
      return markTargetVoiceUnsupportedOnReceipt(receipt, channelId, tts.mode);
    }
    if (input.to !== undefined && input.to.startsWith('@')) {
      if (tts.mode === 'only' && baseAttachments.length === 0) {
        return {
          messageId: `send:${ctx.toolCallId}`,
          deliveredTo: [],
          sender: identity,
          delivery: 'undeliverable',
          voiceOnly: true,
          channels: [{ channelId: input.to, status: 'unsupported', unsupported: ['voice'] }],
        };
      }
      const receipt = await this.bots.sendHandoff({
        sourceSessionId: this.session.sessionId, sourcePersonaId: identity.personaId, sourceName: identity.name,
        target: input.to, content: deliveredText, attachments: baseAttachments, replyTo: input.reply_to, idempotencyKey: ctx.toolCallId,
      });
      if (tts.mode === 'none') return receipt;
      return markTargetVoiceUnsupportedOnReceipt(receipt, input.to, tts.mode);
    }

    if (tts.mode === 'none') {
      const message: UserMessageInput = {
        sessionId: this.session.sessionId,
        toolCallId: ctx.toolCallId,
        text: deliveredText,
        attachments: baseAttachments,
        replyTo: input.reply_to,
        mentionIds: input.mention_ids,
        sender: identity,
        channel: input.channel,
        channels: input.channels,
        signal: ctx.signal,
      };
      return this.userRouter.current === undefined
        ? routeUserMessage(message, [internalMessageChannel()])
        : this.userRouter.current.sendMessage(message);
    }

    const selection = await this.inspectSelectedChannels(input);
    if (selection !== undefined) {
      const anySupportsVoice = selection.channels.some((ch) => ch.capabilities.some((cap) => cap.kind === 'voice'));
      if (tts.mode === 'only' && baseAttachments.length === 0 && !anySupportsVoice) {
        return {
          messageId: `send:${ctx.toolCallId}`,
          deliveredTo: [],
          sender: identity,
          delivery: 'undeliverable',
          voiceOnly: true,
          channels: selection.channels.map((ch) => ({
            channelId: ch.id,
            status: 'unsupported' as const,
            borrowed: selection.borrowed.has(ch.id) ? true : undefined,
            unsupported: ['voice'],
          })),
        };
      }
    }

    const voiceAttachment = await this.synthesizeVoiceAttachment(tts, selection?.channels, ctx);
    const allAttachments = [...baseAttachments, voiceAttachment];
    const receipt = await this.routeWithVoice(
      {
        sessionId: this.session.sessionId,
        toolCallId: ctx.toolCallId,
        text: deliveredText,
        attachments: allAttachments,
        replyTo: input.reply_to,
        mentionIds: input.mention_ids,
        sender: identity,
        channel: input.channel,
        channels: input.channels,
        signal: ctx.signal,
      },
      baseAttachments,
      voiceAttachment,
      tts.mode,
      selection,
    );
    return tts.mode === 'only' ? { ...receipt, voiceOnly: true } : receipt;
  }

  private async inspectSelectedChannels(input: SendMessageItemInput): Promise<{
    readonly channels: readonly MessageChannelBinding[];
    readonly borrowed: ReadonlySet<string>;
  } | undefined> {
    const router = this.userRouter.current;
    const available: readonly MessageChannelBinding[] | undefined = router === undefined
      ? [internalMessageChannel()]
      : router.listChannels !== undefined
        ? await router.listChannels(this.session.sessionId)
        : undefined;
    if (available === undefined) return undefined;
    const allowBorrowing = router?.allowChannelBorrowing !== undefined
      ? await router.allowChannelBorrowing()
      : false;
    const byId = new Map<string, MessageChannelBinding>();
    for (const ch of available) {
      if (!byId.has(ch.id)) byId.set(ch.id, ch);
    }
    const requested = [...new Set([
      ...(input.channel === undefined ? [] : [input.channel]),
      ...(input.channels ?? []),
    ])];
    if (requested.length === 0) {
      const selected = [...byId.values()].filter((ch) => ch.enabled && ch.bound !== false);
      if (selected.length === 0) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'no_destination: No message channel is enabled for this conversation.', {
          details: { reason: 'no_destination' },
        });
      }
      return { channels: selected, borrowed: new Set() };
    }
    const selected: MessageChannelBinding[] = [];
    const borrowed = new Set<string>();
    for (const id of requested) {
      const ch = byId.get(id);
      if (ch === undefined) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, `channel_not_found: Message channel ${id} does not exist.`, {
          details: { reason: 'channel_not_found', channelId: id },
        });
      }
      if (!ch.enabled) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, `channel_disabled: Message channel ${id} is disabled.`, {
          details: { reason: 'channel_disabled', channelId: id },
        });
      }
      if (ch.bound === false) {
        if (!allowBorrowing) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, `channel_borrowing_disabled: Message channel ${id} is available but not bound to this conversation.`, {
            details: { reason: 'channel_borrowing_disabled', channelId: id },
          });
        }
        borrowed.add(id);
      }
      selected.push(ch);
    }
    return { channels: selected, borrowed };
  }

  private async routeWithVoice(
    message: UserMessageInput,
    baseAttachments: readonly MessageAttachmentReceipt[],
    voiceAttachment: MessageAttachmentReceipt,
    mode: SendMessageVoiceMode,
    selection: { readonly channels: readonly MessageChannelBinding[]; readonly borrowed: ReadonlySet<string> } | undefined,
  ): Promise<SendMessageReceipt> {
    const dispatch = (msg: UserMessageInput): Promise<SendMessageReceipt> =>
      this.userRouter.current === undefined
        ? routeUserMessage(msg, [internalMessageChannel()])
        : this.userRouter.current.sendMessage(msg);

    if (selection === undefined) {
      try {
        return await dispatch(message);
      } catch (error) {
        if (isMediaUnsupportedError(error) && mode === 'append' && message.text.length > 0) {
          const fallback = await dispatch({ ...message, attachments: baseAttachments });
          return markVoiceUnsupportedOnReceipt(fallback, voiceAttachment, mode);
        }
        if (isMediaUnsupportedError(error) && mode === 'only' && baseAttachments.length === 0) {
          const channelIds = extractErrorChannels(error);
          return {
            messageId: `send:${message.toolCallId}`,
            deliveredTo: [],
            attachments: [voiceAttachment],
            sender: message.sender,
            delivery: 'undeliverable',
            channels: channelIds.map((channelId) => ({
              channelId,
              status: 'unsupported' as const,
              unsupported: ['voice'],
            })),
          };
        }
        throw error;
      }
    }

    const voiceSupportedChannels = selection.channels.filter((ch) => supportsMessageMedia(ch, voiceAttachment));
    const voiceUnsupportedChannels = selection.channels.filter((ch) => !supportsMessageMedia(ch, voiceAttachment));

    if (mode === 'only') {
      const deliverableChannels = selection.channels.filter(
        (ch) => supportsMessageMedia(ch, voiceAttachment) || baseAttachments.some((att) => supportsMessageMedia(ch, att)),
      );
      if (deliverableChannels.length === 0) {
        return {
          messageId: `send:${message.toolCallId}`,
          deliveredTo: [],
          attachments: message.attachments,
          sender: message.sender,
          delivery: 'undeliverable',
          channels: selection.channels.map((ch) => ({
            channelId: ch.id,
            status: 'unsupported' as const,
            borrowed: selection.borrowed.has(ch.id) ? true : undefined,
            unsupported: [...new Set(message.attachments.filter((att) => !supportsMessageMedia(ch, att)).map((att) => att.kind ?? 'file'))],
          })),
        };
      }
      if (deliverableChannels.length === selection.channels.length) {
        return dispatch(message);
      }
      const subReceipt = await dispatch({
        ...message,
        channel: undefined,
        channels: deliverableChannels.map((ch) => ch.id),
      });
      const subMap = new Map<string, MessageChannelReceipt>(
        (subReceipt.channels ?? []).map((ch) => [ch.channelId, ch]),
      );
      const mergedChannels: MessageChannelReceipt[] = selection.channels.map((ch) => {
        const existing = subMap.get(ch.id);
        if (existing !== undefined) return existing;
        return {
          channelId: ch.id,
          status: 'unsupported' as const,
          borrowed: selection.borrowed.has(ch.id) ? true : undefined,
          unsupported: [...new Set(message.attachments.filter((att) => !supportsMessageMedia(ch, att)).map((att) => att.kind ?? 'file'))],
        };
      });
      const delivered = mergedChannels.some((ch) => ch.status === 'delivered' || ch.status === 'partial');
      const blocked = mergedChannels.length > 0 && mergedChannels.every((ch) => ch.status === 'unsupported' || ch.status === 'failed');
      return {
        messageId: `send:${message.toolCallId}`,
        deliveredTo: delivered ? ['user'] : [],
        attachments: message.attachments,
        sender: message.sender,
        delivery: delivered ? 'delivered' : blocked ? 'undeliverable' : 'pending',
        channels: mergedChannels,
      };
    }

    if (voiceSupportedChannels.length === 0 && voiceUnsupportedChannels.length > 0 && message.text.length > 0) {
      const textReceipt = await dispatch({
        ...message,
        attachments: baseAttachments,
      });
      return markVoiceUnsupportedOnReceipt(textReceipt, voiceAttachment, mode);
    }

    return dispatch(message);
  }

  private async synthesizeVoiceAttachment(
    tts: ResolvedTtsConfig,
    targetChannels: readonly MessageChannelBinding[] | undefined,
    ctx: { readonly toolCallId: string; readonly signal: AbortSignal },
  ): Promise<MessageAttachmentReceipt> {
    ctx.signal.throwIfAborted();
    const pluginMedia = optionalService(this.instantiation, IPluginMediaService);
    if (pluginMedia === undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'TTS voice synthesis is unavailable: media service is not registered.');
    }
    if (this.media === undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'TTS voice synthesis is unavailable: session media store is not registered.');
    }

    const resolvedProvider = await this.resolveTtsProvider(pluginMedia, tts.provider);
    const voice = await this.resolveTtsVoice(pluginMedia, resolvedProvider, tts.model, tts.language, tts.voice);
    const identities = optionalService(this.instantiation, IRequestIdentityRegistry);
    let identity: Record<string, unknown> | undefined;
    if (identities !== undefined) {
      const snapshot = await identities.snapshot({
        agentId: this.agent.agentId,
        turnKey: `media:send-tts:${ctx.toolCallId}`,
        parentAgentId: this.agent.parentAgentId,
        compactionWindow: 0,
        logicalIdKind: 'uuidv4',
      });
      const copy = { ...snapshot };
      Reflect.deleteProperty(copy, 'setTurnState');
      identity = copy;
    }

    const requestId = `send-tts:${ctx.toolCallId}`;
    let job: MediaJob;
    try {
      job = await pluginMedia.start(
        {
          request_id: requestId,
          provider: resolvedProvider,
          model: tts.model,
          execution: 'auto',
          request: {
            kind: 'tts',
            text: tts.speechText,
            voice,
            language: tts.language,
            format: tts.format,
            sample_rate_hz: tts.sampleRateHz,
            options: tts.options,
          },
        },
        {
          sessionId: this.session.sessionId,
          agentId: this.agent.agentId,
          mediaScope: this.session.scope('media'),
          identity,
          parentAgentId: this.agent.parentAgentId,
        },
      );
    } catch (error) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, errorMessage(error), { cause: error });
    }

    if (job.state === 'running' || job.state === 'pending') {
      const jobId = job.job_id;
      const onAbort = (): void => {
        void pluginMedia.stopLocal(jobId).catch(() => undefined);
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      try {
        job = await pluginMedia.run(jobId);
      } finally {
        ctx.signal.removeEventListener('abort', onAbort);
      }
    }
    ctx.signal.throwIfAborted();

    if (job.state !== 'succeeded') {
      const detail = job.error?.message ?? `TTS synthesis ended in state ${job.state}.`;
      throw new Error2(ErrorCodes.REQUEST_INVALID, detail);
    }

    const audioArtifact = job.artifacts.find((item) => item.kind === 'audio' && item.complete && item.file_id !== undefined);
    if (audioArtifact?.file_id === undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'TTS synthesis completed without an audio artifact.');
    }

    const mediaFile = await this.media.open(audioArtifact.file_id);
    if (mediaFile === undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, `Synthesized TTS audio file is unavailable: ${audioArtifact.file_id}`);
    }
    const rawBytes = await readMediaFile(mediaFile);
    const rawMime = (audioArtifact.mime || mediaFile.mediaType || mimeTypeFor(mediaFile.name) || 'audio/ogg').toLowerCase();
    const adapted = await this.adaptVoiceAudio({
      bytes: rawBytes,
      mimeType: rawMime,
      name: mediaFile.name || 'voice.ogg',
      sourcePath: mediaFile.path,
      targetChannels,
      ffmpegPath: tts.ffmpegPath ?? 'ffmpeg',
      signal: ctx.signal,
    });

    const hash = createHash('sha256').update(adapted.bytes).digest('hex');
    await this.blobs.put(this.agent.scope('blobs'), hash, adapted.bytes);
    return {
      blobId: `blobref:${this.agent.agentId}:${hash}`,
      path: adapted.path,
      title: adapted.title,
      mimeType: adapted.mimeType,
      size: adapted.bytes.byteLength,
      kind: 'voice',
    };
  }

  private async resolveTtsProvider(pluginMedia: IPluginMediaService, explicitProvider: string | undefined): Promise<string | undefined> {
    const registered = await pluginMedia.providers();
    const ttsProviders = registered.filter((item) => item.definition.kinds.includes('tts'));
    let candidate = explicitProvider;
    if (candidate === undefined) {
      const pluginSettings = optionalService(this.instantiation, IPluginSettingsService);
      if (pluginSettings !== undefined) {
        try {
          const settings = await pluginSettings.forExecution('kiki-media');
          const defaultTts = settings['defaultTtsProvider'];
          if (typeof defaultTts === 'string' && defaultTts.trim().length > 0) {
            candidate = defaultTts.trim();
          }
        } catch {
          candidate = undefined;
        }
      }
    }
    if (candidate === undefined) {
      return ttsProviders.length === 1 ? ttsProviders[0]!.provider : undefined;
    }
    const exact = ttsProviders.find(
      (item) => item.provider === candidate
        || item.definition.id === candidate
        || item.provider === `kiki-media/${candidate}`
        || item.provider === `kiki-media/${candidate}-speech`,
    );
    return exact?.provider ?? candidate;
  }

  private async resolveTtsVoice(
    pluginMedia: IPluginMediaService,
    provider: string | undefined,
    model: string | undefined,
    language: string | undefined,
    explicitVoice: string | undefined,
  ): Promise<string> {
    if (explicitVoice !== undefined) return explicitVoice;
    if (provider !== undefined && typeof pluginMedia.voices === 'function') {
      try {
        const page = await pluginMedia.voices(
          { provider, model, language },
          { workspaceId: this.session.workspaceId, sessionId: this.session.sessionId },
        );
        const firstVoice = page?.voices?.[0]?.id?.trim();
        if (firstVoice !== undefined && firstVoice.length > 0) return firstVoice;
      } catch {
        void 0;
      }
    }
    const fallback = fallbackVoiceForKnownProvider(provider);
    if (fallback !== undefined) return fallback;
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      `TTS voice is required for provider "${provider ?? 'default'}": configure [send_message].tts_voice or pass tts.voice.`,
    );
  }

  private async adaptVoiceAudio(input: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly name: string;
    readonly sourcePath?: string;
    readonly targetChannels: readonly MessageChannelBinding[] | undefined;
    readonly ffmpegPath: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string; readonly title: string; readonly path: string }> {
    const validOggOpus = isOggOpusAudio(input.bytes);
    const voiceChannels = (input.targetChannels ?? []).filter((ch) => ch.capabilities.some((cap) => cap.kind === 'voice'));
    const needsOggOpus = voiceChannels.some((ch) => channelRequiresOggOpus(ch));

    if (validOggOpus) {
      const targetMime = voiceChannels.some((ch) => channelAcceptsVoiceMime(ch, 'audio/ogg')) || voiceChannels.length === 0
        ? 'audio/ogg'
        : voiceChannels.some((ch) => channelAcceptsVoiceMime(ch, 'audio/opus'))
          ? 'audio/opus'
          : 'audio/ogg';
      const base = stripExt(basename(input.name || 'voice')) || 'voice';
      const ext = targetMime === 'audio/opus' ? '.opus' : '.ogg';
      const matchingPath = input.sourcePath !== undefined && (input.sourcePath.toLowerCase().endsWith('.ogg') || input.sourcePath.toLowerCase().endsWith('.opus'))
        ? input.sourcePath
        : `${base}${ext}`;
      return {
        bytes: input.bytes,
        mimeType: targetMime,
        title: `${base}${ext}`,
        path: matchingPath,
      };
    }

    const effectiveInputMime = isOggContainer(input.bytes) ? 'application/ogg' : input.mimeType;
    const alreadySupportedEverywhere = !needsOggOpus && (
      voiceChannels.length === 0 ||
      voiceChannels.every((ch) => channelAcceptsVoiceMime(ch, effectiveInputMime))
    );
    if (alreadySupportedEverywhere && effectiveInputMime !== 'audio/ogg' && effectiveInputMime !== 'audio/opus' && effectiveInputMime !== 'application/ogg') {
      const ext = extForMime(effectiveInputMime) || extname(input.name) || '.mp3';
      const base = stripExt(basename(input.name || 'voice')) || 'voice';
      return {
        bytes: input.bytes,
        mimeType: effectiveInputMime,
        title: `${base}${ext}`,
        path: input.sourcePath ?? `${base}${ext}`,
      };
    }

    const transcoded = await this.transcodeToOggOpus(input.bytes, input.name, input.ffmpegPath, input.signal);
    if (transcoded !== undefined) {
      const targetMime = voiceChannels.length > 0 && !voiceChannels.some((ch) => channelAcceptsVoiceMime(ch, 'audio/ogg')) && voiceChannels.some((ch) => channelAcceptsVoiceMime(ch, 'audio/opus'))
        ? 'audio/opus'
        : 'audio/ogg';
      const base = stripExt(basename(input.name || 'voice')) || 'voice';
      const ext = targetMime === 'audio/opus' ? '.opus' : '.ogg';
      return {
        bytes: transcoded,
        mimeType: targetMime,
        title: `${base}${ext}`,
        path: `${base}${ext}`,
      };
    }

    if (needsOggOpus) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'Target voice channel requires Ogg/Opus audio, and local ffmpeg transcoding was unavailable or failed.',
      );
    }

    const fallbackMime = isOggContainer(input.bytes) ? 'audio/ogg' : input.mimeType;
    const ext = extForMime(fallbackMime) || extname(input.name) || '.bin';
    const base = stripExt(basename(input.name || 'voice')) || 'voice';
    return {
      bytes: input.bytes,
      mimeType: fallbackMime,
      title: `${base}${ext}`,
      path: input.sourcePath ?? `${base}${ext}`,
    };
  }

  private async transcodeToOggOpus(bytes: Uint8Array, originalName: string, ffmpegPath: string, signal: AbortSignal): Promise<Uint8Array | undefined> {
    const hostProcess = optionalService(this.instantiation, IHostProcessService);
    if (hostProcess === undefined) return undefined;
    const scratchRoot = join(this.bootstrap.homeDir, 'cache', 'tts-transcode');
    await this.fs.mkdir(scratchRoot, { recursive: true }).catch(() => undefined);
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const inExt = extname(originalName) || '.bin';
    const inPath = join(scratchRoot, `in-${token}${inExt}`);
    const outPath = join(scratchRoot, `out-${token}.ogg`);
    let cleanupUnconfirmed = false;
    try {
      await this.fs.writeBytes(inPath, bytes);
      const args = [
        '-nostdin',
        '-y',
        '-i',
        inPath,
        '-vn',
        '-c:a',
        'libopus',
        '-b:a',
        '32k',
        '-vbr',
        'on',
        '-application',
        'voip',
        '-f',
        'ogg',
        outPath,
      ];
      const run = await runManagedFfmpeg(ffmpegPath, args, signal, 30_000, hostProcess);
      if (run.code !== 0) return undefined;
      const outBytes = await this.fs.readBytes(outPath).catch(() => undefined);
      if (outBytes === undefined || outBytes.byteLength === 0 || !isOggOpusAudio(outBytes)) return undefined;
      return outBytes;
    } catch (error) {
      cleanupUnconfirmed = isFfmpegCleanupUnconfirmed(error);
      if (signal.aborted || isAbortError(error) || cleanupUnconfirmed) throw error;
      return undefined;
    } finally {
      if (!cleanupUnconfirmed) {
        await this.fs.remove(inPath).catch(() => undefined);
        await this.fs.remove(outPath).catch(() => undefined);
      }
    }
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

function nonEmptyString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function fallbackVoiceForKnownProvider(provider: string | undefined): string | undefined {
  if (provider === undefined) return 'alloy';
  const normalized = provider.toLowerCase();
  if (normalized.includes('minimax')) return 'male-qn-qingse';
  if (normalized.includes('stepfun')) return 'cixingnansheng';
  if (normalized.includes('openai')) return 'alloy';
  return undefined;
}

function channelAcceptsVoiceMime(channel: MessageChannelBinding, mimeType: string): boolean {
  return supportsMessageMedia(channel, { blobId: 'probe', path: 'voice', kind: 'voice', mimeType, size: 1 });
}

function channelRequiresOggOpus(channel: MessageChannelBinding): boolean {
  const hasVoice = channel.capabilities.some((cap) => cap.kind === 'voice');
  if (!hasVoice) return false;
  const acceptsOggOrOpus = channelAcceptsVoiceMime(channel, 'audio/ogg') || channelAcceptsVoiceMime(channel, 'audio/opus');
  const acceptsMp3OrWav = channelAcceptsVoiceMime(channel, 'audio/mpeg') || channelAcceptsVoiceMime(channel, 'audio/wav');
  return acceptsOggOrOpus && !acceptsMp3OrWav;
}

function isOggContainer(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4
    && bytes[0] === 0x4f
    && bytes[1] === 0x67
    && bytes[2] === 0x67
    && bytes[3] === 0x53;
}

const OPUS_HEAD_MAGIC = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64] as const;

export function isOggOpusAudio(bytes: Uint8Array): boolean {
  if (!isOggContainer(bytes) || bytes.byteLength < 36) return false;
  const searchLimit = Math.min(bytes.byteLength - OPUS_HEAD_MAGIC.length, 512);
  for (let offset = 26; offset <= searchLimit; offset++) {
    let matched = true;
    for (let i = 0; i < OPUS_HEAD_MAGIC.length; i++) {
      if (bytes[offset + i] !== OPUS_HEAD_MAGIC[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function stripExt(filename: string): string {
  const ext = extname(filename);
  return ext.length > 0 ? filename.slice(0, -ext.length) : filename;
}

function extForMime(mimeType: string): string | undefined {
  return {
    'audio/ogg': '.ogg',
    'audio/opus': '.opus',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/flac': '.flac',
    'audio/mp4': '.m4a',
    'audio/m4a': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/amr': '.amr',
    'audio/silk': '.silk',
  }[mimeType.toLowerCase()];
}

function isMediaUnsupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.startsWith('media_unsupported:')) return true;
  if (error instanceof Error2 && typeof error.details === 'object' && error.details !== null && (error.details as { reason?: unknown }).reason === 'media_unsupported') {
    return true;
  }
  return false;
}

function extractErrorChannels(error: unknown): readonly string[] {
  if (error instanceof Error2 && typeof error.details === 'object' && error.details !== null) {
    const channels = (error.details as { channels?: unknown }).channels;
    if (Array.isArray(channels) && channels.every((id) => typeof id === 'string')) {
      return channels;
    }
  }
  return ['internal'];
}

function markVoiceUnsupportedOnReceipt(
  receipt: SendMessageReceipt,
  voiceAttachment: MessageAttachmentReceipt,
  mode: SendMessageVoiceMode,
): SendMessageReceipt {
  const channels: MessageChannelReceipt[] | undefined = receipt.channels?.map((ch) => {
    const unsupported = [...new Set([...(ch.unsupported ?? []), 'voice'])];
    const status = ch.status === 'delivered' ? (mode === 'only' ? 'unsupported' : 'partial') : ch.status;
    return {
      ...ch,
      status,
      unsupported,
    };
  });
  const attachments = [...(receipt.attachments ?? []), voiceAttachment];
  return {
    ...receipt,
    attachments,
    channels,
  };
}

function markTargetVoiceUnsupportedOnReceipt(
  receipt: SendMessageReceipt,
  defaultChannelId: string,
  mode: SendMessageVoiceMode,
): ExtendedReceipt {
  const channels: MessageChannelReceipt[] = receipt.channels !== undefined && receipt.channels.length > 0
    ? receipt.channels.map((ch) => ({
        ...ch,
        status: ch.status === 'delivered' ? 'partial' : ch.status,
        unsupported: [...new Set([...(ch.unsupported ?? []), 'voice'])],
      }))
    : [{
        channelId: defaultChannelId,
        status: receipt.delivery === 'undeliverable' ? 'unsupported' : 'partial',
        unsupported: ['voice'],
      }];
  return {
    ...receipt,
    channels,
    ...(mode === 'only' ? { voiceOnly: true } : {}),
  };
}

const FFMPEG_STDOUT_CAP = 64 * 1024;
const FFMPEG_STDERR_CAP = 8 * 1024;

export interface FfmpegRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: string;
}

export class FfmpegTranscodeCleanupError extends Error {
  readonly cleanupUnconfirmed = true;
}

export function isFfmpegCleanupUnconfirmed(error: unknown): boolean {
  return error instanceof FfmpegTranscodeCleanupError || (
    typeof error === 'object' &&
    error !== null &&
    'cleanupUnconfirmed' in error &&
    (error as { cleanupUnconfirmed?: unknown }).cleanupUnconfirmed === true
  );
}

export async function runManagedFfmpeg(
  binary: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
  host: Pick<IHostProcessService, 'spawn'>,
): Promise<FfmpegRunResult> {
  if (signal.aborted) {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    return Promise.reject(abortErr);
  }
  let proc: IHostProcess;
  try {
    proc = await host.spawn(binary, [...args], {
      windowsHide: true,
      ownedProcessTree: true,
      ownedProcessLifetime: 'process',
    });
  } catch (error) {
    if (spawnErrno(error) === 'ENOENT') {
      return { code: -1, stdout: '', stderr: error instanceof Error ? error.message : 'ENOENT', spawnError: 'ENOENT' };
    }
    throw error;
  }

  let stdout = '';
  let stderr = '';
  const onStdout = (chunk: Uint8Array | string): void => {
    if (stdout.length >= FFMPEG_STDOUT_CAP) return;
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    stdout += text.slice(0, FFMPEG_STDOUT_CAP - stdout.length);
  };
  const onStderr = (chunk: Uint8Array | string): void => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    stderr = `${stderr}${text}`.slice(-FFMPEG_STDERR_CAP);
  };
  proc.stdout.on('data', onStdout);
  proc.stderr.on('data', onStderr);

  let preferred: Error | undefined;
  let stopping: Promise<void> | undefined;
  let settled = false;
  let stopRequested = false;
  let resolveFinish: (result: FfmpegRunResult) => void = () => {};
  let rejectFinish: (error: Error) => void = () => {};
  const done = new Promise<FfmpegRunResult>((resolve, reject) => {
    resolveFinish = resolve;
    rejectFinish = reject;
  });
  const finish = (error?: Error, result?: FfmpegRunResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    proc.stdout.off('data', onStdout);
    proc.stderr.off('data', onStderr);
    if (error !== undefined) rejectFinish(error);
    else resolveFinish(result!);
  };
  const afterStop = (result?: FfmpegRunResult): void => {
    void stopping!.then(
      () => { finish(preferred, preferred === undefined ? result : undefined); },
      (error: unknown) => {
        finish(
          error instanceof FfmpegTranscodeCleanupError
            ? error
            : new FfmpegTranscodeCleanupError('Audio transcode process cleanup was not confirmed.', { cause: error }),
        );
      },
    );
  };
  const stop = (error: Error): void => {
    preferred ??= error;
    stopRequested = true;
    if (stopping === undefined) stopping = killOwnedTree(proc);
    afterStop();
  };
  const onAbort = (): void => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    stop(abortErr);
  };
  const timer = setTimeout(() => {
    stop(new Error('Audio transcode timed out'));
  }, timeoutMs);
  signal.addEventListener('abort', onAbort, { once: true });
  void proc.wait().then(
    (code) => {
      if (settled || stopping !== undefined) return;
      stopping = releaseAfterExit(proc, () => stopRequested, () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      });
      afterStop({ code, stdout, stderr });
    },
    (error: unknown) => {
      if (settled || stopping !== undefined) return;
      stop(error instanceof Error ? error : new Error(String(error)));
    },
  );
  if (signal.aborted) onAbort();
  return done;
}

async function killOwnedTree(proc: IHostProcess): Promise<void> {
  await proc.kill();
  await Promise.resolve(proc.dispose());
}

async function releaseAfterExit(proc: IHostProcess, stopRequested: () => boolean, beginRelease: () => void): Promise<void> {
  await Promise.resolve();
  if (stopRequested()) await proc.kill();
  beginRelease();
  await Promise.resolve(proc.dispose());
}

function spawnErrno(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const details = 'details' in error ? (error as { details?: { errno?: unknown } }).details : undefined;
  if (typeof details?.errno === 'string') return details.errno;
  const cause = 'cause' in error ? (error as { cause?: unknown }).cause : undefined;
  if (typeof cause === 'object' && cause !== null && 'code' in cause && typeof (cause as { code?: unknown }).code === 'string') {
    return (cause as { code: string }).code;
  }
  return 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function hasExplicitChannelTargets(input: { readonly channel?: unknown; readonly channels?: unknown }): boolean {
  if (typeof input.channel === 'string' && input.channel.trim().length > 0) return true;
  return Array.isArray(input.channels) && input.channels.length > 0;
}

function confirmedChannelDelivery(
  channels: readonly { readonly status?: unknown }[] | undefined,
  explicitTargets: boolean,
  voiceOnly: boolean,
): boolean {
  if (channels === undefined) return true;
  if (channels.length === 0) return false;
  if (channels.some((channel) => channel.status === 'unknown')) return false;
  if (explicitTargets) return channels.every((channel) => channel.status === 'delivered');
  if (voiceOnly) return channels.some((channel) => channel.status === 'delivered');
  return channels.some((channel) => channel.status === 'delivered' || channel.status === 'partial');
}

function confirmedUserDelivery(
  receipt: ExtendedReceipt,
  input: { readonly channel?: unknown; readonly channels?: unknown },
): boolean {
  return receipt.deliveredTo.includes('user') &&
    (receipt.delivery === undefined || receipt.delivery === 'delivered') &&
    confirmedChannelDelivery(receipt.channels, hasExplicitChannelTargets(input), receipt.voiceOnly === true);
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

function toWireReceipt(receipt: ExtendedReceipt): Record<string, unknown> {
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
    ...(receipt.voiceOnly === true ? { voice_only: true } : {}),
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
