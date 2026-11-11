import { scope, type Context } from '@kiki/cordis-runtime';
import { createUserMessage, type UserMessage } from './vendor/llm/src/message';
import type { ContentBlock } from './vendor/llm/src/types';

const { scopeTarget } = scope;
import type { PreStepDecision } from './dshAgentSessionSurface';
import type { DshAttachmentsPort } from './hostServicesBridge';
import type { DshAgentIdentityRegistry } from './initiatorAls';
import type { DshSystemPromptBridge } from './systemPromptBridge';
import type { DshToolResult, ToolRuntimeBridge } from './toolsBridge';
import type { DshLiveAgentFacade } from './index';

export interface HostContentPartAttachment {
  readonly fileId: string;
  readonly mimeType: string;
  readonly size: number;
  readonly name?: string;
}

export interface HostResourceLinkMetadata {
  readonly uri: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly description?: string;
}

export type HostContentPart =
  | {
      readonly type: 'text';
      readonly text: string;
      readonly attachment?: HostContentPartAttachment;
      readonly resourceLink?: HostResourceLinkMetadata;
    }
  | {
      readonly type: 'image_url';
      readonly imageUrl: {
        readonly url: string;
        readonly id?: string;
        readonly name?: string;
        readonly mimeType?: string;
        readonly size?: number;
        readonly attachment?: HostContentPartAttachment;
      };
    };

export interface HostExecutableToolResult {
  readonly output: string | HostContentPart[];
  readonly isError?: boolean;
  readonly stopTurn?: boolean;
}

export interface HostContextMessageLike {
  readonly role?: string;
  readonly content?: string | readonly { readonly type: string; readonly text?: string }[];
  readonly origin?: { readonly kind?: string; readonly variant?: string };
}

export interface HostLoopBoundarySnapshotLike {
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: number;
  readonly step: number;
  readonly firstStepOfTurn: boolean;
  readonly modelAlias: string;
  readonly newMessagesSinceLastStep?: readonly HostContextMessageLike[];
}

export type HostLoopBoundaryProposalLike =
  | { readonly action: 'continue_normal' }
  | { readonly action: 'request_turn_stop'; readonly reason: string };

export type HostToolPreExecuteProposalLike =
  | { readonly decision: 'pass' }
  | { readonly decision: 'require_ask'; readonly promptReason: string }
  | { readonly decision: 'veto'; readonly errorOutput: string };

export interface HostApprovedToolExecutionWrapperContextLike {
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: number;
  readonly step?: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly approvedArgs: unknown;
  readonly declaredTimeoutMs?: number | null;
  readonly execContext: {
    readonly signal: AbortSignal;
  };
}

export interface HostToolPostExecuteContextLike {
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: HostExecutableToolResult;
  readonly wasDenied?: boolean;
  readonly signal: AbortSignal;
}

export interface HostToolPostExecuteProposalLike {
  readonly shapedResult?: HostExecutableToolResult;
  readonly preserveOriginalInAudit?: boolean;
  readonly oneOffSystemReminder?: {
    readonly text: string;
    readonly variant: string;
  };
}

export interface HostDisposableLike {
  dispose(): void;
}

export interface HostExtensionPortRegistryLike {
  registerPromptSection(contribution: {
    readonly pluginId: string;
    readonly sectionId: string;
    readonly order: number;
    readonly suppressRuntimeContext?: boolean;
    render(context: {
      readonly sessionId: string;
      readonly agentId: string;
      readonly profileName?: string;
      readonly modelAlias?: string;
      readonly workspaceRoot?: string;
    }): string | undefined | Promise<string | undefined>;
  }): HostDisposableLike;

  registerStepContextReminder(contribution: {
    readonly pluginId: string;
    readonly reminderKey: string;
    collect(context: {
      readonly sessionId: string;
      readonly agentId: string;
      readonly turnId: number;
      readonly step: number;
      readonly isNewTurn: boolean;
      readonly signal: AbortSignal;
    }): string | readonly HostContentPart[] | undefined | Promise<string | readonly HostContentPart[] | undefined>;
  }): HostDisposableLike;

