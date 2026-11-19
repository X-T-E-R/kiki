import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import {
  DEFAULT,
  EFFORTS,
  MAX_FRAME_BYTES,
  type AgyAccountConfig,
  type AgyDeniedAction,
  type AgySession,
  type AgyStepUpdate,
  type PromptBlock,
  type SpawnProcessFn,
  type StopProcessFn,
  type UsageTotals,
} from './types';

const CATALOG_TIMEOUT_MS = 20_000;
const CATALOG_MAX_BYTES = 65_536;

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function takeNewDenials(
  actions: readonly AgyDeniedAction[] | undefined,
  reported: Map<string, number>,
): AgyDeniedAction[] {
  const counts = new Map<string, number>();
  const fresh = (actions ?? []).filter((action) => {
    const key = JSON.stringify([action?.action, action?.display_name]);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count > (reported.get(key) ?? 0);
  });
  for (const [key, count] of counts) {
    reported.set(key, Math.max(count, reported.get(key) ?? 0));
  }
  return fresh;
}

export function accumulateStepUsage(
  usageSteps: Set<number>,
  totals: UsageTotals,
  step: AgyStepUpdate | undefined,
): boolean {
  if (
    step?.state !== 'DONE' ||
    !step.usage ||
    !Number.isSafeInteger(step.step_index) ||
    usageSteps.has(step.step_index!)
  ) {
    return false;
  }
  usageSteps.add(step.step_index!);
  totals.inputTokens += Number(step.usage.input_tokens) || 0;
  totals.outputTokens += Number(step.usage.output_tokens) || 0;
  totals.cachedReadTokens += Number(step.usage.cache_read_tokens) || 0;
  totals.thoughtTokens += Number(step.usage.thinking_tokens) || 0;
  totals.totalTokens += Number(step.usage.total_tokens) || 0;
  return true;
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, thoughtTokens: 0, totalTokens: 0 };
}

export function subagentPayload(step: AgyStepUpdate | undefined):
  | {
      subagents: Array<{
        type_name?: string;
        initial_prompt?: string;
        conversation_id?: string;
        log_uri?: string;
      }>;
    }
  | undefined {
  if (!step?.subagent_info) return undefined;
  return {
    subagents: (step.subagent_info.subagents ?? []).map((child) => ({
      type_name: child?.type_name,
      initial_prompt: child?.initial_prompt,
      conversation_id: child?.conversation_id,
      log_uri: child?.log_uri,
    })),
  };
}

export function encodedEffort(model: string): string | undefined {
  return EFFORTS.find((effort) => model.endsWith(`-${effort}`));
}

export function validateEffort(model: string, effort: string): void {
  if (!( [DEFAULT, ...EFFORTS] as readonly string[]).includes(effort)) {
    throw new Error('Unsupported AGY effort selection');
  }
  const encoded = encodedEffort(model);
  if (effort === DEFAULT) return;
  if (encoded === undefined) {
    throw new Error(
      `AGY model ID ${model} does not embed an effort; effort ${effort} is not an advertised config for this id`,
    );
  }
  if (effort !== encoded) {
    throw new Error(
      `AGY model ID ${model} encodes effort ${encoded} and conflicts with effort ${effort}; select the corresponding raw AGY model ID instead`,
    );
  }
}

export function launchArgs(session: Pick<
  AgySession,
  'model' | 'effort' | 'conversationId' | 'permissionMode' | 'accountBound' | 'additionalDirectories'
>): string[] {
  validateEffort(session.model, session.effort);
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (session.conversationId) args.push('--conversation', session.conversationId);
  if (session.model !== DEFAULT) args.push('--model', session.model);
  if (session.effort !== DEFAULT && !session.model.startsWith('claude-')) args.push('--effort', session.effort);
  const mode = session.permissionMode ?? DEFAULT;
  if (mode === 'yolo') args.push('--dangerously-skip-permissions');
  const settings =
    mode === 'manual'
      ? { toolPermission: 'request-review', agentMode: 'default' }
      : mode === 'auto'
        ? { toolPermission: 'request-review', agentMode: 'auto' }
        : mode === 'yolo'
          ? {
              toolPermission: 'always-proceed',
              agentMode: 'accept-edits',
              allowNonWorkspaceAccess: true,
              enableTerminalSandbox: false,
            }
          : undefined;
  const accountSettings = session.accountBound
    ? {
        modelProvider: 'gemini',
        customModelsConfig: {
          customModels: {
            [session.model]: {
              modelName: `gemini-api://models/${session.model}`,
              toolFormatterType: 'TOOL_FORMATTER_TYPE_NONE',
            },
          },
        },
      }
    : undefined;
  if (settings !== undefined || accountSettings !== undefined) {
    args.push('--settings', JSON.stringify({ ...settings, ...accountSettings }));
  }
  for (const dir of session.additionalDirectories) args.push('--add-dir', dir);
  return args;
}

