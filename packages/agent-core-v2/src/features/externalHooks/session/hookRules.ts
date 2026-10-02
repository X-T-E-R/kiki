import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { Runtime } from '#/runtime/runtime';
import type { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import type { HookEvent, HookRulesSnapshot } from '../internal/rules';

export interface ISessionHookWorkspace {
  readonly _serviceBrand: undefined;
  readonly runtime: Runtime;
  readonly root: string;
  readonly trust: IWorkspaceTrust;
}
export const ISessionHookWorkspace = createDecorator<ISessionHookWorkspace>('sessionHookWorkspace');

export interface IHookRulesSession {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<void>;
  readonly onDidObserve: Event<HookEvent & { readonly hookId: string }>;
  snapshot(): HookRulesSnapshot;
  reload(): Promise<void>;
  observe(event: HookEvent, hookId: string): void;
}
export const IHookRulesSession = createDecorator<IHookRulesSession>('hookRulesSession');
