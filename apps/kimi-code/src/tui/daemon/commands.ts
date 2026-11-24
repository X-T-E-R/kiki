import { buildSkillSlashItems } from '@kiki/session-core/commands/slashCommands';
import type { SkillDescriptor } from '@kiki/protocol';
import type {
  SlashArgumentCompleter,
  SlashArgumentHintProvider,
  SlashAutocompleteCommand,
} from '#/tui/components/editor/file-mention-provider';

export type DaemonCommandName =
  | 'exit'
  | 'stop'
  | 'queue'
  | 'unqueue'
  | 'mouse'
  | 'screen'
  | 'palette'
  | 'find'
  | 'context'
  | 'expand'
  | 'todos'
  | 'sessions'
  | 'new'
  | 'agent'
  | 'persona'
  | 'model'
  | 'permission'
  | 'yolo'
  | 'auto'
  | 'plan'
  | 'agents'
  | 'agent-transcript'
  | 'effort'
  | 'title'
  | 'status'
  | 'usage'
  | 'compact'
  | 'tasks'
  | 'fork'
  | 'plugins'
  | 'provider'
  | 'reload'
  | 'login'
  | 'logout'
  | 'mcp'
  | 'goal'
  | 'settings'
  | 'undo'
  | 'attach'
  | 'experiments'
  | 'export-view'
  | 'btw'
  | 'branch'
  | 'merge'
  | 'copy'
  | 'editor'
  | 'init'
  | 'theme'
  | 'help'
  | 'version'
  | 'web';

type DaemonCommandArgument = 'none' | 'optional-one' | 'optional-rest' | 'permission';

export type DaemonCommandCompletionDisposition =
  | 'none'
  | 'finite'
  | 'structured'
  | 'path'
  | 'freeform-guarded'
  | 'freeform-hint'
  | 'prompt-mentions';

export interface DaemonCommandDefinition {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly status: 'supported' | 'disabled';
  readonly argument?: DaemonCommandArgument;
  readonly argumentHint?: string;
  readonly completion?: DaemonCommandCompletionDisposition;
}

export interface ResolvedDaemonCommand {
  readonly definition: DaemonCommandDefinition;
  readonly name: DaemonCommandName;
  readonly invokedAs: string;
  readonly args: string;
}

export interface DaemonSkillCommand {
  readonly commandName: string;
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
}

export function daemonSkillCommands(skills: readonly SkillDescriptor[]): DaemonSkillCommand[] {
  return buildSkillSlashItems(
    skills,
    DAEMON_COMMANDS.flatMap((command) => [command.name, ...command.aliases]),
  ).filter((item) => item.disabled !== true).map((item) => ({
    commandName: item.name,
    name: item.skill!.name,
    description: `[${item.skill!.source}] ${item.description}`,
    argumentHint: item.skill!.argument_hint,
  }));
}

export interface DaemonSlashInput {
  readonly token: string;
  readonly rawToken: string;
  readonly args: string;
}

const EXPORT_VIEW_DESCRIPTION = 'Export loaded user and assistant text as Markdown';

