import { readFile } from 'node:fs/promises';
import { join, resolve } from 'pathe';
import { parse as parseToml } from 'smol-toml';
import { Command, Option } from 'commander';
import {
  analyzeBashCommand,
  matchBashPattern,
  matchesBashRuleSubject,
  parseAgentFileText,
  parsePattern,
  resolveKikiHome,
  type PermissionMode,
} from '@kiki/node-sdk';

interface PermissionRuleRecord {
  readonly decision: 'allow' | 'deny' | 'ask';
  readonly scope: string;
  readonly pattern: string;
  readonly reason?: string;
  readonly file: string;
}

interface PermissionTestOptions {
  readonly permissionMode?: PermissionMode | 'default';
  readonly agentFile?: string;
  readonly json?: boolean;
}

const MODES = ['manual', 'auto', 'review', 'yolo'] as const;

export function registerPermissionCommand(program: Command): void {
  const permission = program.command('permission').description('Inspect and test permission rules.');
  permission
    .command('test <pattern>')
    .description('Dry-run a permission pattern against the current KIKI_HOME and workspace rules.')
    .addOption(new Option('--permission-mode <mode>', 'Simulated mode.').choices(['default', ...MODES]))
    .option('--agent-file <path>', 'Read permission_mode from this profile file.')
    .option('--json', 'Print machine-readable JSON.')
    .action(async (pattern: string, options: PermissionTestOptions) => {
      await runPermissionTest(pattern, options);
    });
}

async function runPermissionTest(pattern: string, options: PermissionTestOptions): Promise<void> {
  const command = parseBashPatternSubject(pattern);
  const homeDir = resolveKikiHome();
  const workspace = resolve(process.cwd());
  const rules = await readPermissionRules(homeDir, workspace);
  const profile = options.agentFile === undefined ? undefined : await readProfile(options.agentFile, workspace);
  const configuredMode = await readConfiguredMode(homeDir);
  const modeSource = options.permissionMode !== undefined
    ? 'cli'
    : profile?.permissionMode !== undefined
      ? 'profile'
      : configuredMode !== undefined
        ? 'config'
        : 'default';
  const mode = normalizeMode(options.permissionMode ?? profile?.permissionMode ?? configuredMode ?? 'auto');
  const analysis = analyzeBashCommand(command);
  const matches = rules
    .map((rule) => ({
      ...rule,
      matched: matchesRule(rule, command),
      segments: analysis.segments
        .filter((segment) => matchesRuleAgainstText(rule, segment.text))
        .map((segment) => segment.text),
    }))
    .filter((rule) => rule.matched);
  const deny = matches.filter((rule) => rule.decision === 'deny');
  const ask = matches.filter((rule) => rule.decision === 'ask');
  const allow = matches.filter((rule) => rule.decision === 'allow');
  const result = deny.length > 0
    ? 'deny'
    : ask.length > 0
      ? 'deny'
      : mode === 'auto' || mode === 'yolo'
        ? 'approve'
        : allow.length > 0
          ? 'approve'
          : 'deny';
  const payload = {
    pattern,
    command,
    mode,
    modeSource,
    result,
    nonInteractive: true,
    parse: { reliable: analysis.reliable, segments: analysis.segments.map((segment) => segment.text) },
    matchedRules: matches.map(({ decision, scope, pattern: rulePattern, reason, file, segments }) => ({
      decision,
      scope,
      pattern: rulePattern,
      reason,
      file,
      segments,
    })),
    reason: result === 'deny'
      ? deny[0]?.reason ?? (ask.length > 0 || (allow.length === 0 && mode !== 'auto' && mode !== 'yolo')
        ? 'requires approval; non-interactive run denied (use an allow rule or --permission-mode auto)'
        : undefined)
      : undefined,
  };
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`mode: ${mode} (source: ${modeSource})\n`);
  process.stdout.write(`result: ${result}\n`);
  process.stdout.write(`parse: ${analysis.reliable ? 'reliable' : 'unreliable'}\n`);
  for (const [index, segment] of analysis.segments.entries()) {
    process.stdout.write(`segment ${String(index + 1)}: ${JSON.stringify(segment.text)}\n`);
  }
  if (matches.length === 0) {
    process.stdout.write('matched rules: none\n');
  } else {
    process.stdout.write('matched rules:\n');
    for (const match of matches) {
      const suffix = match.segments.length === 0 ? '' : ` segments=${JSON.stringify(match.segments)}`;
      process.stdout.write(`- ${match.decision} ${match.pattern} [scope=${match.scope}, file=${match.file}]${suffix}\n`);
    }
  }
  if (payload.reason !== undefined) process.stdout.write(`reason: ${payload.reason}\n`);
}

