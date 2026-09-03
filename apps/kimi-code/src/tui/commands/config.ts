import { DEFAULT_TUI_CONFIG, type TuiConfig } from '../config';
import type { TUIState } from '../tui-state';

export function currentTuiConfig(host: { readonly state: Pick<TUIState, 'appState'> }): TuiConfig {
  return {
    theme: host.state.appState.theme,
    editorCommand: host.state.appState.editorCommand,
    disablePasteBurst: host.state.appState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
    renderLatex: host.state.appState.renderLatex ?? DEFAULT_TUI_CONFIG.renderLatex ?? true,
    cacheExpiryHint: host.state.appState.cacheExpiryHint ?? DEFAULT_TUI_CONFIG.cacheExpiryHint,
    notifications: host.state.appState.notifications,
    statusLine: host.state.appState.statusLine ?? DEFAULT_TUI_CONFIG.statusLine,
  };
}
