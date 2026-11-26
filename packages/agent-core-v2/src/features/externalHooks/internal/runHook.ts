import { type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { bundledWindowsToolchainCandidates, mergeChildEnv } from '@kiki/kaos/exec-env';
import { z } from 'zod';

import { ensureKikiNodeShimSync } from '#/os/backends/node-local/kikiCliPath';
import { type IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import { toErrorPayload } from '#/_base/errors/serialize';
import { isPlainObject } from '#/_base/utils/types';

import { isExplicitHookBlock, type HookResult } from './types';

export interface RunHookOptions {
  readonly timeout: number;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly failClosed?: boolean;
}

export interface HookEnvContext {
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly execPath?: string;
  readonly homeDir?: string;
  readonly pathExists?: (candidate: string) => boolean;
  readonly ensureNodeShimDir?: (kikiHome: string, seaExecutable: string) => string | undefined;
}

export function resolveHookEnvOverrides(
  overrides?: Readonly<Record<string, string>>,
  context: HookEnvContext = {},
): Record<string, string> | undefined {
  const platform = context.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const baseEnv = context.baseEnv ?? process.env;
  const execPath = context.execPath ?? process.execPath;
  const pathExists = context.pathExists ?? safeExistsSync;
  const sep = isWindows ? ';' : ':';

  const overridePath = findPathEntry(overrides, isWindows);
  const basePath = findPathEntry(baseEnv, isWindows);
  const pathKey = overridePath?.key ?? basePath?.key ?? 'PATH';
  const currentPath = overridePath?.value ?? basePath?.value ?? '';
  const existing = currentPath.split(sep).filter((entry) => entry.length > 0);
  const seen = new Set(existing.map((entry) => normalizePathSegment(entry, isWindows)));
  const added: string[] = [];
  const extraEnv: Record<string, string> = {};

  const pluginRoot = overrides?.['KIKI_PLUGIN_ROOT'] ?? baseEnv['KIKI_PLUGIN_ROOT'];
  if (
    pluginRoot !== undefined &&
    pluginRoot.trim().length > 0 &&
    overrides?.['CLAUDE_PLUGIN_ROOT'] === undefined &&
    baseEnv['CLAUDE_PLUGIN_ROOT'] === undefined
  ) {
    extraEnv['CLAUDE_PLUGIN_ROOT'] = pluginRoot;
  }

  const appendIfMissing = (candidate: string): void => {
    if (candidate.length === 0) return;
    const key = normalizePathSegment(candidate, isWindows);
    if (seen.has(key)) return;
    seen.add(key);
    added.push(candidate);
  };

  const pathImpl = isWindows ? path.win32 : path.posix;
  const execBase = pathImpl.basename(execPath).toLowerCase();
  if (execBase === 'node' || execBase === 'node.exe') {
    const nodeDir = pathImpl.dirname(execPath);
    if (nodeDir.length > 0 && nodeDir !== '.') {
      appendIfMissing(nodeDir);
    }
  } else if (isWindows) {
    const mergedLookup: Record<string, string | undefined> = { ...baseEnv, ...overrides };
    let hasToolchainNodeShim = false;
    for (const root of bundledWindowsToolchainCandidates(mergedLookup, execPath, {
      resourcesPath: (process as { readonly resourcesPath?: string }).resourcesPath,
      entryScriptPath: process.argv[1],
    })) {
      const gitCmd = path.win32.join(root, 'git', 'cmd');
      if (pathExists(path.win32.join(gitCmd, 'git.exe'))) appendIfMissing(gitCmd);
      for (const sysPrefix of ['ucrt64', 'mingw64', 'clang64', 'clangarm64']) {
        const sysBin = path.win32.join(root, 'git', sysPrefix, 'bin');
        if (pathExists(path.win32.join(sysBin, 'git.exe')) || pathExists(path.win32.join(sysBin, 'curl.exe'))) {
          appendIfMissing(sysBin);
        }
      }
      const usrBin = path.win32.join(root, 'git', 'usr', 'bin');
      if (pathExists(path.win32.join(usrBin, 'bash.exe'))) appendIfMissing(usrBin);
      const toolBin = path.win32.join(root, 'bin');
      const hasNodeCmd = pathExists(path.win32.join(toolBin, 'node.cmd'));
      if (hasNodeCmd || pathExists(path.win32.join(toolBin, 'rg.exe'))) {
        appendIfMissing(toolBin);
        if (hasNodeCmd) hasToolchainNodeShim = true;
      }
    }

    const hasSystemNode = existing.some((entry) => {
      const clean = entry.trim().replace(/^"(.*)"$/, '$1');
      return clean.length > 0 && pathExists(path.win32.join(clean, 'node.exe'));
    });
    if (!hasSystemNode) {
      const isElectronBinary =
        execBase === 'kiki-desktop.exe' ||
        execBase === 'electron.exe' ||
        (context.execPath === undefined && process.versions['electron'] !== undefined);
      if (isElectronBinary) {
        const unpackedEntry = path.win32.join(
          path.win32.dirname(execPath),
          'resources',
          'app.asar.unpacked',
          'dist',
          'server',
          'server-entry.mjs',
        );
        const currentArgv1 = process.argv[1];
        const serverEntry =
          pathExists(unpackedEntry)
            ? unpackedEntry
            : currentArgv1 !== undefined &&
                currentArgv1.toLowerCase().endsWith('server-entry.mjs') &&
                pathExists(currentArgv1)
              ? currentArgv1
              : undefined;
        if (
          serverEntry !== undefined &&
          overrides?.['KIKI_ELECTRON_NODE_EXEC'] === undefined &&
          baseEnv['KIKI_ELECTRON_NODE_EXEC'] === undefined
        ) {
          extraEnv['KIKI_ELECTRON_NODE_EXEC'] = execPath;
          extraEnv['KIKI_ELECTRON_SERVER_ENTRY'] = serverEntry;
        }
      } else {
        if (overrides?.['KIKI_SEA_EXEC'] === undefined && baseEnv['KIKI_SEA_EXEC'] === undefined) {
          extraEnv['KIKI_SEA_EXEC'] = execPath;
        }
        if (!hasToolchainNodeShim) {
          const home = context.homeDir ?? safeHomedir();
          const kikiHome =
            overrides?.['KIKI_HOME']?.trim() ||
            baseEnv['KIKI_HOME']?.trim() ||
            (home.length > 0 ? path.win32.join(home, '.kiki') : '');
          const shimBuilder =
            context.ensureNodeShimDir ??
            ((resolvedHome: string, seaExec: string) => ensureKikiNodeShimSync(resolvedHome, seaExec, 'win32'));
          const nodeShimDir = kikiHome.length > 0 ? shimBuilder(kikiHome, execPath) : undefined;
          if (nodeShimDir !== undefined) {
            appendIfMissing(nodeShimDir);
          }
        }
      }
    }
  }

  if (platform === 'darwin' || platform === 'linux') {
    const home = context.homeDir ?? safeHomedir();
    const candidates = [
      ...(home.length > 0 ? [path.posix.join(home, '.local', 'bin')] : []),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
    for (const candidate of candidates) {
      if (!seen.has(normalizePathSegment(candidate, false)) && pathExists(candidate)) {
        appendIfMissing(candidate);
      }
    }
  }

  if (added.length === 0 && Object.keys(extraEnv).length === 0) {
    return overrides === undefined ? undefined : { ...overrides };
  }
  const result: Record<string, string> = {
    ...overrides,
    ...extraEnv,
  };
  if (added.length > 0) {
    result[pathKey] = [...existing, ...added].join(sep);
  }
  return result;
}

export function buildHookSpawnOptions(
  options: {
    cwd?: string;
    env?: Record<string, string>;
  },
  context: HookEnvContext = {},
): SpawnOptionsWithoutStdio {
  const platform = context.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const baseEnv = context.baseEnv ?? process.env;
  const overrides = resolveHookEnvOverrides(options.env, context);
  return {
    shell: true,
    cwd: options.cwd,
    stdio: 'pipe',
    detached: !isWindows,
    windowsHide: true,
    env: overrides === undefined ? undefined : mergeChildEnv(baseEnv, {}, overrides, [], isWindows),
  };
}

function findPathEntry(
  env: Readonly<Record<string, string | undefined>> | undefined,
  isWindows: boolean,
): { readonly key: string; readonly value: string } | undefined {
  if (env === undefined) return undefined;
  let found: { readonly key: string; readonly value: string } | undefined;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === 'PATH' || (isWindows && key.toLowerCase() === 'path')) {
      found = { key, value };
    }
  }
  return found;
}

function normalizePathSegment(segment: string, isWindows: boolean): string {
  if (isWindows) return segment.replace(/[\\/]+$/, '').toLowerCase();
  return segment === '/' ? '/' : segment.replace(/\/+$/, '');
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return '';
  }
}

