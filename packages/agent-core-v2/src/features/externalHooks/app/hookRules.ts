import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { HookRulesSnapshot } from '../internal/rules';

export interface IHookRulesRegistry {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<void>;
  snapshot(): HookRulesSnapshot;
  disabled(): readonly string[];
  reload(): Promise<void>;
}

export const IHookRulesRegistry = createDecorator<IHookRulesRegistry>('hookRulesRegistry');