  registerPreStepPolicy(
    pluginId: string,
    handler: (
      snapshot: HostLoopBoundarySnapshotLike,
      signal: AbortSignal,
    ) => HostLoopBoundaryProposalLike | Promise<HostLoopBoundaryProposalLike>,
  ): HostDisposableLike;

  registerToolPreExecutePolicy(
    pluginId: string,
    handler: (context: {
      readonly sessionId: string;
      readonly agentId: string;
      readonly turnId: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
      readonly signal: AbortSignal;
    }) => HostToolPreExecuteProposalLike | Promise<HostToolPreExecuteProposalLike>,
  ): HostDisposableLike;

  registerApprovedToolExecutionWrapper(
    pluginId: string,
    wrapper: (
      context: HostApprovedToolExecutionWrapperContextLike,
      next: (overrideSignal?: AbortSignal) => Promise<HostExecutableToolResult>,
    ) => Promise<HostExecutableToolResult>,
    options?: { readonly order?: number },
  ): HostDisposableLike;

  registerToolPostExecutePolicy(
    pluginId: string,
    handler: (
      context: HostToolPostExecuteContextLike,
    ) => HostToolPostExecuteProposalLike | undefined | Promise<HostToolPostExecuteProposalLike | undefined>,
  ): HostDisposableLike;
}

export function dshBlocksToHostOutput(
  blocks: readonly ContentBlock[],
  attachments?: DshAttachmentsPort,
): string | HostContentPart[] {
  if (blocks.length === 1 && blocks[0]?.type === 'text') {
    return blocks[0].text;
  }
  const parts: HostContentPart[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      const b64 = attachments?.readBase64?.(block.attachment.attachmentId);
      const url = b64 === undefined
        ? `attachment://${block.attachment.attachmentId}`
        : `data:${block.attachment.mediaType};base64,${b64}`;
      parts.push({
        type: 'image_url',
        imageUrl: {
          url,
          id: block.attachment.attachmentId,
          mimeType: block.attachment.mediaType,
          size: block.attachment.bytes,
          ...(block.attachment.name === undefined ? {} : { name: block.attachment.name }),
          attachment: {
            fileId: block.attachment.attachmentId,
            mimeType: block.attachment.mediaType,
            size: block.attachment.bytes,
            ...(block.attachment.name === undefined ? {} : { name: block.attachment.name }),
          },
        },
      });
      continue;
    }
    if (block.type === 'resource_link') {
      const label = block.name ? `Resource link: ${block.name} (${block.uri})` : `Resource link: ${block.uri}`;
      parts.push({
        type: 'text',
        text: label,
        resourceLink: {
          uri: block.uri,
          ...(block.name === undefined ? {} : { name: block.name }),
          ...(block.mimeType === undefined ? {} : { mimeType: block.mimeType }),
          ...(block.description === undefined ? {} : { description: block.description }),
        },
      });
      continue;
    }
    if (block.type === 'file') {
      parts.push({
        type: 'text',
        text: `[File: ${block.attachment.name} (${block.attachment.bytes} bytes)]`,
        attachment: {
          fileId: block.attachment.attachmentId,
          mimeType: 'application/octet-stream',
          size: block.attachment.bytes,
          name: block.attachment.name,
        },
      });
    }
  }
  return parts;
}