function safeExistsSync(candidate: string): boolean {
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}

const DEFAULT_TIMEOUT_SECONDS = 30;
const KILL_GRACE_MS = 100;
const OptionalStringSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z
    .union([z.string(), z.number(), z.boolean()])
    .transform((value) => String(value))
    .optional(),
);
const HookSpecificOutputSchema = z.strictObject({
  hookEventName: z.string().optional(),
  message: OptionalStringSchema,
  additionalContext: OptionalStringSchema,
  permissionDecision: z.enum(['allow', 'deny']).optional(),
  permissionDecisionReason: z.string().optional(),
  recovery: z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('retry') }),
    z.strictObject({
      action: z.enum(['continue', 'auto']),
      userMessage: z.string().refine((value) => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 8192),
    }),
  ]).optional(),
});
const HookJsonOutputSchema = z.strictObject({
  decision: z.enum(['allow', 'approve', 'block']).optional(),
  reason: z.string().optional(),
  message: OptionalStringSchema,
  additionalContext: OptionalStringSchema,
  hookSpecificOutput: HookSpecificOutputSchema.optional(),
});

function translateWindowsPluginRootVars(
  command: string,
  overrides: Readonly<Record<string, string>> | undefined,
): string {
  if (process.platform !== 'win32') return command;
  let next = command;
  if ((overrides?.['KIKI_PLUGIN_ROOT'] ?? process.env['KIKI_PLUGIN_ROOT']) !== undefined) {
    next = next.replaceAll('${KIKI_PLUGIN_ROOT}', '%KIKI_PLUGIN_ROOT%');
  }
  if ((overrides?.['CLAUDE_PLUGIN_ROOT'] ?? process.env['CLAUDE_PLUGIN_ROOT']) !== undefined) {
    next = next.replaceAll('${CLAUDE_PLUGIN_ROOT}', '%CLAUDE_PLUGIN_ROOT%');
  }
  return next;
}

