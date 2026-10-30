import { parse, type SyntaxNode } from '@kiki/tree-sitter-bash';

const READ_ONLY_COMMANDS = new Set([
  'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'printf', 'echo',
  'true', 'false', 'sleep', 'uname', 'whoami', 'basename', 'dirname',
]);
const CONTAINERS = new Set(['program', 'list', 'pipeline']);

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
  return children.slice(1).every(literalNode);
}

function literalNode(node: SyntaxNode): boolean {
  if (node.type === 'word' || node.type === 'number' || node.type === 'raw_string') return true;
  if (node.type !== 'string') return false;
  return node.namedChildren.every((child) => child.type === 'string_content');
}