export function hostResultToDshResult(hostResult: HostExecutableToolResult, wasDenied = false): DshToolResult {
  const blocks: ContentBlock[] = typeof hostResult.output === 'string'
    ? [{ type: 'text', text: hostResult.output }]
    : hostResult.output.map((part): ContentBlock => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        return {
          type: 'text',
          text: `[image_url:${part.imageUrl.id ?? part.imageUrl.url.slice(0, 32)}]`,
        };
      });
  if (wasDenied || hostResult.isError === true) {
    const msg = typeof hostResult.output === 'string'
      ? hostResult.output
      : blocks.map(b => (b.type === 'text' ? b.text : '')).join('\n');
    return {
      isError: true,
      content: blocks,
      error: {
        message: msg,
        info: {
          name: wasDenied ? 'ToolDeniedError' : 'HostToolError',
          code: wasDenied ? 'TOOL_DENIED' : 'HOST_TOOL_ERROR',
        },
      },
    };
  }
  return {
    isError: false,
    value: typeof hostResult.output === 'string' ? hostResult.output : null,
    content: blocks,
    ...(hostResult.stopTurn === true ? { concludesTurn: true as const } : {}),
  };
}

function hostMessagesToDshUserMessages(messages: readonly HostContextMessageLike[] | undefined): UserMessage[] {
  if (messages === undefined || messages.length === 0) return [];
  const result: UserMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== undefined && msg.role !== 'user') continue;
    const text = typeof msg.content === 'string'
      ? msg.content
      : (msg.content ?? [])
          .filter(part => part.type === 'text' && typeof part.text === 'string')
          .map(part => part.text!)
          .join('\n');
    const originKind = msg.origin?.kind;
    const isRealUser = originKind === undefined || originKind === 'user';
    const source = isRealUser
      ? ({ kind: 'user' } as const)
      : ({ kind: (msg.origin?.variant ?? originKind) as any });
    result.push(
      createUserMessage({
        content: [{ type: 'text', text }],
        source,
      }),
    );
  }
  return result;
}

/**
 * Bind a mounted `dsh-compat` Cordis plane onto Kiki's E5, E7, and E8 extension port slots.
 */
