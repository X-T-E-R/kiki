import { execFileSync, spawnSync } from 'node:child_process';

import {
  createKimiHarness,
  flushDiagnosticLogsSync,
  log,
  type KimiHarnessOptions,
} from '@moonshot-ai/kimi-code-sdk';

import { CLI_UI_MODE } from '#/constant/app';
import type { TuiConfig } from '#/tui/config';
import { loadTuiConfig, TuiConfigParseError } from '#/tui/config';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { DaemonTUI } from '#/tui/daemon/daemon-tui';
import { discoverDaemon, ensureDaemon, resolveDaemonHome } from '#/tui/daemon/discovery';
import { runWorkspaceTrustGate } from '#/tui/daemon/workspace-trust';
import { KimiTUI } from '#/tui/index';
import { startupTrace } from '#/utils/startup-trace';
import { currentTheme, getColorPalette } from '#/tui/theme';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import { restoreTerminalModes } from '#/utils/terminal-restore';
import { resolveCommandPath } from '#/utils/process/resolve-command';

import type { CLIOptions } from './options';
import { resolveAgentProfileSelection } from './agent-selection';
import { createKimiCodeHostIdentity } from './version';

export async function runShell(opts: CLIOptions, version: string): Promise<void> {
  let tuiConfig: TuiConfig;
  let configWarning: string | undefined;
  try {
    tuiConfig = await loadTuiConfig();
  } catch (error) {
    if (!(error instanceof TuiConfigParseError)) throw error;
    tuiConfig = error.fallback;
    configWarning = error.message;
  }

  // Initialise the global Theme singleton before pi-tui grabs stdin.
  const palette = await getColorPalette(tuiConfig.theme);
  currentTheme.setPalette(palette);

  const workDir = process.cwd();
  const harnessOptions: KimiHarnessOptions = {
    identity: createKimiCodeHostIdentity(version),
    skillDirs: opts.skillsDirs,
  };
  const harness = createKimiHarness(harnessOptions);
  startupTrace('harness:created');
  log.info('kimi-code starting', {
    version,
    uiMode: CLI_UI_MODE,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    workDir,
  });

  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  startupTrace('config:loaded');
  const useDaemonTui = isTuiDaemonEnabled(config.experimental);
  let tui: KimiTUI | DaemonTUI;
  let closeOnStartFailure: () => Promise<void>;
  if (useDaemonTui) {
    await harness.close();
    const homeDir = resolveDaemonHome();
    if (!(await runWorkspaceTrustGate({ homeDir, workDir }))) return;
    const agentProfile = await resolveAgentProfileSelection(opts, workDir);
    const connection =
      (await discoverDaemon(homeDir, workDir)) ??
      (await ensureDaemon({ homeDir, workspacePath: workDir }));
    startupTrace('daemon:connected');
    const daemonTui = new DaemonTUI(connection, {
      cliOptions: opts,
      agentProfile,
      additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
      tuiConfig,
      version,
      workDir,
      startupNotice: daemonStartupNotice(configWarning),
    });
    tui = daemonTui;
    closeOnStartFailure = () => daemonTui.close();
  } else {
    // Resolve --agent/--agent-file once for the startup session; validateOptions
    // has already rejected them alongside --session/--continue.
    const agentProfile = await resolveAgentProfileSelection(opts, workDir);
    tui = new KimiTUI(harness, {
      cliOptions: opts,
      agentProfile,
      additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
      tuiConfig,
      version,
      workDir,
      startupNotice: configWarning,
      // Constant since the v1 engine was removed. The TUI still branches on it in
      // ~20 places; those branches are dead and get deleted with the flag itself.
      engineV2: true,
    });
    closeOnStartFailure = () => harness.close();
  }

  let savedStty: string | undefined;
  // stty runs before tui.start() reaches the workspace trust gate, so it must
  // never be resolved by name through PATH: a `.` or empty PATH segment would
  // let an untrusted checkout plant an `stty` executable and run it pre-trust.
  // resolveCommandPath returns an absolute path and refuses hits inside the
  // cwd; when it cannot resolve stty, skip the save/restore entirely — it is
  // best-effort terminal hygiene, not required for startup.
  // stty is also POSIX-only, so skip it on Windows instead of relying on the
  // catch below.
  const sttyPath = process.platform === 'win32' ? undefined : resolveCommandPath('stty');
  if (sttyPath !== undefined) {
    try {
      // stty operates on the terminal behind stdin, so stdin must be the TTY —
      // piping /dev/null (ignore) makes stty fail with "not a tty".
      const saved = execFileSync(sttyPath, ['-g'], {
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'ignore'],
      });
      savedStty = saved.trim();
      execFileSync(sttyPath, ['-ixon'], { stdio: ['inherit', 'ignore', 'ignore'] });
    } catch {
      /* ignore */
    }
  }
  const restoreStty = (): void => {
    if (sttyPath === undefined || savedStty === undefined) return;
    const args = savedStty.split(/\s+/).filter((arg) => arg.length > 0);
    if (args.length === 0) return;
    spawnSync(sttyPath, args, { stdio: ['inherit', 'ignore', 'ignore'] });
  };

  // If we crash without going through KimiTUI.stop(), the terminal is left in
  // raw mode with a hidden cursor and XON/XOFF flow control disabled. Restore
  // both before exiting so the user's shell is usable afterwards.
  const emergencyExit = (exitCode: number): void => {
    // The crash log above is only enqueued into the async sink; flush it
    // synchronously or the `process.exit()` below would drop the one line that
    // explains why we crashed. Best-effort: an exit path must never throw.
    try {
      flushDiagnosticLogsSync();
    } catch {
      /* ignore */
    }
    restoreTerminalModes();
    restoreStty();
    process.exit(exitCode);
  };
  const onUncaughtException = (error: unknown): void => {
    try {
      log.error('uncaughtException, restoring terminal and exiting', { error: String(error) });
    } catch {
      /* ignore */
    }
    emergencyExit(1);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    try {
      log.error('unhandledRejection, restoring terminal and exiting', { reason: String(reason) });
    } catch {
      /* ignore */
    }
    emergencyExit(1);
  };
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  // Remove the crash handlers once the TUI exits cleanly so repeated runShell()
  // calls in the same process (e.g. tests) don't accumulate process listeners.
  const removeCrashHandlers = (): void => {
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
  };

  tui.onExit = async (exitCode = 0) => {
    const sessionId = tui.getCurrentSessionId();
    const hasContent = tui.hasSessionContent();
    const gutter = ' '.repeat(CHROME_GUTTER);
    process.stdout.write(`${gutter}Bye!\n`);
    const hints: string[] = [];
    if (sessionId !== '' && hasContent) {
      hints.push(`${gutter}To resume this session: kimi -r ${sessionId}`);
    }
    if (tui.exitOpenUrl !== undefined) {
      hints.push(`${gutter}open ${toTerminalHyperlink(tui.exitOpenUrl, tui.exitOpenUrl)}`);
    }
    if (hints.length > 0) {
      process.stderr.write(`\n${hints.join('\n')}\n`);
    }
    removeCrashHandlers();
    restoreStty();
    if (tui.exitForegroundTask !== undefined) {
      // `/web` starting a new server: the TUI has shut down cleanly; hand the
      // terminal to the foreground server instead of exiting. The task runs
      // until the server stops (Ctrl+C), then this process exits.
      await tui.exitForegroundTask(exitCode);
      return;
    }
    process.exit(exitCode);
  };
  try {
    startupTrace('tui.start:begin');
    await tui.start();
    startupTrace('tui.start:end');
  } catch (error) {
    removeCrashHandlers();
    await closeOnStartFailure();
    throw error;
  }
}

const TUI_DAEMON_ENV = 'KIMI_CODE_EXPERIMENTAL_TUI_DAEMON';
const EXPERIMENTAL_MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

export function isTuiDaemonEnabled(
  experimental: Readonly<Record<string, boolean>> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const override = parseBooleanEnv(env[TUI_DAEMON_ENV]);
  if (override !== undefined) return override;
  const configured = experimental?.['tui_daemon'];
  if (configured !== undefined) return configured;
  return parseBooleanEnv(env[EXPERIMENTAL_MASTER_ENV]) === true;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function daemonStartupNotice(configWarning: string | undefined): string {
  const notice =
    'Experimental daemon TUI is enabled. Unsupported: settings/config, experiments, rename, authentication, exports, tasks, goals, plugins, plan/theme/editor changes, MCP/status/usage, undo, and web. Run /help for the complete list. Set KIMI_CODE_EXPERIMENTAL_TUI_DAEMON=0 and remove experimental.tui_daemon from config to return to the default TUI.';
  return configWarning === undefined ? notice : `${configWarning}\n${notice}`;
}
