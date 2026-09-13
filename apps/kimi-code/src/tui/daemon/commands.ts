import { buildSkillSlashItems } from '@kiki/session-core/commands/slashCommands';
import type { SkillDescriptor } from '@kiki/protocol';
import type { SlashAutocompleteCommand } from '#/tui/components/editor/file-mention-provider';

export type DaemonCommandName =
  | 'exit'
  | 'sessions'
  | 'new'
  | 'agent'
  | 'model'
  | 'permission'
  | 'yolo'
  | 'auto'
  | 'plan'
  | 'swarm'
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
  | 'copy'
  | 'editor'
  | 'init'
  | 'theme'
  | 'help'
  | 'version';

type DaemonCommandArgument = 'none' | 'optional-one' | 'optional-rest' | 'permission';

export interface DaemonCommandDefinition {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly status: 'supported' | 'disabled';
  readonly argument?: DaemonCommandArgument;
  readonly argumentHint?: string;
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
  command('exit', ['quit', 'q'], 'Exit the application', 'none'),
  command('sessions', ['resume'], 'Browse and resume sessions', 'none'),
  command('new', ['clear'], 'Start a fresh session in the current workspace', 'none'),
  command('agent', [], 'Select the agent profile for new sessions', 'optional-one', '[name]'),
  command('model', [], 'Switch LLM model', 'optional-one', '[model]'),
  command('permission', [], 'Select permission mode', 'permission', '[manual|yolo|auto]'),
  command('yolo', ['yes'], 'Toggle YOLO mode', 'none'),
  command('auto', [], 'Toggle Auto mode', 'none'),
  command('plan', [], 'Toggle plan mode', 'none'),
  command('swarm', [], 'Toggle swarm mode', 'none'),
  command('agents', [], 'List agents in the current session', 'none'),
  command('agent-transcript', [], 'Show an agent transcript', 'optional-one', '[agent-id]'),
  command('effort', ['thinking'], 'Switch thinking effort', 'optional-one', '[effort]'),
  command('title', ['rename'], 'Set or show session title', 'optional-rest', '[title]'),
  command('status', [], 'Show current session and runtime status', 'none'),
  command('usage', [], 'Show session token usage', 'none'),
  command('compact', [], 'Compact the conversation context', 'optional-rest', '[instruction]'),
  command('tasks', ['task'], 'Browse background tasks', 'optional-rest', '[stop|output] [task-id]'),
  command('fork', [], 'Fork the current session', 'optional-rest', '[title]'),
  command('plugins', [], 'Manage plugins', 'optional-rest', '[marketplace|install|enable|disable|remove|reload]'),
  command('provider', ['providers'], 'Manage AI providers', 'optional-rest', '[add|remove|refresh]'),
  command('reload', [], 'Reload daemon configuration and plugins', 'none'),
  command('login', [], 'Authenticate a provider', 'optional-one', '[provider]'),
  command('logout', ['disconnect'], 'Log out of a configured provider', 'optional-one', '[provider]'),
  command('mcp', [], 'Show MCP server status', 'none'),
  command('goal', [], 'Start or manage an autonomous goal', 'optional-rest', '[objective|pause|resume|cancel]'),
  command('settings', ['config'], 'Inspect or update daemon configuration', 'optional-rest', '[domain] [json]'),
  command('undo', [], 'Withdraw the last prompt', 'none'),
  command('attach', [], 'Attach a local file to the next prompt', 'optional-rest', '<path>'),
  command('experiments', ['experimental'], 'List experimental features (read-only)', 'none'),
  command('export-view', ['export'], EXPORT_VIEW_DESCRIPTION, 'optional-rest', '[path]'),
  command('btw', [], 'Ask a forked side agent a question', 'optional-rest', '<question>'),
  command('copy', [], 'Copy the last assistant message to the clipboard', 'none'),
  command('editor', [], 'Set the external editor for this TUI session', 'optional-rest', '[command]'),
  command('init', [], 'Analyze the codebase and generate AGENTS.md', 'none'),
  command('theme', [], 'Set the theme for this TUI session', 'optional-one', '[dark|light|auto]'),
  command('help', ['h', '?'], 'Show daemon TUI command support', 'none'),
  command('version', [], 'Show version information', 'none'),
] as const satisfies readonly DaemonCommandDefinition[];

const DISABLED_COMMANDS = [
  disabled('add-dir', [], 'Add a directory to the current workspace'),
  disabled('export-md', [], 'Export the complete session as Markdown'),
  disabled('export-debug-zip', [], 'Export current session as a debug ZIP archive'),
  disabled('reload-tui', [], 'Reload TUI preferences'),
  disabled('web', [], 'Open the current session in the Web UI'),
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
      return args === '' || args === 'manual' || args === 'yolo' || args === 'auto'
        ? undefined
        : `/${command.invokedAs} expects manual, yolo, or auto.`;
  }
}

export function daemonAutocompleteCommands(
  skills: ReadonlyMap<string, DaemonSkillCommand>,
  agentProfiles: ReadonlyMap<string, string>,
): SlashAutocompleteCommand[] {
  const builtins = DAEMON_COMMANDS.map((definition) => ({
    name: definition.name,
    aliases: [...definition.aliases],
    description: `[${definition.status} in daemon TUI] ${definition.description}`,
    argumentHint: definition.argumentHint,
  }));
  const dynamic = [
    ...[...skills.values()].map((skill) => ({
      name: skill.commandName,
      aliases: [],
      description: skill.description,
      argumentHint: skill.argumentHint ?? '[arguments]',
    })),
    ...[...agentProfiles.values()].map((name) => ({
      name,
      aliases: [],
      description: `Run a prompt with the ${name} agent profile`,
      argumentHint: '<prompt>',
    })),
  ].filter((command) => !COMMAND_BY_TOKEN.has(command.name.toLowerCase()));
  return [...builtins, ...dynamic];
}

export function daemonCommandHelp(): string {
  const supported = SUPPORTED_COMMANDS.map(formatCommand).join(', ');
  const disabled = DISABLED_COMMANDS.map(formatCommand).join(', ');
  return `Daemon TUI commands\nSupported: ${supported}\n${EXPORT_VIEW_DESCRIPTION}\nDisabled: ${disabled}`;
}

function command(
  name: DaemonCommandName,
  aliases: readonly string[],
  description: string,
  argument: DaemonCommandArgument,
  argumentHint?: string,
): DaemonCommandDefinition {
  return { name, aliases, description, status: 'supported', argument, argumentHint };
}

function disabled(
  name: string,
  aliases: readonly string[],
  description: string,
): DaemonCommandDefinition {
  return { name, aliases, description, status: 'disabled' };
}

function formatCommand(command: DaemonCommandDefinition): string {
  const aliases = command.aliases.map((alias) => `/${alias}`).join(', ');
  return aliases === '' ? `/${command.name}` : `/${command.name} (${aliases})`;
}