function parseBashPatternSubject(pattern: string): string {
  const parsed = parsePattern(pattern);
  if (parsed.toolName !== 'Bash' || parsed.argPattern === undefined) {
    throw new Error('permission test expects a Bash(command) pattern.');
  }
  return parsed.argPattern;
}

function matchesRule(rule: PermissionRuleRecord, command: string): boolean {
  const parsed = parsePattern(rule.pattern);
  if (parsed.toolName !== 'Bash' && parsed.toolName !== '*') return false;
  if (parsed.argPattern === undefined) return true;
  return matchesBashRuleSubject(parsed.argPattern, command, rule.decision === 'allow' ? 'all' : 'any');
}

function matchesRuleAgainstText(rule: PermissionRuleRecord, text: string): boolean {
  const parsed = parsePattern(rule.pattern);
  if (parsed.argPattern === undefined) return true;
  return matchBashPattern(parsed.argPattern, text);
}

async function readPermissionRules(homeDir: string, workspace: string): Promise<PermissionRuleRecord[]> {
  const paths = [join(homeDir, 'config.toml'), join(workspace, '.kiki', 'config.toml')];
  const rules: PermissionRuleRecord[] = [];
  for (const file of paths) {
    let raw: Record<string, unknown>;
    try {
      raw = parseToml(await readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const permission = raw['permission'];
    if (!isRecord(permission)) continue;
    appendRules(rules, permission['rules'], undefined, file);
    appendRules(rules, permission['deny'], 'deny', file);
    appendRules(rules, permission['ask'], 'ask', file);
    appendRules(rules, permission['allow'], 'allow', file);
  }
  return rules;
}

function appendRules(
  output: PermissionRuleRecord[],
  value: unknown,
  decision: PermissionRuleRecord['decision'] | undefined,
  file: string,
): void {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const selectedDecision = decision ?? asDecision(entry['decision']);
    const pattern = typeof entry['pattern'] === 'string'
      ? entry['pattern']
      : typeof entry['tool'] === 'string'
        ? `${entry['tool']}${typeof entry['match'] === 'string' ? `(${entry['match']})` : ''}`
        : undefined;
    if (selectedDecision === undefined || pattern === undefined) continue;
    output.push({
      decision: selectedDecision,
      scope: typeof entry['scope'] === 'string' ? entry['scope'] : 'user',
      pattern,
      reason: typeof entry['reason'] === 'string' ? entry['reason'] : undefined,
      file,
    });
  }
}

async function readConfiguredMode(homeDir: string): Promise<PermissionMode | undefined> {
  try {
    const raw = parseToml(await readFile(join(homeDir, 'config.toml'), 'utf8')) as Record<string, unknown>;
    const value = raw['default_permission_mode'];
    return value === 'manual' || value === 'auto' || value === 'review' || value === 'yolo' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readProfile(path: string, workspace: string) {
  const file = resolve(workspace, path);
  return parseAgentFileText({ path: file, source: 'explicit', text: await readFile(file, 'utf8') });
}

function normalizeMode(value: unknown): PermissionMode {
  return value === 'manual' || value === 'auto' || value === 'review' || value === 'yolo' ? value : 'manual';
}

function asDecision(value: unknown): PermissionRuleRecord['decision'] | undefined {
  return value === 'allow' || value === 'deny' || value === 'ask' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
