import { execFileSync, spawnSync } from 'node:child_process';

import { flushDiagnosticLogsSync, log } from '@moonshot-ai/kimi-code-sdk';

import { CLI_UI_MODE } from '#/constant/app';
import type { TuiConfig } from '#/tui/config';
import { loadTuiConfig, TuiConfigParseError } from '#/tui/config';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { DaemonTUI } from '#/tui/daemon/daemon-tui';
import { discoverDaemon, ensureDaemon, resolveDaemonHome } from '#/tui/daemon/discovery';
import { runWorkspaceTrustGate } from '#/tui/daemon/workspace-trust';
import { startupTrace } from '#/utils/startup-trace';
import { currentTheme, getColorPalette } from '#/tui/theme';
import { restoreTerminalModes } from '#/utils/terminal-restore';
import { resolveCommandPath } from '#/utils/process/resolve-command';

import type { CLIOptions } from './options';
import { resolveAgentProfileSelection } from './agent-selection';

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
  log.info('kimi-code starting', {
    version,
    uiMode: CLI_UI_MODE,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    workDir,
  });

  const homeDir = resolveDaemonHome();
  if (!(await runWorkspaceTrustGate({ homeDir, workDir }))) return;
  const agentProfile = await resolveAgentProfileSelection(opts, workDir);
  const connection =
    (await discoverDaemon(homeDir, workDir)) ??
    (await ensureDaemon({ homeDir, workspacePath: workDir }));
  startupTrace('daemon:connected');
  const tui = new DaemonTUI(connection, {
    cliOptions: opts,
    agentProfile,
    additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
    tuiConfig,
    version,
    workDir,
    startupNotice: configWarning,
  });

  let savedStty: string | undefined;
  // Resolve stty to an absolute PATH hit so a workspace binary cannot shadow
  // the system command. When it cannot be resolved, skip save/restore — it is
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

  // If we crash without going through DaemonTUI.stop(), the terminal is left in
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
  let terminating = false;
  const stopAfterSignal = async (exitCode: number): Promise<void> => {
    try {
      await tui.stop(exitCode);
    } catch (error) {
      try {
        log.error('signal shutdown failed, restoring terminal and exiting', {
          error: String(error),
        });
      } finally {
        emergencyExit(exitCode);
      }
    }
  };
  const onTerminationSignal = (exitCode: number): (() => void) => () => {
    if (terminating) return;
    terminating = true;
    void stopAfterSignal(exitCode);
  };
  const onSigterm = onTerminationSignal(143);
  const onSighup = onTerminationSignal(129);
  const closeAfterOutputError = async (): Promise<void> => {
    try {
      await tui.close();
    } catch (closeError) {
      log.error('TUI close failed after output stream error', { error: String(closeError) });
    } finally {
      emergencyExit(129);
    }
  };
  const onOutputError = (error: NodeJS.ErrnoException): void => {
    if (!isTerminalOutputError(error)) throw error;
    if (terminating) return;
    terminating = true;
    void closeAfterOutputError();
  };
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  process.once('SIGTERM', onSigterm);
  if (process.platform !== 'win32') process.once('SIGHUP', onSighup);
  process.stdout.on('error', onOutputError);
  process.stderr.on('error', onOutputError);
  const removeHandlers = (): void => {
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('SIGTERM', onSigterm);
    if (process.platform !== 'win32') process.off('SIGHUP', onSighup);
    process.stdout.off('error', onOutputError);
    process.stderr.off('error', onOutputError);
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
    if (hints.length > 0) {
      process.stderr.write(`\n${hints.join('\n')}\n`);
    }
    removeHandlers();
    restoreTerminalModes();
    restoreStty();
    process.exit(exitCode);
  };
  try {
    startupTrace('tui.start:begin');
    await tui.start();
    startupTrace('tui.start:end');
  } catch (error) {
    removeHandlers();
    try {
      await tui.close();
    } catch (closeError) {
      try {
        log.error('TUI close failed after startup error', { error: String(closeError) });
      } catch {
        /* preserve the startup error */
      }
    } finally {
      restoreTerminalModes();
      restoreStty();
    }
    throw error;
  }
}

export function isTerminalOutputError(error: NodeJS.ErrnoException): boolean {
  return error.code === 'EIO' || error.code === 'EPIPE';
}