export function promptText(blocks: unknown): string {
  if (
    !Array.isArray(blocks) ||
    blocks.some((b: PromptBlock) => b?.type !== 'text' || typeof b.text !== 'string')
  ) {
    throw new Error(
      'This AGY ACP adapter accepts text prompts only; CLI rich-input support has not been verified',
    );
  }
  const text = (blocks as Array<{ type: 'text'; text: string }>).map((b) => b.text).join('\n');
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES / 2) {
    throw new Error('AGY prompt exceeds the adapter frame limit');
  }
  return text;
}

/** First whitespace token of each `agy models` row. Header and comment rows are not ids. */
export function vendorModelIds(output: unknown): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const line of String(output).split(/\r?\n/u)) {
    const first = (line.trim().split(/\s+/u)[0] ?? '').trim();
    if (first === '' || first.startsWith('#') || /^(?:id|model|models|name)$/iu.test(first)) continue;
    if (first.length > 256 || /\s/u.test(first) || seen.has(first)) continue;
    seen.add(first);
    values.push(first);
  }
  return values;
}

export function safeDiagnosticLine(text: string): string | undefined {
  const line = text.trim();
  if (
    line.length === 0 ||
    /(?:token|bearer|api[_-]?key|secret|authorization|password)/iu.test(line) ||
    /[A-Za-z0-9+/_-]{32,}={0,2}/u.test(line) ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(line)
  ) {
    return undefined;
  }
  return line.slice(0, 180);
}

export function catalogDiagnostic(text: unknown): string {
  const line =
    String(text)
      .split(/\r?\n/u)
      .map((part) => part.trim())
      .find(Boolean) ?? '';
  return safeDiagnosticLine(line) ?? 'AGY model catalog probe failed';
}

