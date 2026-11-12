import { parse, type SyntaxNode } from '@kiki/tree-sitter-bash';

const READ_ONLY_COMMANDS = new Set([
  'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'printf', 'echo',
  'true', 'false', 'sleep', 'uname', 'whoami', 'basename', 'dirname',
  'rg', 'grep', 'find', 'which', 'date', 'du', 'df', 'git',
]);
const CONTAINERS = new Set(['program', 'list', 'pipeline']);
const FIND_ACTIONS_WITH_EFFECTS = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls',
]);
const GIT_READ_ONLY_SUBCOMMANDS = new Set(['log', 'show', 'rev-parse']);
const GIT_BRANCH_WRITE_OPTIONS = new Set([
  '--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream',
  '--edit-description', '--track', '--no-track', '--create-reflog',
]);

export function isConcurrencySafeBash(source: string): boolean {
  const parsed = parse(source, { timeoutMs: 50, maxNodes: 10_000 });
  return parsed.ok && !parsed.hasError && safeNode(parsed.rootNode);
}

function safeNode(node: SyntaxNode): boolean {
  if (node.type === 'comment' || !node.isNamed) return true;
  if (CONTAINERS.has(node.type)) return node.namedChildren.length > 0 && node.namedChildren.every(safeNode);
  if (node.type !== 'command') return false;
  const children = node.namedChildren;
  const command = children[0];
  if (command?.type !== 'command_name' || !READ_ONLY_COMMANDS.has(command.text)) return false;
  const args = children.slice(1);
  return args.every(literalNode) && safeArguments(command.text, args.map(literalText));
}

function literalNode(node: SyntaxNode): boolean {
  if (node.type === 'word' || node.type === 'number' || node.type === 'raw_string') return true;
  if (node.type !== 'string') return false;
  return node.namedChildren.every((child) => child.type === 'string_content');
}

function literalText(node: SyntaxNode): string {
  return node.type === 'string' || node.type === 'raw_string' ? node.text.slice(1, -1) : node.text;
}

function safeArguments(command: string, args: readonly string[]): boolean {
  switch (command) {
    case 'find':
      return !args.some((arg) => FIND_ACTIONS_WITH_EFFECTS.has(arg));
    case 'rg':
      return !args.some((arg) => arg.startsWith('--pre') || arg.startsWith('--hostname-bin'));
    case 'date':
      return !args.some((arg) => arg === '--set' || arg.startsWith('--set=') || /^-[^-]*s/.test(arg));
    case 'git':
      return safeGitArguments(args);
    default:
      return true;
  }
}

function safeGitArguments(args: readonly string[]): boolean {
  let index = 0;
  while (args[index] === '--no-pager' || args[index] === '-C') index += args[index] === '-C' ? 2 : 1;
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  if (subcommand === 'branch') return safeGitBranchArguments(rest);
  return subcommand !== undefined && GIT_READ_ONLY_SUBCOMMANDS.has(subcommand) &&
    !rest.some((arg) => /^--(?:output|ext-diff|textconv)(?:=|$)/.test(arg));
}

function safeGitBranchArguments(args: readonly string[]): boolean {
  if (!args.includes('--list') && !args.includes('--show-current')) return false;
  return args.every((arg) => {
    if (arg.startsWith('--')) return !GIT_BRANCH_WRITE_OPTIONS.has(arg.split('=', 1)[0]!);
    if (arg.startsWith('-')) return !/[dDmMcCfut]/.test(arg.slice(1));
    return true;
  });
}