const SUPPORTED_COMMANDS = [
  command('exit', ['quit', 'q'], 'Exit the application', 'none', undefined, 'none'),
  // Keyboard-free equivalents of Esc, Ctrl+O and Ctrl+T, for phone keyboards
  // and terminals without Esc or Ctrl keys.
  command('stop', ['interrupt'], 'Interrupt the running turn (same as Esc)', 'none', undefined, 'none'),
  command('queue', [], 'Queue a prompt for the next turn without interrupting', 'optional-rest', '<prompt>', 'prompt-mentions'),
  command('unqueue', [], 'Withdraw the last queued message and put it back in the input box', 'none', undefined, 'none'),
  command('mouse', [], 'Toggle SGR mouse reporting or set on/off (same as Alt+M)', 'optional-one', '[on|off]', 'finite'),
  command('screen', ['tui'], 'Switch screen mode between alt (fullscreen) and main (native scrollback)', 'optional-one', '[alt|main]', 'finite'),
  command('palette', [], 'Open the unified command and settings palette (same as Ctrl+P)', 'none', undefined, 'none'),
  command('find', [], 'Search the rendered transcript (same as Ctrl+Shift+F)', 'none', undefined, 'none'),
  command('context', [], 'Show estimated context window breakdown', 'none', undefined, 'none'),
  command('expand', ['output'], 'Expand or collapse tool output (same as Ctrl+O)', 'none', undefined, 'none'),
  command('todos', [], 'Expand or collapse a truncated todo list (same as Ctrl+T)', 'none', undefined, 'none'),
  command('sessions', ['resume'], 'Browse and resume sessions', 'none', undefined, 'none'),
  command('new', ['clear'], 'Start a fresh session in the current workspace', 'none', undefined, 'none'),
  command('agent', [], 'Select the agent profile for new sessions', 'optional-one', '[name]', 'finite'),
  command('persona', [], 'List personas or start a new session with one', 'optional-rest', '[list|switch <id>]', 'structured'),
  command('model', [], 'Switch LLM model', 'optional-one', '[model]', 'finite'),
  command('permission', [], 'Select permission mode', 'permission', '[manual|auto|review|yolo]', 'finite'),
  command('yolo', ['yes'], 'Toggle YOLO mode', 'none', undefined, 'none'),
  command('auto', [], 'Toggle Auto mode', 'none', undefined, 'none'),
  command('plan', [], 'Toggle plan mode', 'none', undefined, 'none'),
  command('agents', [], 'Browse agents and open a transcript', 'none', undefined, 'none'),
  command('agent-transcript', [], 'Show an agent transcript', 'optional-one', '[agent-id]', 'finite'),
  command('effort', ['thinking'], 'Switch thinking effort', 'optional-one', '[effort]', 'finite'),
  command('title', ['rename'], 'Set or show session title', 'optional-rest', '[title]', 'freeform-hint'),
  command('status', [], 'Show current session and runtime status', 'none', undefined, 'none'),
  command('usage', [], 'Show session token usage', 'none', undefined, 'none'),
  command('compact', [], 'Compact the conversation context', 'optional-rest', '[instruction]', 'freeform-hint'),
  command('tasks', ['task'], 'Browse background tasks', 'optional-rest', '[stop|output] [task-id]', 'structured'),
  command('fork', [], 'Fork the current session', 'optional-rest', '[title]', 'freeform-hint'),
  command('plugins', [], 'Manage plugins (install --trust consents to full account permissions)', 'optional-rest', '[marketplace|install [--trust] <source>|enable|disable|remove|reload]', 'structured'),
  command('provider', ['providers'], 'Manage AI providers', 'optional-rest', '[add|remove|refresh]', 'structured'),
  command('reload', [], 'Reload daemon configuration and plugins', 'none', undefined, 'none'),
  command('login', [], 'Authenticate a provider', 'optional-one', '[provider]', 'finite'),
  command('logout', ['disconnect'], 'Log out of a configured provider', 'optional-one', '[provider]', 'finite'),
  command('mcp', [], 'Manage MCP servers and session overrides', 'none', undefined, 'none'),
  command('goal', [], 'Start or manage an autonomous goal', 'optional-rest', '[objective|pause|resume|cancel]', 'freeform-guarded'),
  command('settings', ['config'], 'Inspect or update daemon configuration', 'optional-rest', '[domain] [json]', 'structured'),
  command('undo', ['rewind'], 'Rewind, jump, or fork an earlier turn', 'none', undefined, 'none'),
  command('attach', [], 'Attach a local file to the next prompt', 'optional-rest', '<path>', 'path'),
  command('experiments', ['experimental'], 'Toggle experimental features', 'none', undefined, 'none'),
  command('export-view', ['export'], EXPORT_VIEW_DESCRIPTION, 'optional-rest', '[path]', 'path'),
  command('btw', [], 'Ask a read-only in-session branch a question', 'optional-rest', '<question>', 'prompt-mentions'),
  command('branch', [], 'Open or switch to an in-session branch', 'optional-rest', '[task]', 'freeform-guarded'),
  command('merge', ['fold'], 'Fold the active branch back into main', 'optional-rest', '[summary]', 'freeform-hint'),
  command('copy', [], 'Copy the Nth latest assistant response or code block', 'optional-one', '[N]', 'finite'),
  command('editor', [], 'Set the external editor for this TUI session', 'optional-rest', '[command]', 'freeform-hint'),
  command('init', [], 'Analyze the codebase and generate AGENTS.md', 'none', undefined, 'none'),
  command('theme', [], 'Set the theme for this TUI session', 'optional-one', '[dark|light|auto]', 'finite'),
  command('help', ['h', '?'], 'Show commands and keyboard shortcuts', 'none', undefined, 'none'),
  command('version', [], 'Show version information', 'none', undefined, 'none'),
  command('web', [], 'Manage browser access without leaving the TUI', 'optional-rest', '[temporary|persistent|status|off|link|revoke [id]] [--host <host>] [--port <port>] [--public-url <url>] [--insecure-no-tls] [--no-open]', 'structured'),
] as const satisfies readonly DaemonCommandDefinition[];

