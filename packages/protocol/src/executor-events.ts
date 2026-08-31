export type NormalizedExecutorContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string }
  | { readonly type: 'resource_link'; readonly uri: string; readonly name?: string }
  | { readonly type: 'opaque'; readonly contentType: string };

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
      readonly kind?: string;
      readonly status?: string;
      readonly rawInput?: unknown;
      readonly content?: readonly unknown[];
      readonly locations?: readonly unknown[];
    }
  | {
      readonly type: 'tool.update';
      readonly toolCallId: string;
      readonly title?: string;
      readonly kind?: string;
      readonly status?: string;
      readonly rawInput?: unknown;
      readonly rawOutput?: unknown;
      readonly content?: readonly unknown[];
      readonly locations?: readonly unknown[];
    }
  | { readonly type: 'plan.update'; readonly plan: unknown; readonly unstable: boolean }
  | { readonly type: 'plan.remove'; readonly planId?: string; readonly unstable: true }
  | { readonly type: 'commands.update'; readonly commands: readonly unknown[] }
  | { readonly type: 'mode.update'; readonly currentModeId: string }
  | { readonly type: 'config.update'; readonly configOptions: readonly unknown[] }
  | { readonly type: 'session.info'; readonly title?: string; readonly meta?: unknown }
  | {
      readonly type: 'usage';
      readonly used: number;
      readonly size: number;
      readonly cost?: unknown;
    }
  | { readonly type: 'unknown'; readonly updateType: string };
