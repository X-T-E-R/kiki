import { Error2, type Error2Options } from '#/_base/errors/errors';

export class PluginStateError extends Error2 {
  constructor(code: 'plugin_state.invalid_fact' | 'plugin_state.replay_required' | 'plugin_state.required_unresolved', message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'PluginStateError';
  }
}
