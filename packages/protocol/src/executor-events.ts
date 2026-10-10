export type NormalizedExecutorContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string; readonly uri?: string }
  | { readonly type: 'audio'; readonly mimeType: string; readonly data: string }
  | {
      readonly type: 'resource_link';
      readonly uri: string;
      readonly name?: string;
      readonly mimeType?: string;
      readonly size?: number;
      readonly description?: string;
      readonly title?: string;
    }
  | {
      readonly type: 'resource';
      readonly resource:
        | { readonly type: 'text'; readonly uri: string; readonly text: string; readonly mimeType?: string }
        | { readonly type: 'blob'; readonly uri: string; readonly blob: string; readonly mimeType?: string };
    }
  | { readonly type: 'opaque'; readonly contentType: string; readonly payload?: unknown };

export type NormalizedExecutorEvent =
  | {
      readonly type: 'message.delta';
      readonly role: 'user' | 'assistant';
      readonly messageId?: string;
      readonly content: NormalizedExecutorContent;
    }
  | {
      readonly type: 'thought.delta';
      readonly messageId?: string;
      readonly content: NormalizedExecutorContent;
    }
  | {
      readonly type: 'tool.call';
      readonly toolCallId: string;
      readonly title: string;
      readonly name?: string;
      readonly kind?: string;
      readonly status?: string;
      readonly rawInput?: unknown;
      readonly rawOutput?: unknown;
      readonly content?: readonly unknown[];
      readonly locations?: readonly unknown[];
    }
  | {
      readonly type: 'tool.update';
      readonly toolCallId: string;
      readonly title?: string;
      readonly name?: string;
      readonly kind?: string;
      readonly status?: string;
      readonly rawInput?: unknown;
      readonly rawOutput?: unknown;
      /** Stable reason for a failed call, set when the engine's refusal has a known meaning. */
      readonly errorCode?: string;
      readonly content?: readonly unknown[];
      readonly locations?: readonly unknown[];
    }
  | { readonly type: 'plan.update'; readonly plan: unknown; readonly unstable: boolean }
  | { readonly type: 'plan.remove'; readonly planId?: string; readonly unstable: true }
  | { readonly type: 'commands.update'; readonly commands: readonly unknown[] }
  | { readonly type: 'mode.update'; readonly currentModeId: string }
  | { readonly type: 'config.update'; readonly configOptions: readonly unknown[] }
  | { readonly type: 'session.info'; readonly title?: string; readonly meta?: unknown }
  | { readonly type: 'turn.diff'; readonly diff: string }
  | { readonly type: 'context.compacted'; readonly threadId: string }
  | {
      readonly type: 'usage';
      readonly used: number;
      readonly size: number;
      readonly cost?: unknown;
    }
  | { readonly type: 'unknown'; readonly updateType: string };