export function bindDshCompatToExtensionSlots(options: {
  readonly pluginId?: string;
  readonly registry: HostExtensionPortRegistryLike;
  readonly ctx: Context;
  readonly initiators: DshAgentIdentityRegistry;
  readonly tools: ToolRuntimeBridge;
  readonly systemPrompt: DshSystemPromptBridge;
  readonly attachments?: () => DshAttachmentsPort | undefined;
  readonly resolveAgent: (sessionId: string, agentId: string) => DshLiveAgentFacade;
}): () => void {
  const pluginId = options.pluginId ?? 'dsh-compat';
  const disposables: HostDisposableLike[] = [
    options.registry.registerPromptSection({
      pluginId,
      sectionId: `${pluginId}:sections`,
      order: 500,
      async render(context) {
        const agent = options.resolveAgent(context.sessionId, context.agentId);
        const rendered = await options.systemPrompt.render({ agent });
        return rendered.promptText.length > 0 ? rendered.promptText : undefined;
      },
    }),
    options.registry.registerStepContextReminder({
      pluginId,
      reminderKey: `${pluginId}:contexts`,
      async collect(context) {
        const agent = options.resolveAgent(context.sessionId, context.agentId);
        const rendered = await options.systemPrompt.render({ agent, signal: context.signal });
        if (rendered.contexts.length === 0) return undefined;
        return rendered.contexts.map(entry => entry.text).join('\n\n');
      },
    }),
    options.registry.registerPreStepPolicy(pluginId, async (snapshot, signal) => {
      const agent = options.resolveAgent(snapshot.sessionId, snapshot.agentId);
      const messages = hostMessagesToDshUserMessages(snapshot.newMessagesSinceLastStep);
      const carrier = scopeTarget(agent, agent.scopeKey);
      const decision = await options.initiators.withInitiator(agent, () =>
        (options.ctx as unknown as {
          waterfall(
            thisArg: object,
            name: string,
            payload: object,
            terminal: () => Promise<PreStepDecision>,
          ): Promise<PreStepDecision>;
        }).waterfall(
          carrier,
          'agent/pre-step',
          {
            agent,
            messages,
            turn: snapshot.turnId,
            step: snapshot.step,
            signal,
          },
          async () => ({ kind: 'enter', messages }),
        ),
      );
      if (decision.kind === 'reject') {
        return { action: 'request_turn_stop', reason: 'DSH agent/pre-step rejected step entry' };
      }
      return { action: 'continue_normal' };
    }),
    options.registry.registerToolPreExecutePolicy(pluginId, async (context) => {
      const agent = options.resolveAgent(context.sessionId, context.agentId);
      const gate = await options.tools.runPreExecuteGate({
        callId: context.toolCallId,
        name: context.toolName,
        arguments: context.args,
        agent,
        signal: context.signal,
      });
      if (gate.action === 'allow') return { decision: 'pass' };
      if (gate.action === 'ask') {
        return {
          decision: 'require_ask',
          promptReason: gate.prompt ?? `DSH guard requested confirmation for "${context.toolName}"`,
        };
      }
      if (gate.action === 'cancel') {
        return {
          decision: 'veto',
          errorOutput: gate.reason ?? 'Tool execution cancelled by DSH pre-execute guard',
        };
      }
      return {
        decision: 'veto',
        errorOutput: gate.reason,
      };
    }),
    options.registry.registerApprovedToolExecutionWrapper(pluginId, async (context, next) => {
      const agent = options.resolveAgent(context.sessionId, context.agentId);
      let downstreamHostResult: HostExecutableToolResult | undefined;
      const wrapped = await options.tools.runAroundExecute(
        {
          callId: context.toolCallId,
          name: context.toolName,
          arguments: context.approvedArgs,
          agent,
          signal: context.execContext.signal,
        },
        async (effectiveSignal) => {
          const hostRes = await next(effectiveSignal);
          downstreamHostResult = hostRes;
          return hostResultToDshResult(hostRes, false);
        },
      );
      if (
        !wrapped.isError
        && downstreamHostResult !== undefined
        && downstreamHostResult.isError !== true
      ) {
        return downstreamHostResult;
      }
      const output = dshBlocksToHostOutput(wrapped.content, options.attachments?.());
      if (wrapped.isError) {
        return {
          isError: true,
          output,
        };
      }
      return {
        output,
        ...(wrapped.concludesTurn === true ? { stopTurn: true } : {}),
      };
    }),
    options.registry.registerToolPostExecutePolicy(pluginId, async (context) => {
      const agent = options.resolveAgent(context.sessionId, context.agentId);
      const initialDshResult = hostResultToDshResult(context.result, context.wasDenied === true);
      const { result: postResult, decision } = await options.tools.runPostExecute({
        callId: context.toolCallId,
        name: context.toolName,
        arguments: context.args,
        agent,
        result: initialDshResult,
        signal: context.signal,
      });
      const reminders = decision.additionalContexts ?? [];
      const oneOffSystemReminder = reminders.length === 0
        ? undefined
        : {
            text: reminders.map(item => item.text).join('\n\n'),
            variant: reminders[0]?.variant ?? 'dsh-post-tool-reminder',
          };
      const contentReplaced = postResult.content !== initialDshResult.content
        || postResult.isError !== initialDshResult.isError;
      if (!contentReplaced && oneOffSystemReminder === undefined) {
        return undefined;
      }
      const shapedResult: HostExecutableToolResult | undefined = contentReplaced
        ? {
            output: dshBlocksToHostOutput(postResult.content, options.attachments?.()),
            ...(postResult.isError ? { isError: true } : {}),
          }
        : undefined;
      return {
        ...(shapedResult === undefined ? {} : { shapedResult, preserveOriginalInAudit: true }),
        ...(oneOffSystemReminder === undefined ? {} : { oneOffSystemReminder }),
      };
    }),
  ];

  return () => {
    for (const disposable of disposables.toReversed()) {
      disposable.dispose();
    }
  };
}
