import { ErrorCodes } from '@moonshot-ai/kimi-code-sdk';

import { currentKimiProfile } from '#/utils/region';

export const PRODUCT_NAME = 'Kimi Code';
export const CLI_COMMAND_NAME = 'kimi';
export const PROCESS_NAME = 'kimi-code';

// Used in telemetry app names and HTTP User-Agent headers.
export const CLI_USER_AGENT_PRODUCT = 'kimi-code-cli';
export const CLI_UI_MODE = 'shell';
// Telemetry ui_mode for the `kimi web` host. Same product
// as the CLI (CLI_USER_AGENT_PRODUCT); the surface is distinguished by ui_mode.
export const WEB_UI_MODE = 'web';
// User-Agent suffix for the `kimi web` host: its requests go out as
// `kimi-code-cli/<version> (web)` so upstream can tell web-UI traffic
// apart from direct CLI runs without changing the product token or platform.
export const WEB_USER_AGENT_SUFFIX = 'web';

// Give telemetry a short flush window without making CLI exit feel stuck.
export const CLI_SHUTDOWN_TIMEOUT_MS = 3000;

// Upper bound on headless (`kimi -p`) shutdown. A wedged cleanup step (e.g. a
// SessionEnd hook, an MCP shutdown, or a connection blackholed by a restrictive
// firewall) must not keep a completed run alive indefinitely — once this elapses
// we stop waiting on cleanup and let the run return.
export const PROMPT_CLEANUP_TIMEOUT_MS = 8000;

// Grace after a headless run has fully completed (turn done, cleanup attempted)
// before force-exiting. `kimi -p` otherwise relies on the event loop draining to
// exit; a stray ref'd handle (socket/timer/child) left over from the run would
// wedge it. The guard timer is unref'd, so a healthy run still exits naturally
// well before this fires.
export const HEADLESS_FORCE_EXIT_GRACE_MS = 2000;

// Max time to wait for buffered stdout/stderr to flush before arming the
// force-exit fallback. A slow/piped consumer's still-draining stdio is a
// legitimate ref'd handle — flushing first prevents the fallback from
// truncating completed output. Bounded so a permanently-stuck consumer can't
// re-introduce the hang.
export const HEADLESS_STDIO_DRAIN_TIMEOUT_MS = 10000;

// Published npm package name; this can differ from the executable command.
export const NPM_PACKAGE_NAME = '@moonshot-ai/kimi-code';

// App-owned data paths. SDK/core runtime config is intentionally not routed here.
export const KIMI_CODE_HOME_ENV = 'KIMI_CODE_HOME';
export const KIKI_DESKTOP_BUNDLED_ENV = 'KIKI_DESKTOP_BUNDLED';
export function isKikiDesktopBundled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[KIKI_DESKTOP_BUNDLED_ENV] === '1';
}
export const KIMI_CODE_DATA_DIR_NAME = '.kimi-code';
export const KIMI_CODE_LOG_DIR_NAME = 'logs';
export const KIMI_CODE_CACHE_DIR_NAME = 'cache';
export const KIMI_CODE_UPDATE_DIR_NAME = 'updates';
export const KIMI_CODE_BIN_DIR_NAME = 'bin';
export const KIMI_CODE_PLUGIN_UPDATE_NOTICE_STATE_FILE_NAME = 'plugin-notices.json';
export const KIMI_CODE_INPUT_HISTORY_DIR_NAME = 'user-history';
export const KIMI_CODE_BANNER_DIR_NAME = 'banner';
export const KIMI_CODE_BANNER_STATE_FILE_NAME = 'state.json';

// Managed Kimi auth provider key shared with OAuth/SDK config.
export const DEFAULT_OAUTH_PROVIDER_NAME = 'managed:kimi-code';

// SDK/core error code that tells the TUI to show a login-required startup
// notice. Derived from sdk's ErrorCodes so a future rename in core
// auto-propagates instead of silently breaking the startup recovery path.
export const OAUTH_LOGIN_REQUIRED_CODE = ErrorCodes.AUTH_LOGIN_REQUIRED;

// Region-aware asset root for managed tool assets such as fd.
export function kimiCodeCdnBase(): string {
  return currentKimiProfile().cdnBase;
}
// The marketplace env override name lives in the shared agent-core-v2 plugin
// domain (kap-server consumes it from there). Deep-path import: this module is
// evaluated on every CLI invocation, so it must not pull in the engine root.
export { KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV } from '@moonshot-ai/agent-core-v2/app/plugin/marketplace';
// Official plugins whose usage bills against the user's plan quota. Installing
// one of these shows a quota note after the install result.
export const QUOTA_CONSUMING_PLUGIN_IDS: readonly string[] = ['kimi-datasource'];