const DISABLED_COMMANDS = [
  disabled('add-dir', [], 'Start a session with another directory; use the kiki --add-dir startup flag'),
  disabled('export-md', [], 'Export the session as a ZIP archive; use kiki export in a terminal'),
  disabled('export-debug-zip', [], 'Export the session as a ZIP archive; use kiki export in a terminal'),
  disabled('reload-tui', [], 'Reload TUI preferences'),
] as const satisfies readonly DaemonCommandDefinition[];

export const DAEMON_COMMANDS: readonly DaemonCommandDefinition[] = [
  ...SUPPORTED_COMMANDS,
  ...DISABLED_COMMANDS,
];

const COMMAND_BY_TOKEN = new Map<string, DaemonCommandDefinition>();
for (const definition of DAEMON_COMMANDS) {
  COMMAND_BY_TOKEN.set(definition.name, definition);
  for (const alias of definition.aliases) COMMAND_BY_TOKEN.set(alias, definition);
}

export function parseDaemonSlashInput(text: string): DaemonSlashInput {
  const body = text.slice(1);
  const tokenEnd = body.search(/\s/u);
  const rawToken = tokenEnd === -1 ? body : body.slice(0, tokenEnd);
  return {
    token: rawToken.toLowerCase(),
    rawToken,
    args: tokenEnd === -1 ? '' : body.slice(tokenEnd).trim(),
  };
}

export function resolveDaemonCommand(
  token: string,
  args: string,
): ResolvedDaemonCommand | DaemonCommandDefinition | undefined {
  const invokedAs = token.toLowerCase();
  const definition = COMMAND_BY_TOKEN.get(invokedAs);
  if (definition === undefined || definition.status === 'disabled') return definition;
  return {
    definition,
    name: definition.name as DaemonCommandName,
    invokedAs,
    args,
  };
}

export function validateDaemonCommandArgs(command: ResolvedDaemonCommand): string | undefined {
  const args = command.args.trim();
  switch (command.definition.argument ?? 'none') {
    case 'none':
      return args === '' ? undefined : `/${command.invokedAs} does not accept arguments.`;
    case 'optional-one':
      return args === '' || !/\s/u.test(args)
        ? undefined
        : `/${command.invokedAs} accepts at most one argument.`;
    case 'optional-rest':
      return undefined;
    case 'permission':
      return args === '' || args === 'manual' || args === 'auto' || args === 'review' || args === 'yolo'
        ? undefined
        : `/${command.invokedAs} expects manual, auto, review, or yolo.`;
  }
}

/**
 * High-frequency workflow commands surfaced in bare `/` autocomplete, in workflow
 * order (18 commands). Typing any query after `/` searches the full catalog
 * (all supported commands, skills, and agent profiles).
 */
