/** Enable browser access on the shared daemon without replacing its engine. */

import { existsSync } from 'node:fs';
import { createKlient } from '@kiki/klient/http';
import { ensureServer, findReachableServer } from '#/kiki/serve';
import { resolveKikiHome } from '#/kiki/home';
import { isAbsolute, join } from 'node:path';

import { createServerLogger, startServer, type ServerLogger } from '@kiki/kap-server';
import chalk from 'chalk';
import type { Command } from 'commander';

import { WEB_USER_AGENT_SUFFIX } from '#/constant/app';
import { getBrowserDriverFile } from '#/native/native-assets';
import {
  getNativeWebAssetsDir,
  resolveServerWebAssetsDir,
} from '#/native/web-assets';
import { darkColors } from '#/tui/theme/colors';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';
import { createKimiCodeHostIdentity, getVersion } from '../../version';
import { accessUrlLines, buildOpenableUrl, isLoopbackHost, splitTokenFragment } from './access-urls';
import { resolveHeapWatchdogPolicy, startHeapWatchdog } from './heap-watchdog';
import { type NetworkAddress } from './networks';
import { parseServerOptions, type ParsedServerOptions, type ServerCliOptions } from './shared';

/**
 * Minimal surface `runServerInProcess` needs from the server. kap-server's
 * `RunningServer` is adapted to it (it returns `{ host, port, close }`
 * instead of `{ address, logger, close }`).
 */
interface RoutedServer {
  readonly address: string;
  readonly logger: ServerLogger;
  close(): Promise<void>;
}

export interface WebCliOptions extends ServerCliOptions {
  open?: boolean;
  home?: string;
  persistent?: boolean;
  temporary?: boolean;
  status?: boolean;
  off?: boolean;
  revoke?: string | boolean;
  publicUrl?: string;
  json?: boolean;
}

export interface ExternalCatalogSourceOptions {
  readonly configPath: string;
  readonly configReadOnly: true;
  readonly userAgentProfileHomeDir: string;
}

export interface DesktopInheritanceSourceOptions {
  readonly oauthHomeDir?: string;
  readonly userSkillDir?: string;
}

export interface StartForegroundHooks {
  /** Fires once the server is listening, before the foreground runner blocks. */
  onReady?: (origin: string) => void | Promise<void>;
  onShutdown?: (reason: string) => void | Promise<void>;
}