export interface VendorModelCatalogOptions {
  cliPath?: string;
  cliPrefix?: string[];
  spawnProcess?: SpawnProcessFn;
  stopProcess?: StopProcessFn;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type VendorModelCatalogResult =
  | { ok: true; ids: string[] }
  | { ok: false; diagnostic: string };

export function readVendorModelCatalog({
  cliPath,
  cliPrefix = [],
  spawnProcess = spawn as SpawnProcessFn,
  stopProcess,
  timeoutMs = CATALOG_TIMEOUT_MS,
  maxOutputBytes = CATALOG_MAX_BYTES,
}: VendorModelCatalogOptions = {}): Promise<VendorModelCatalogResult> {
  return new Promise<VendorModelCatalogResult>((resolveCatalog) => {
    let child: ChildProcess | undefined;
    let settled = false;
    let overflow = false;
    const finish = (result: VendorModelCatalogResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCatalog(result);
    };
    const timer = setTimeout(() => {
      const stopping =
        child === undefined
          ? undefined
          : Promise.resolve(stopProcess ? stopProcess(child) : child.kill?.()).catch(() => {});
      void Promise.resolve(stopping).finally(() =>
        finish({ ok: false, diagnostic: 'AGY model catalog probe timed out' }),
      );
    }, timeoutMs);
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    try {
      child = spawnProcess(cliPath ?? '', [...cliPrefix, 'models'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({
        ok: false,
        diagnostic: catalogDiagnostic(error instanceof Error ? error.message : String(error)),
      });
      return;
    }
    const take = (current: Buffer, chunk: Buffer | string): Buffer => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const next = Buffer.concat([current, bytes]);
      if (next.length > maxOutputBytes) {
        overflow = true;
        child?.kill?.();
        return next.subarray(0, maxOutputBytes);
      }
      return next;
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = take(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = take(stderr, chunk);
    });
    child.once?.('error', (error: unknown) =>
      finish({
        ok: false,
        diagnostic: catalogDiagnostic(error instanceof Error ? error.message : String(error)),
      }),
    );
    child.once?.('close', (code: number | null) => {
      if (overflow) {
        finish({ ok: false, diagnostic: 'AGY model catalog probe exceeded the output limit' });
      } else if (code !== 0) {
        finish({
          ok: false,
          diagnostic: catalogDiagnostic(
            stderr.toString('utf8') || `AGY model catalog probe exited ${code}`,
          ),
        });
      } else {
        finish({ ok: true, ids: vendorModelIds(stdout.toString('utf8')) });
      }
    });
  });
}

export interface SelectConfigOption {
  id: string;
  name: string;
  category: string;
  type: 'select';
  currentValue: string;
  options: Array<{ value: string; name: string }>;
}

export function configOptions(
  session: Pick<AgySession, 'model' | 'effort' | 'modelChoices' | 'accountBound' | 'permissionMode'>,
): SelectConfigOption[] {
  const effort = encodedEffort(session.model);
  const options: SelectConfigOption[] = [
    {
      id: 'effort',
      name: 'AGY effort',
      category: 'thought_level',
      type: 'select',
      currentValue: session.effort,
      options: [
        { value: DEFAULT, name: 'Follow AGY settings' },
        ...(effort ? [{ value: effort, name: effort }] : []),
      ],
    },
  ];
  if (Array.isArray(session.modelChoices)) {
    options.push({
      id: 'model',
      name: 'AGY model',
      category: 'model',
      type: 'select',
      currentValue: session.model,
      options:
        session.modelChoices.length === 0
          ? []
          : [
              ...(session.accountBound ? [] : [{ value: DEFAULT, name: 'Follow AGY settings' }]),
              ...session.modelChoices.map((id) => ({ value: id, name: id })),
            ],
    });
  }
  options.push({
    id: 'native-agent',
    name: 'AGY native agent',
    category: 'native_agent',
    type: 'select',
    currentValue: DEFAULT,
    options: [{ value: DEFAULT, name: 'Follow AGY default agent' }],
  });
  options.push({
    id: 'permission-mode',
    name: 'AGY permissions',
    category: 'permission_mode',
    type: 'select',
    currentValue: session.permissionMode ?? DEFAULT,
    options: [
      { value: DEFAULT, name: 'Follow AGY settings' },
      { value: 'manual', name: 'Request review' },
      { value: 'auto', name: 'AGY auto mode' },
      { value: 'yolo', name: 'Full access' },
    ],
  });
  return options;
}

export async function terminate(child: ChildProcess | undefined): Promise<void> {
  const running = (): boolean =>
    child?.pid !== undefined && child.exitCode === null && child.signalCode === null;
  if (!running() || !child) return;
  let onClose!: () => void;
  const closed = new Promise<void>((done) => {
    onClose = done;
    child.once('close', onClose);
  });
  try {
    if (process.platform === 'win32') {
      const killer = spawn(
        resolve(process.env['SystemRoot'] ?? 'C:/Windows', 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      await new Promise<void>((done, reject) => {
        killer.once('error', reject);
        killer.once('close', (code, signal) =>
          code === 0 ? done() : reject(new Error(`taskkill exited with ${code ?? signal}`)),
        );
      });
    } else if (!child.kill('SIGTERM')) {
      throw new Error('SIGTERM was not delivered');
    }
  } catch (error) {
    if (running()) {
      child.off('close', onClose);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not stop the owned AGY process: ${message}`, { cause: error });
    }
  }
  await closed;
}

export function consumeAccountEnvironment(env: NodeJS.ProcessEnv = process.env): AgyAccountConfig {
  const apiKey = env['GEMINI_API_KEY'];
  const baseUrl = env['GOOGLE_GEMINI_BASE_URL'];
  const rawModels = env['KIKI_AGY_ACCOUNT_MODELS'];
  delete env['GEMINI_API_KEY'];
  delete env['GOOGLE_GEMINI_BASE_URL'];
  delete env['KIKI_AGY_ACCOUNT_MODELS'];
  const modelIds: unknown = JSON.parse(rawModels ?? 'null');
  if (
    typeof apiKey !== 'string' ||
    !apiKey ||
    typeof baseUrl !== 'string' ||
    !/^https?:\/\//.test(baseUrl) ||
    !Array.isArray(modelIds) ||
    modelIds.length === 0 ||
    modelIds.some((id) => typeof id !== 'string' || !id || /\s/.test(id) || id === DEFAULT)
  ) {
    throw new Error('The selected account connection is unavailable; no global AGY fallback is allowed');
  }
  return { apiKey, baseUrl, modelIds: modelIds as string[] };
}
