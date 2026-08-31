import { type SpawnOptionsWithoutStdio } from 'node:child_process';

import { z } from 'zod';

import { type IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

import type { HookResult } from './types';

export interface RunHookOptions {
  readonly timeout: number;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly signal?: AbortSignal;
}

export function buildHookSpawnOptions(options: {
  cwd?: string;
  env?: Record<string, string>;
}): SpawnOptionsWithoutStdio {
  return {
    shell: true,
    cwd: options.cwd,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: options.env === undefined ? undefined : { ...process.env, ...options.env },
  };
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
  message: OptionalStringSchema,
  permissionDecision: z.enum(['allow', 'deny']).optional(),
  permissionDecisionReason: z.string().optional(),
});
const HookJsonOutputSchema = z.strictObject({
  message: OptionalStringSchema,
  hookSpecificOutput: HookSpecificOutputSchema.optional(),
});

export async function runHook(
  hostProcess: IHostProcessService,
  command: string,
  input: Record<string, unknown>,
  options: RunHookOptions,
): Promise<HookResult> {
  let proc: IHostProcess;
  try {
    proc = await hostProcess.spawn(command, [], {
      shell: true,
      cwd: options.cwd,
      env: options.env,
    });
  } catch (error) {
    const message = errorMessage(error);
    return blockResult({ message, reason: message, stderr: message });
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

    const settle = (result: HookResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
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
      ([code]) => {
        void proc.dispose();
        settle(resultFromExitCode(code, stdout, stderr));
      },
      (error) => {
        void proc.dispose();
        const message = errorMessage(error);
        settle(blockResult({ message, reason: message, stdout, stderr: stderr + message }));
      },
    );

    const timeout = setTimeout(() => {
      killProcess(proc);
      settle(blockResult({ stdout, stderr, timedOut: true }));
    }, timeoutMs);

    const onAbort = (): void => {
      killProcess(proc);
      settle(blockResult({ stdout, stderr }));
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

function resultFromExitCode(exitCode: number, stdout: string, stderr: string): HookResult {
  if (exitCode !== 0) {
    const message = stderr.trim();
    return blockResult({ message, reason: message, stdout, stderr, exitCode });
  }

  const structured = structuredOutput(stdout);
  if (structured.kind === 'invalid') {
    return blockResult({ stdout, stderr, exitCode });
  }
  if (structured.kind === 'structured' && structured.action === 'block') {
    return blockResult({
      message: structured.message ?? structured.reason,
      reason: structured.reason,
      stdout,
      stderr,
      exitCode,
      structuredOutput: true,
    });
  }

  return allowResult({
    message: structured.kind === 'structured' ? structured.message : undefined,
    stdout,
    stderr,
    exitCode,
    structuredOutput: structured.kind === 'structured' ? true : undefined,
  });
}

type StructuredOutputResult =
  | { readonly kind: 'unstructured' }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'structured';
      readonly action?: 'block';
      readonly reason?: string;
      readonly message?: string;
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
  if (!isRecord(parsed)) return { kind: 'invalid' };
  const output = HookJsonOutputSchema.safeParse(parsed);
  if (!output.success) return { kind: 'invalid' };

  const { message, hookSpecificOutput } = output.data;
  const result = {
    kind: 'structured' as const,
    message: message ?? hookSpecificOutput?.message,
  };
  if (hookSpecificOutput?.permissionDecision !== 'deny') {
    return result;
  }
  return {
    ...result,
    action: 'block',
    reason: hookSpecificOutput.permissionDecisionReason,
  };
}

function containsHookProtocolField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsHookProtocolField);
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, 'message') || Object.hasOwn(value, 'hookSpecificOutput')) return true;
  return Object.values(value).some(containsHookProtocolField);
}

function attemptsHookProtocol(text: string): boolean {
  const objectShaped = text.startsWith('{') || (text.startsWith('[') && text.includes('{'));
  if (!objectShaped) return false;
  return /(?:^|[,{]|\s)(?:(["'])(?:message|hookSpecificOutput)\1\s*(?::|(?=[},\]]))|(?:message|hookSpecificOutput)\s*:)/.test(
    text,
  );
}

function allowResult(input: {
  readonly message?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly structuredOutput?: boolean;
}): HookResult {
  return {
    action: 'allow',
    message: input.message,
    stdout: input.stdout,
    stderr: input.stderr,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    structuredOutput: input.structuredOutput,
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
  };
}

function killProcess(proc: IHostProcess): void {
  void proc.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    void proc.kill('SIGKILL');
  }, KILL_GRACE_MS);
  killTimer.unref();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
