export type FileToolHintKind = 'read' | 'search' | 'write';

const HINTS: Record<FileToolHintKind, string> = {
  read: 'Hint: to read a file, use Read (supports line ranges) instead of Bash.',
  search: 'Hint: to search file contents or names, use Grep or Glob instead of Bash.',
  write: 'Hint: to write a text file, use Write or Edit instead of Bash.',
};
const MAX_HINTS_PER_KIND = 3;
const counts = new WeakMap<object, Map<FileToolHintKind, number>>();
const file = '(?:"[^"\\r\\n]+"|\'[^\'\\r\\n]+\'|[^\\s|;&<>]+)';
const textFile = '(?:"[^"\\r\\n]+"|\'[^\'\\r\\n]+\'|[^\\s|;&<>]+)\\.(?:[cm]?[jt]sx?|json|md|txt|ya?ml|toml|html?|css|py|rs|go|sh|xml|sql)';
const fileRead = new RegExp(`^(?:cat|head|tail)(?:\\s+(?:-[A-Za-z]+|-[0-9]+|--lines=\\d+|\\d+))*\\s+${file}$`, 'i');
const powershellRead = new RegExp(`^(?:type|Get-Content)(?:\\s+(?:-Path|-LiteralPath))?\\s+${file}$`, 'i');
const sedRead = new RegExp(`^sed\\s+-n\\s+['"]?\\d+(?:,\\d+)?p['"]?\\s+${file}$`, 'i');
const redirection = new RegExp(`^\\s*(?:echo|printf|cat|Set-Content|Add-Content|Out-File)\\b[^|;]*?\\s*>\\s*${textFile}\\s*$`, 'i');
const heredoc = new RegExp(`^\\s*cat\\s+(?:<<\\s*\\w+\\s*>\\s*${textFile}|>\\s*${textFile}\\s*<<\\s*\\w+)`, 'i');

export function classifyBashFileOperation(command: string): FileToolHintKind | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0 || /[|;`]/.test(trimmed)) return undefined;
  const steps = trimmed.split(/\s+&&\s+/);
  for (let step of steps) {
    step = step.trim();
    if (/^cd\s+(?:"[^"]+"|'[^']+'|[^\s]+)$/i.test(step)) continue;
    if (heredoc.test(step)) return 'write';
    if (/\r|\n/.test(step)) continue;
    if (/^(?:git|pnpm|npm|yarn|node|python|cargo|make|tsc|vitest|wc)\b/i.test(step)) continue;
    if (fileRead.test(step) || powershellRead.test(step) || sedRead.test(step)) return 'read';
    if (/^(?:rg\s+\S+|grep\s+-(?:[A-Za-z]*r|[A-Za-z]*R)\b|findstr\s+\S+|find\s+.+\s+-name\s+\S+|ls\s+-[A-Za-z]*R\b)/i.test(step)) return 'search';
    if (/^(?:sed\s+-(?:[A-Za-z]*i)|perl\s+-[A-Za-z]*pi|(?:Set-Content|Add-Content|Out-File)\s+)/i.test(step) || redirection.test(step)) return 'write';
  }
  return undefined;
}

export function bashFileToolHint(command: string, session: object, enabled = true): string | undefined {
  if (!enabled) return undefined;
  const kind = classifyBashFileOperation(command);
  if (kind === undefined) return undefined;
  let sessionCounts = counts.get(session);
  if (sessionCounts === undefined) {
    sessionCounts = new Map();
    counts.set(session, sessionCounts);
  }
  const count = sessionCounts.get(kind) ?? 0;
  if (count >= MAX_HINTS_PER_KIND) return undefined;
  sessionCounts.set(kind, count + 1);
  return HINTS[kind];
}