export async function runHook(
  hostProcess: IHostProcessService,
  command: string,
  input: Record<string, unknown>,
  options: RunHookOptions,
): Promise<HookResult> {
  const failClosed = options.failClosed;
  let proc: IHostProcess;
  try {
    const envOverrides = resolveHookEnvOverrides(options.env);
    const effectiveCommand = translateWindowsPluginRootVars(command, envOverrides);
    proc = await hostProcess.spawn(effectiveCommand, [], {
      shell: true,
      ownedProcessTree: true,
      cwd: options.cwd,
      env: envOverrides,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    return blockResult({ message, reason: message, stderr: message, failClosed });
  }

  return new Promise<HookResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = timeoutSeconds(options.timeout) * 1000;

    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const settle = async (result: HookResult, terminate = false): Promise<void> => {
      if (settled) return;
      settled = true;
      cleanup();
      const errors = terminate ? await killProcess(proc) : [];
      try { await proc.dispose(); }
      catch (error) { errors.push(error); }
      if (errors.length > 0) {
        const diagnostic = `Hook process cleanup failed: ${errors.map((error) => JSON.stringify(toErrorPayload(error))).join('; ')}`;
        const combinedStderr = [result.stderr, diagnostic].filter(Boolean).join('\n');
        if (isExplicitHookBlock(result) || (result.action === 'allow' && failClosed !== true)) {
          resolve({ ...result, cleanupError: diagnostic, stderr: combinedStderr });
          return;
        }
        const reason = result.reason?.trim() ? `${result.reason.trim()}; ${diagnostic}` : diagnostic;
        resolve({
          ...result,
          action: 'block',
          structuredOutput: undefined,
          cleanupError: diagnostic,
          reason,
          message: result.message?.trim() ? result.message : diagnostic,
          stderr: combinedStderr,
        });
        return;
      }
      resolve(result);
    };

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const stdoutDone = new Promise<void>((done) => proc.stdout.once('end', done));
    const stderrDone = new Promise<void>((done) => proc.stderr.once('end', done));
    void Promise.all([proc.wait(), stdoutDone, stderrDone]).then(
      ([code]) => settle(resultFromExitCode(code, stdout, stderr, failClosed)),
      (error) => {
        const message = toErrorMessage(error);
        return settle(blockResult({ message, reason: message, stdout, stderr: stderr + message, failClosed }), true);
      },
    );

    const timeout = setTimeout(() => {
      void settle(blockResult({ stdout, stderr, timedOut: true, failClosed }), true);
    }, timeoutMs);

    const onAbort = (): void => {
      void settle(blockResult({ stdout, stderr, failClosed }), true);
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }

    proc.stdin.on('error', () => {});
    proc.stdin.end(JSON.stringify(input));
  });
}

