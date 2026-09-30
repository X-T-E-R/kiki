import { mkdtemp, mkdir, writeFile, readdir, symlink, copyFile, rm, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function codexHookConfig(hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>) {
  const state: Record<string, { trusted_hash: string }> = {};
  const source = process.platform === 'win32' ? 'C:\\<session-flags>\\config.toml' : '/<session-flags>/config.toml';
  for (const [event, groups] of Object.entries(hooks)) {
    const label = event.replaceAll(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    groups.forEach((group, groupIndex) => {
      group.hooks.forEach((handler, handlerIndex) => {
        const identity = { event_name: label, hooks: [{ async: false, command: handler.command, timeout: handler.timeout, type: handler.type }] };
        const hash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
        state[`${source}:${label}:${groupIndex}:${handlerIndex}`] = { trusted_hash: `sha256:${hash}` };
      });
    });
  }
  return { ...hooks, state };
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}=${tomlValue(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

export const HARNESS_HOOK_SCRIPT = `
const [harness, event] = process.argv.slice(2);
let stdin = '';
for await (const chunk of process.stdin) { stdin += chunk; if (stdin.length > 1048576) process.exit(1); }
try {
  const response = await fetch(process.env.KIKI_KAP_ENDPOINT + '/api/klient/delegation/context/hook', {
    method: 'POST', headers: { authorization: 'Bearer ' + process.env.KIKI_DELEGATION_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ harness, event, compact: event === 'SessionStart' && JSON.parse(stdin || '{}').source === 'compact' }), signal: AbortSignal.timeout(10000),
  });
  const envelope = await response.json();
  if (!response.ok || envelope.code !== 0) process.exit(1);
  const content = envelope.data.content;
  const output = !content ? {} : harness === 'antigravity'
    ? { injectSteps: [{ userMessage: content }] }
    : { hookSpecificOutput: { hookEventName: event, additionalContext: content } };
  process.stdout.write(JSON.stringify(output) + '\\n');
} catch { process.exit(1); }
`;

export interface HarnessHookLease {
  readonly processEnv?: Record<string, string>;
  readonly processArgs?: readonly string[];
  readonly sessionMeta?: Record<string, unknown>;
  dispose(): Promise<void>;
}

export async function createHarnessHooks(executorId: string): Promise<HarnessHookLease> {
  const harness = executorId.startsWith('claude') ? 'claude' : executorId.startsWith('codex') ? 'codex' :
    executorId.startsWith('antigravity') ? 'antigravity' : executorId.startsWith('grok') ? 'grok' : undefined;
  if (harness === undefined) throw new Error('Kiki hooks are not supported for this harness');
  if (harness === 'grok') return {
    sessionMeta: { 'x.ai/hooks': { Stop: [{ hookCallbackIds: ['kiki-context'], timeout: 15 }] } },
    dispose: async () => {},
  };
  const directory = await mkdtemp(join(tmpdir(), 'kiki-context-hooks-'));
  try {
    const script = join(directory, 'context-hook.mjs');
    await writeFile(script, HARNESS_HOOK_SCRIPT, { mode: 0o600 });
    const command = (event: string) => `node "${script.replaceAll('\\', '/')}" ${harness} ${event}`;
    const hooks = Object.fromEntries((harness === 'antigravity' ? ['PreInvocation'] : ['SessionStart', 'UserPromptSubmit', 'PreCompact'])
      .map((event) => [event, [{ hooks: [{ type: 'command', command: command(event), timeout: 15 }] }]]));
    const dispose = () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (harness === 'claude') {
      const settings = join(directory, 'settings.json');
      await writeFile(settings, JSON.stringify({ hooks }), { mode: 0o600 });
      return { sessionMeta: { claudeCode: { options: { settings } } }, dispose };
    }
    if (harness === 'codex') {
      await writeFile(join(directory, 'hooks.json'), JSON.stringify({ hooks }), { mode: 0o600 });
      const config = codexHookConfig(hooks);
      if (executorId === 'codex-acp') {
        const prior = JSON.parse(process.env['CODEX_CONFIG'] ?? '{}') as Record<string, unknown>;
        if ('hooks' in prior) throw new Error('CODEX_CONFIG already defines session hooks');
        return { processEnv: { CODEX_CONFIG: JSON.stringify({ ...prior, hooks: config }) }, dispose };
      }
      return { processArgs: ['-c', `hooks=${tomlValue(config)}`], dispose };
    }
    const homeOverride = process.env['GEMINI_HOME'];
    const configuredHome = homeOverride === undefined || homeOverride.length === 0 ? join(homedir(), '.gemini') : homeOverride;
    const original = configuredHome === '~' ? homedir() : /^[~][/\\]/.test(configuredHome) ? join(homedir(), configuredHome.slice(2)) : configuredHome;
    const geminiHome = join(directory, 'gemini');
    await mkdir(join(geminiHome, 'config'), { recursive: true });
    for (const entry of await readdir(original, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === 'config') continue;
      const source = join(original, entry.name);
      const target = join(geminiHome, entry.name);
      if (entry.isDirectory()) await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
      else if (entry.isFile()) await copyFile(source, target);
    }
    for (const entry of await readdir(join(original, 'config'), { withFileTypes: true }).catch(() => [])) {
      if (entry.name === 'hooks.json') continue;
      const source = join(original, 'config', entry.name);
      const target = join(geminiHome, 'config', entry.name);
      if (entry.isDirectory()) await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
      else if (entry.isFile()) await copyFile(source, target);
    }
    const prior = JSON.parse(await readFile(join(original, 'config', 'hooks.json'), 'utf8').catch(() => '{}')) as Record<string, unknown>;
    if ('kiki-context' in prior) throw new Error('The reserved Kiki context hook name is already configured');
    await writeFile(join(geminiHome, 'config', 'hooks.json'), JSON.stringify({ ...prior, 'kiki-context': { enabled: true, ...hooks } }), { mode: 0o600 });
    return { processEnv: { GEMINI_HOME: geminiHome }, dispose };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
