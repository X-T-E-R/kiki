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
}

export interface DaemonSlashInput {
  readonly token: string;
  readonly rawToken: string;
  readonly args: string;
}

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
  command('help', ['h', '?'], 'Show daemon TUI command support', 'none'),
  command('version', [], 'Show version information', 'none'),
] as const satisfies readonly DaemonCommandDefinition[];

const DISABLED_COMMANDS = [
  disabled('settings', ['config'], 'Open TUI settings'),
  disabled('experiments', ['experimental'], 'Manage experimental features'),
  disabled('logout', ['disconnect'], 'Log out of a configured provider'),
  disabled('export-md', ['export'], 'Export current session as a Markdown file'),
  disabled('add-dir', [], 'Add or list an additional workspace directory'),
  disabled('btw', [], 'Ask a forked side agent a question'),
  disabled('compact', [], 'Compact the conversation context'),
  disabled('copy', [], 'Copy the last assistant message to the clipboard'),
  disabled('editor', [], 'Set the external editor'),
  disabled('export-debug-zip', [], 'Export current session as a debug ZIP archive'),
  disabled('fork', [], 'Fork the current session'),
  disabled('goal', [], 'Start or manage an autonomous goal'),
  disabled('init', [], 'Analyze the codebase and generate AGENTS.md'),
  disabled('login', [], 'Authenticate a provider'),
  disabled('mcp', [], 'Show MCP server status'),
  disabled('plugins', [], 'Manage plugins'),
  disabled('provider', ['providers'], 'Manage AI providers'),
  disabled('reload', [], 'Reload session configuration'),
  disabled('reload-tui', [], 'Reload TUI preferences'),
  disabled('tasks', ['task'], 'Browse background tasks'),
  disabled('theme', [], 'Set the terminal UI theme'),
  disabled('undo', [], 'Withdraw the last prompt'),
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
      argumentHint: '[arguments]',
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
  return `Daemon TUI commands\nSupported: ${supported}\nDisabled: ${disabled}`;
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