function timeoutSeconds(timeout: number): number {
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_SECONDS;
}

function resultFromExitCode(
  exitCode: number,
  stdout: string,
  stderr: string,
  failClosed?: boolean,
): HookResult {
  if (exitCode !== 0) {
    const message = stderr.trim();
    return blockResult({ message, reason: message, stdout, stderr, exitCode, failClosed });
  }

  const structured = structuredOutput(stdout);
  if (structured.kind === 'invalid') {
    return blockResult({
      reason: 'Hook produced invalid protocol JSON output',
      stdout,
      stderr,
      exitCode,
      failClosed,
    });
  }
  if (structured.kind === 'structured' && structured.action === 'block') {
    return blockResult({
      message: structured.message ?? structured.reason,
      reason: structured.reason,
      stdout,
      stderr,
      exitCode,
      structuredOutput: true,
      failClosed,
    });
  }

  return {
    ...allowResult({
      message: structured.kind === 'structured' ? structured.message : undefined,
      stdout,
      stderr,
      exitCode,
      structuredOutput: structured.kind === 'structured' ? true : undefined,
      failClosed,
    }),
    recovery: structured.kind === 'structured' ? structured.recovery : undefined,
  };
}

type StructuredOutputResult =
  | { readonly kind: 'unstructured' }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'structured';
      readonly action?: 'block';
      readonly reason?: string;
      readonly message?: string;
      readonly recovery?: HookResult['recovery'];
    };

function structuredOutput(stdout: string): StructuredOutputResult {
  const text = stdout.trim();
  if (text.length === 0) return { kind: 'unstructured' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return attemptsHookProtocol(text) ? { kind: 'invalid' } : { kind: 'unstructured' };
  }

  if (!containsHookProtocolField(parsed)) return { kind: 'unstructured' };
  if (!isPlainObject(parsed)) return { kind: 'invalid' };
  const output = HookJsonOutputSchema.safeParse(parsed);
  if (!output.success) return { kind: 'invalid' };

  const { decision, reason, message, additionalContext, hookSpecificOutput } = output.data;
  const resolvedMessage =
    hookSpecificOutput?.additionalContext ??
    additionalContext ??
    message ??
    hookSpecificOutput?.message;
  const result = {
    kind: 'structured' as const,
    message: resolvedMessage,
    recovery: hookSpecificOutput?.recovery,
  };
  if (hookSpecificOutput?.permissionDecision === 'deny') {
    return {
      ...result,
      action: 'block',
      reason: hookSpecificOutput.permissionDecisionReason ?? reason,
    };
  }
  if (decision === 'block') {
    return {
      ...result,
      action: 'block',
      reason: reason ?? hookSpecificOutput?.permissionDecisionReason,
    };
  }
  return result;
}

function containsHookProtocolField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsHookProtocolField);
  if (!isPlainObject(value)) return false;
  if (
    Object.hasOwn(value, 'decision') ||
    Object.hasOwn(value, 'message') ||
    Object.hasOwn(value, 'additionalContext') ||
    Object.hasOwn(value, 'hookSpecificOutput')
  ) {
    return true;
  }
  return Object.values(value).some(containsHookProtocolField);
}