export interface WebCommandDeps {
  ensureServer?: typeof ensureServer;
  findServer?: typeof findReachableServer;
  createKlient?: typeof createKlient;
  openUrl(url: string): void;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

/**
 * Build the Web UI URL, carrying the bearer token in the URL fragment.
 *
 * The token rides in `#token=<token>` — a client-side fragment that is never
 * sent to the server (so it never appears in server access logs) and is not
 * logged by proxies. The Web UI reads it from `location.hash` after load.
 */
export function buildWebUrl(origin: string, token: string): string {
  return buildOpenableUrl(origin, token);
}

/** Build the `web` command, mounting the runner action on `cmd` itself. */
export function buildWebCommand(cmd: Command): Command {
  return cmd
    .option('--home <dir>', 'Kiki home directory.')
    .option('--persistent', 'Keep Web access enabled across daemon restarts.')
    .option('--temporary', 'Enable Web access for eight hours (default).')
    .option('--status', 'Show Web access without starting a daemon.')
    .option('--off', 'Disable Web access without stopping Kiki or its tasks.')
    .option('--revoke [session-id]', 'Revoke one browser, or all browsers when no id is given.')
    .option('--port <port>', 'Port for the additional Web listener; omission reuses the local daemon port.')
    .option('--host [host]', 'Bind the Web listener; --host alone listens on all IPv4 interfaces.')
    .option('--public-url <url>', 'Explicit browser origin, for example the HTTPS URL of your reverse proxy.')
    .option('--insecure-no-tls', 'Allow LAN HTTP; traffic and browser access are not encrypted.')
    .option('--json', 'Print the Web access result as JSON.')
    .option('--no-open', 'Do not open the Web UI in the default browser.', true)
    .action(async (opts: WebCliOptions) => {
      try {
        await handleWebCommand(opts);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

export async function handleWebCommand(
  opts: WebCliOptions,
  deps: WebCommandDeps = DEFAULT_WEB_COMMAND_DEPS,
): Promise<void> {
  const parsed = parseServerOptions(opts);
  if ([opts.status, opts.off, opts.revoke !== undefined].filter(Boolean).length > 1 || (opts.persistent && opts.temporary)) throw new Error('Choose one Web action and one access mode.');
  const homeDir = resolveKikiHome(opts.home);
  const manageExisting = opts.status || opts.off || opts.revoke !== undefined;
  const connection = manageExisting
    ? await (deps.findServer ?? findReachableServer)(homeDir)
    : await (deps.ensureServer ?? ensureServer)({ homeDir, idleExit: '0ms' });
  if (connection === undefined) {
    if (!opts.status) throw new Error('No reachable Kiki daemon was found.');
    deps.stdout.write(opts.json ? '{"enabled":false,"running":false}\n' : 'Web access is off; Kiki is not running.\n'); return;
  }
  const klient = (deps.createKlient ?? createKlient)({ endpoint: connection.url, token: connection.token });
  try {
    const web = klient.rest!.webAccess;
    if (opts.status || opts.off || opts.revoke !== undefined) {
      const status = opts.off ? await web.disable() : opts.revoke !== undefined ? await web.revoke(typeof opts.revoke === 'string' ? opts.revoke : undefined) : await web.status();
      deps.stdout.write(opts.json ? `${JSON.stringify(status)}\n` : status.enabled ? `Web access (${status.mode}): ${status.url}\n` : 'Web access is off.\n'); return;
    }
    const status = await web.enable({ mode: opts.persistent ? 'persistent' : 'temporary', host: opts.host === undefined ? undefined : parsed.host,
      port: opts.port === undefined ? undefined : parsed.port, publicUrl: opts.publicUrl, insecureNoTls: opts.insecureNoTls });
    const link = await web.issueLink();
    deps.stdout.write(opts.json ? `${JSON.stringify({ ...status, link })}\n` : `Web access (${status.mode}): ${link.url}\nThis single-use link grants full Web use and expires in 10 minutes.\n${status.insecure ? 'LAN HTTP is not encrypted. Use a trusted network or HTTPS reverse proxy.\n' : ''}Kiki and its running tasks remain active; use kiki web --off to close Web access.\n`);
    if (opts.open !== false) deps.openUrl(link.url);
  } finally { await klient.close(); }
}

/**
 * Red, impossible-to-miss notice emitted when `--dangerous-bypass-auth`
 * disables the bearer-token gate. Shared by the full ready banner and the
 * compact one-line output so the warning always shows regardless of log level.
 */
function formatDangerNoticeLines(): string[] {
  const danger = (text: string): string => chalk.hex(darkColors.error)(text);
  const dangerBold = (text: string): string => chalk.bold.hex(darkColors.error)(text);
  return [
    `  ${dangerBold('⚠ DANGER: authentication is DISABLED (--dangerous-bypass-auth).')}`,
    `  ${danger('Anyone who can reach this port gets full access. Only continue if you understand the risk.')}`,
    `  ${danger('If you are unsure, stop this process now with ')}${dangerBold('Ctrl+C')}${danger('.')}`,
  ];
}

/**
 * `kimi web` — runs the local server in-process, attached to the current
 * terminal. Resolves only via `process.exit` (SIGINT/SIGTERM).
 */
export async function startServerForeground(
  options: ParsedServerOptions,
  hooks: StartForegroundHooks = {},
): Promise<never> {
  return runServerInProcess(options, hooks);
}

/**
 * Start the server in the current process and block until shutdown.
 * `onReady` fires once the server is listening.
 */
async function runServerInProcess(
  options: ParsedServerOptions,
  hooks: StartForegroundHooks,
): Promise<never> {
  const version = getVersion();
  const externalCatalog = externalCatalogSourceFromEnv(process.env);

  let running: RoutedServer | undefined;
  let stopping = false;

  async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    running?.logger.info({ reason }, 'server shutting down');
    try {
      await hooks.onShutdown?.(reason);
    } catch (error) {
      running?.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'foreground shutdown hook error',
      );
    }
    try {
      await running?.close();
    } catch (error) {
      running?.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'server shutdown error',
      );
    }
    process.exit(0);
  }

  // kap-server (the DI × Scope engine server) is the only server flavor. Its
  // `startServer` returns `{ host, port, close }` rather than `{ address,
  // logger, close }`, so adapt it to the `RoutedServer` surface the rest of
  // this runner consumes.
  const logger = createServerLogger({ level: options.logLevel });
  const webAssetsDir = serverWebAssetsDir();
  if (webAssetsDir === undefined) {
    logger.info(
      'dev mode: web assets not built; starting the API server without the web UI',
    );
  }
  const desktopInheritance = desktopInheritanceSourceFromEnv(process.env);
  const v2 = await startServer({
    host: options.host,
    port: options.port,
    // Report the CLI's product version as `server_version` (/meta, web UI)
    // rather than kap-server's private package version.
    serverVersion: version,
    // The CLI's host identity: feeds the engine's bootstrap client identity
    // and the derived outbound headers (User-Agent + X-Msh-*), so web-UI
    // OAuth flows and model / WebSearch requests carry the CLI identity. The
    // `web` User-Agent suffix distinguishes web-UI traffic from direct CLI
    // runs upstream (same product token, same platform).
    hostIdentity: {
      ...createKimiCodeHostIdentity(version, { configPath: externalCatalog?.configPath }),
      userAgentSuffix: WEB_USER_AGENT_SUFFIX,
    },
    logLevel: options.logLevel,
    logger,
    configPath: externalCatalog?.configPath,
    configReadOnly: externalCatalog?.configReadOnly,
    userAgentProfileHomeDir: externalCatalog?.userAgentProfileHomeDir,
    modelAccountHomeDir: desktopInheritance?.oauthHomeDir,
    userSkillDir: desktopInheritance?.userSkillDir,
    browserDriverPath: getBrowserDriverFile() ?? undefined,
    debugEndpoints: options.debugEndpoints,
    insecureNoTls: options.insecureNoTls,
    allowRemoteShutdown: options.allowRemoteShutdown,
    allowedHosts: options.allowedHosts,
    disableAuth: options.dangerousBypassAuth,
    webTitle: options.webTitle,
    idleExitMs: options.idleExitMs,
    webAssetsDir,
  });
  logger.info('serving the REST/WS API and the bundled web UI');
  running = {
    address: `http://${v2.host}:${v2.port}`,
    logger,
    close: () => v2.close(),
  };

  const memoryPolicy = resolveHeapWatchdogPolicy(process.env);
  if (memoryPolicy !== undefined) {
    logger.info(memoryPolicy, 'memory watchdog armed');
    startHeapWatchdog({
      policy: memoryPolicy,
      onTrip: (trip) => {
        logger.warn(
          trip,
          'memory watchdog tripped; restarting the server before sustained memory pressure stalls it',
        );
        void shutdown('memory_limit');
      },
    });
  }

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  running.logger.info({ address: running.address }, 'server ready');

  try {
    await hooks.onReady?.(running.address);
  } catch (error) {
    try {
      await hooks.onShutdown?.('startup_failed');
    } finally {
      await running.close();
    }
    throw error;
  }

  return new Promise<never>(() => {
    // Keeps the event loop alive; the process ends via shutdown()/process.exit.
  });
}

export function externalCatalogSourceFromEnv(
  env: NodeJS.ProcessEnv,
): ExternalCatalogSourceOptions | undefined {
  const configPath = env['KIKI_MCP_CONFIG_PATH'];
  const userAgentProfileHomeDir = env['KIKI_MCP_AGENT_PROFILE_HOME'];
  const readOnly = env['KIKI_MCP_CONFIG_READ_ONLY'];
  if (configPath === undefined && userAgentProfileHomeDir === undefined && readOnly === undefined) {
    return undefined;
  }

  // Name each misconfigured variable instead of collapsing to a generic
  // "incomplete or unsafe" — READ_ONLY=0 in particular must read as "must be
  // '1'", not as a vague security refusal.
  const problems: string[] = [];
  if (configPath === undefined) {
    problems.push('KIKI_MCP_CONFIG_PATH is required.');
  } else if (!isAbsolute(configPath)) {
    problems.push('KIKI_MCP_CONFIG_PATH must be an absolute path.');
  }
  if (userAgentProfileHomeDir === undefined) {
    problems.push('KIKI_MCP_AGENT_PROFILE_HOME is required.');
  } else if (!isAbsolute(userAgentProfileHomeDir)) {
    problems.push('KIKI_MCP_AGENT_PROFILE_HOME must be an absolute path.');
  }
  if (readOnly !== '1') {
    problems.push("KIKI_MCP_CONFIG_READ_ONLY must be '1' to use a read-only catalog source.");
  }
  if (problems.length > 0) {
    throw new Error(`Kiki MCP catalog source is misconfigured: ${problems.join(' ')}`);
  }
  return { configPath: configPath!, configReadOnly: true, userAgentProfileHomeDir: userAgentProfileHomeDir! };
}

export function desktopInheritanceSourceFromEnv(
  env: NodeJS.ProcessEnv,
): DesktopInheritanceSourceOptions | undefined {
  const oauthHomeDir = env['KIKI_DESKTOP_OAUTH_HOME'];
  const userSkillDir = env['KIKI_DESKTOP_USER_SKILL_DIR'];
  if (oauthHomeDir === undefined && userSkillDir === undefined) {
    return undefined;
  }
  for (const [name, value] of [
    ['KIKI_DESKTOP_OAUTH_HOME', oauthHomeDir],
    ['KIKI_DESKTOP_USER_SKILL_DIR', userSkillDir],
  ] as const) {
    if (value !== undefined && !isAbsolute(value)) {
      throw new Error(`${name} must be an absolute path.`);
    }
  }
  return { oauthHomeDir, userSkillDir };
}

/**
 * Resolve the web assets directory passed to kap-server. In dev mode
 * (`KIKI_DEV_SERVER=1`, set by the repo's `dev:server` / `dev:kap-server*`
 * scripts) a missing GUI build is tolerated: the server starts API-only
 * and the web UI is expected to come from the GUI Vite dev server.
 * Outside dev mode the directory is always returned and kap-server keeps
 * failing fast when the assets are missing.
 */
export function serverWebAssetsDir(
  env: NodeJS.ProcessEnv = process.env,
  nativeWebAssetsDir: string | null = getNativeWebAssetsDir(),
): string | undefined {
  const dir = resolveServerWebAssetsDir(nativeWebAssetsDir);
  if (env['KIKI_DEV_SERVER'] === '1' && !existsSync(join(dir, 'index.html'))) {
    return undefined;
  }
  return dir;
}

export { resolveServerWebAssetsDir };

interface FormatReadyBannerOptions {
  /** Persistent bearer token to print; omitted when unresolvable. */
  token?: string;
  homeId?: string;
  /** Non-loopback interface addresses to list for a wildcard bind. */
  networkAddresses?: NetworkAddress[];
  /** When true, render a red danger notice (auth is disabled). */
  dangerousBypassAuth?: boolean;
}

export function formatReadyBanner(
  origin: string,
  host: string,
  opts: FormatReadyBannerOptions = {},
): string {
  const primary = (text: string): string => chalk.hex(darkColors.primary)(text);
  const title = (text: string): string => chalk.bold.hex(darkColors.primary)(text);
  const dim = (text: string): string => chalk.hex(darkColors.textDim)(text);
  const muted = (text: string): string => chalk.hex(darkColors.textMuted)(text);
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const url = (text: string): string => chalk.hex(darkColors.accent)(text);
  // Render the `#token=…` fragment in a de-emphasized gray so the host/port
  // stands out while the full URL stays selectable for copying.
  const urlWithDimToken = (href: string): string => {
    const [base, frag] = splitTokenFragment(href);
    return frag === '' ? url(base) : url(base) + dim(frag);
  };

  const port = Number(origin.slice(origin.lastIndexOf(':') + 1));
  // Borderless header: the Kimi sprite (the little mascot with eyes) sits next
  // to the title, keeping the brand without the enclosing box.
  const logo = ['▐█▛█▛█▌', '▐█████▌'] as const;
  const lines: string[] = [
    '',
    `  ${primary(logo[0])}  ${title('Kiki server ready')}  ${dim(getVersion())}`,
    `  ${primary(logo[1])}  ${dim('Local web UI is available from this machine.')}`,
    '',
  ];

  if (opts.dangerousBypassAuth === true) {
    // Red, impossible-to-miss notice: the bearer-token gate is off, so anyone
    // who can reach this port gets full session / filesystem / shell access.
    lines.push(...formatDangerNoticeLines(), '');
  }

  // Access links.
  for (const { label: text, url: href } of accessUrlLines(
    host,
    port,
    opts.token,
    opts.networkAddresses,
  )) {
    lines.push(`  ${label(text)}${urlWithDimToken(href)}`);
  }
  // On a loopback bind there is no network URL; show how to enable one.
  if (isLoopbackHost(host)) {
    lines.push(`  ${label('Network:  ')}${muted('off')}${dim('  use --host to enable')}`);
  }
  if (opts.token !== undefined) {
    // Set the token off with surrounding whitespace rather than color, so it is
    // easy to spot without being highlighted.
    lines.push('');
    lines.push(`  ${label('Token:    ')}${opts.token}`);
    if (opts.homeId !== undefined) lines.push(`  ${label('SSH home ID: ')}${opts.homeId}`);
    lines.push('');
  }

  // Auxiliary controls last.
  lines.push(`  ${label('Logs:     ')}${muted('off')}${dim('  use --log-level info to enable')}`);
  // The server always runs in the foreground attached to this terminal.
  lines.push(`  ${label('Stop:     ')}${muted('Ctrl+C')}`);
  lines.push('');
  return lines.join('\n');
}

const DEFAULT_WEB_COMMAND_DEPS: WebCommandDeps = {
  openUrl: defaultOpenUrl,
  stdout: process.stdout,
  stderr: process.stderr,
};