const PRIMARY_COMMAND_ORDER: readonly DaemonCommandName[] = [
  'model',
  'effort',
  'plan',
  'permission',
  'sessions',
  'new',
  'compact',
  'undo',
  'stop',
  'queue',
  'tasks',
  'agents',
  'goal',
  'usage',
  'status',
  'settings',
  'mouse',
  'help',
];
const PRIMARY_ORDER_MAP = new Map<string, number>(
  PRIMARY_COMMAND_ORDER.map((name, index) => [name, index]),
);

export interface DaemonAutocompleteBindings {
  readonly argumentCompleters?: ReadonlyMap<string, SlashArgumentCompleter>;
  readonly argumentHintProviders?: ReadonlyMap<string, SlashArgumentHintProvider>;
}

export function daemonAutocompleteCommands(
  skills: ReadonlyMap<string, DaemonSkillCommand>,
  agentProfiles: ReadonlyMap<string, string>,
  bindings?: DaemonAutocompleteBindings,
): SlashAutocompleteCommand[] {
  // Disabled entries stay in `DAEMON_COMMANDS` / `resolveDaemonCommand` (so
  // typing one explicitly yields a clear explanation and `/help` still lists
  // them), while the interactive `/` popup only surfaces usable commands.
  const builtins = SUPPORTED_COMMANDS.map((definition) => ({
    name: definition.name,
    aliases: [...definition.aliases],
    description: definition.description,
    argumentHint: definition.argumentHint,
    kind: 'command' as const,
    primary: PRIMARY_ORDER_MAP.has(definition.name),
    primaryOrder: PRIMARY_ORDER_MAP.get(definition.name),
    getStructuredArgumentCompletions: bindings?.argumentCompleters?.get(definition.name),
    getInlineArgumentHint: bindings?.argumentHintProviders?.get(definition.name),
  }));
  const dynamic = [
    ...[...skills.values()].map((skill) => ({
      name: skill.commandName,
      aliases: [],
      description: skill.description,
      argumentHint: skill.argumentHint ?? '[arguments]',
      kind: 'skill' as const,
    })),
    ...[...agentProfiles.values()].map((name) => ({
      name,
      aliases: [],
      description: `Run a prompt with the ${name} agent profile`,
      argumentHint: '<prompt>',
      kind: 'agent' as const,
      requiresPrompt: true,
    })),
  ].filter((command) => !COMMAND_BY_TOKEN.has(command.name.toLowerCase()));
  return [...builtins, ...dynamic];
}

/** Display model for the interactive `/help` panel (grouped, coloured layout). */
export interface DaemonHelpCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly argumentHint?: string;
  readonly disabled: boolean;
}

export function daemonHelpCommands(): DaemonHelpCommand[] {
  return DAEMON_COMMANDS.map((definition) => ({
    name: definition.name,
    aliases: definition.aliases,
    description: definition.description,
    argumentHint: definition.argumentHint,
    disabled: definition.status === 'disabled',
  }));
}

/**
 * Discovery note shown under the `/help` command list: skill and agent-profile
 * commands are dynamic, so the panel points at the `/` autocomplete catalog
 * instead of snapshotting them.
 */
export const DAEMON_HELP_DISCOVERY_NOTE =
  'Skills and agent profiles: type / in the input box to browse the current catalog.';

function command(
  name: DaemonCommandName,
  aliases: readonly string[],
  description: string,
  argument: DaemonCommandArgument,
  argumentHint?: string,
  completion: DaemonCommandCompletionDisposition = argument === 'none' ? 'none' : 'freeform-hint',
): DaemonCommandDefinition {
  return { name, aliases, description, status: 'supported', argument, argumentHint, completion };
}

function disabled(
  name: string,
  aliases: readonly string[],
  description: string,
): DaemonCommandDefinition {
  return { name, aliases, description, status: 'disabled' };
}