function attemptsHookProtocol(text: string): boolean {
  const objectShaped = text.startsWith('{') || /^\[\s*(?:\{|\[|["']|-|\d|[tfn])/.test(text);
  if (!objectShaped) return false;
  const strings = scanJsonLikeStrings(text);
  if (strings.invalid) return true;
  if (strings.values.some(isHookProtocolField)) return true;
  return /(?:^|[,{]|\s)(?:decision|message|additionalContext|hookSpecificOutput)\s*:/.test(text);
}

function scanJsonLikeStrings(text: string): {
  readonly values: readonly string[];
  readonly invalid: boolean;
} {
  const values: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const quote = text[i];
    if (quote !== '"' && quote !== "'") continue;
    const token = readJsonLikeString(text, i, quote);
    if (token === undefined) return { values, invalid: true };
    values.push(token.value);
    i = token.end;
  }
  return { values, invalid: false };
}

function readJsonLikeString(
  text: string,
  start: number,
  quote: '"' | "'",
): { readonly value: string; readonly end: number } | undefined {
  let value = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) return undefined;
    if (ch === quote) return { value, end: i };
    if (ch !== '\\') {
      const code = text.codePointAt(i);
      if (code === undefined || code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) return undefined;
      value += String.fromCodePoint(code);
      i += code > 0xffff ? 2 : 1;
      continue;
    }

    const escaped = text[i + 1];
    if (escaped === undefined) return undefined;
    if (escaped !== 'u') {
      const decoded = decodeSimpleEscape(escaped, quote);
      if (decoded === undefined) return undefined;
      value += decoded;
      i += 2;
      continue;
    }

    const firstHex = text.slice(i + 2, i + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(firstHex)) return undefined;
    const first = Number.parseInt(firstHex, 16);
    i += 6;
    if (first >= 0xd800 && first <= 0xdbff) {
      if (text.slice(i, i + 2) !== '\\u') return undefined;
      const secondHex = text.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(secondHex)) return undefined;
      const second = Number.parseInt(secondHex, 16);
      if (second < 0xdc00 || second > 0xdfff) return undefined;
      value += String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + second - 0xdc00);
      i += 6;
      continue;
    }
    if (first >= 0xdc00 && first <= 0xdfff) return undefined;
    value += String.fromCodePoint(first);
  }
  return undefined;
}

function decodeSimpleEscape(value: string, quote: '"' | "'"): string | undefined {
  if (value === quote) return quote;
  if (value === '"') return '"';
  if (value === '\\') return '\\';
  if (value === '/') return '/';
  if (value === 'b') return '\b';
  if (value === 'f') return '\f';
  if (value === 'n') return '\n';
  if (value === 'r') return '\r';
  if (value === 't') return '\t';
  return undefined;
}

function isHookProtocolField(value: string): boolean {
  return (
    value === 'decision' ||
    value === 'message' ||
    value === 'additionalContext' ||
    value === 'hookSpecificOutput'
  );
}

function allowResult(input: {
  readonly message?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly structuredOutput?: boolean;
  readonly failClosed?: boolean;
}): HookResult {
  return {
    action: 'allow',
    message: input.message,
    stdout: input.stdout,
    stderr: input.stderr,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    structuredOutput: input.structuredOutput,
    failClosed: input.failClosed,
  };
}

function blockResult(input: {
  readonly message?: string;
  readonly reason?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly structuredOutput?: boolean;
  readonly failClosed?: boolean;
}): HookResult {
  return {
    action: 'block',
    message: input.message,
    reason: input.reason,
    stdout: input.stdout,
    stderr: input.stderr,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    structuredOutput: input.structuredOutput,
    failClosed: input.failClosed,
  };
}

async function killProcess(proc: IHostProcess): Promise<unknown[]> {
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => proc.kill('SIGTERM')),
    new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS)).then(() => proc.kill('SIGKILL')),
  ]);
  return attempts.flatMap((attempt) => attempt.status === 'rejected' ? [attempt.reason] : []);
}
