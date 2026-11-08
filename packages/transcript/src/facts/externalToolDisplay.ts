/**
 * Project a foreign tool call onto the native tool display from its recorded
 * name, kind, and structured arguments.
 *
 * Kind `other` is missing vendor metadata, not a refusal: a known tool name
 * with a complete argument object gets the same display a native call would.
 * A conflicting specific kind, a truncated payload, or an unknown tool stays
 * generic so the original record remains the fact. Display is not authorization.
 */
export interface ExternalToolDisplayFacts {
  readonly name?: string;
  readonly title?: string;
  readonly kind?: string;
  readonly rawInput?: unknown;
  readonly content?: readonly unknown[];
  readonly locations?: readonly unknown[];
  readonly summary?: string;
  readonly titleFallback?: boolean;
}

export type ProjectedToolDisplay =
  | { readonly kind: 'command'; readonly command: string; readonly cwd?: string }
  | { readonly kind: 'file_io'; readonly operation: 'read' | 'write' | 'edit' | 'glob' | 'grep'; readonly path: string; readonly content?: string; readonly before?: string; readonly after?: string }
  | { readonly kind: 'diff'; readonly path: string; readonly before: string; readonly after: string }
  | { readonly kind: 'search'; readonly query: string; readonly scope?: string }
  | { readonly kind: 'url_fetch'; readonly url: string }
  | { readonly kind: 'agent_call'; readonly agent_name: string; readonly prompt: string }
  | { readonly kind: 'task'; readonly task_id: string; readonly status: string; readonly description: string }
  | { readonly kind: 'task_stop'; readonly task_id: string; readonly task_description: string }
  | { readonly kind: 'generic'; readonly summary: string; readonly detail?: unknown };

const NATIVE_KINDS = new Set([
  'command', 'file_io', 'diff', 'search', 'url_fetch', 'agent_call', 'skill_call',
  'todo_list', 'task', 'task_stop', 'plan_review', 'plan_enter', 'goal_start', 'external_permission',
]);

const EXPECTED_KIND: Readonly<Record<string, readonly string[]>> = {
  read: ['read'], view_file: ['read'], read_file: ['read'],
  grep: ['read', 'search'], grep_search: ['read', 'search'], search: ['read', 'search'], search_file_content: ['read', 'search'],
  glob: ['read', 'search'], find_by_name: ['read', 'search'], list_dir: ['read', 'search'], list_directory: ['read', 'search'],
  edit: ['edit'], edit_file: ['edit'], multiedit: ['edit'], multi_edit: ['edit'],
  write: ['edit'], write_file: ['edit'], write_to_file: ['edit'],
  replace: ['edit'], replace_file_content: ['edit'], multi_replace_file_content: ['edit'], str_replace_editor: ['edit'],
  bash: ['execute', 'command'], shell: ['execute', 'command'], run_command: ['execute', 'command'], runcommand: ['execute', 'command'], run_shell_command: ['execute', 'command'], execute_command: ['execute', 'command'],
  websearch: ['fetch', 'search'], search_web: ['fetch', 'search'], web_search: ['fetch', 'search'], google_web_search: ['fetch', 'search'], xsearch: ['search'],
  fetchurl: ['fetch'], webfetch: ['fetch'], web_fetch: ['fetch'], read_url_content: ['fetch', 'read'],
};

const PATH_KEYS = ['AbsolutePath', 'TargetFile', 'filePath', 'filepath', 'file_path', 'path', 'Path', 'target_file', 'DirectoryPath', 'SearchDirectory', 'dir_path'];
const COMMAND_KEYS = ['command', 'cmd', 'CommandLine'];
const CWD_KEYS = ['workdir', 'cwd', 'Cwd', 'dir_path', 'directory'];
const QUERY_KEYS = ['pattern', 'glob_pattern', 'query', 'Query', 'Pattern'];
const SCOPE_KEYS = ['SearchPath', 'path', 'Path', 'target_directory', 'SearchDirectory', 'DirectoryPath', 'dir_path', 'directory'];
const CONTENT_KEYS = ['content', 'Content', 'CodeContent', 'contents', 'file_text'];
const BEFORE_KEYS = ['oldString', 'old_string', 'OldString', 'old_str', 'TargetContent', 'Target', 'Replace', 'oldText', 'before'];
const AFTER_KEYS = ['newString', 'new_string', 'NewString', 'new_str', 'ReplacementContent', 'Replacement', 'With', 'newText', 'after'];
const CHUNK_KEYS = ['ReplacementChunks', 'replacement_chunks', 'edits'];

export function projectExternalToolDisplay(facts: ExternalToolDisplayFacts): ProjectedToolDisplay {
  const summary = facts.summary ?? facts.title ?? facts.name ?? 'Tool';
  const generic = (detail?: unknown): ProjectedToolDisplay => detail === undefined
    ? { kind: 'generic', summary }
    : { kind: 'generic', summary, detail };
  const input = objectOf(facts.rawInput);
  if (input?.['truncated'] === true) return generic();
  const token = toolToken(facts);
  if (conflictingKind(token, facts.kind)) return generic();
  const located = locatedPaths(facts.locations);
  const singlePath = located.one ?? (located.many === undefined ? firstString(input, PATH_KEYS) : undefined);
  const diffs = diffEntries(facts.content);
  if (diffs.length > 1) {
    const paths = unique(diffs.map((entry) => entry.path));
    return { kind: 'generic', summary: paths.join(', '), detail: { diffs } };
  }
  if (diffs.length === 1 && (facts.kind === 'edit' || token !== undefined && EXPECTED_KIND[token]?.includes('edit') === true)) {
    const diff = diffs[0]!;
    return { kind: 'diff', path: diff.path, before: diff.before, after: diff.after };
  }
  const fromKind = projectKind(facts.kind, token, facts.rawInput, input, singlePath, summary);
  if (fromKind !== undefined) return fromKind;
  const fromName = token === undefined ? undefined : projectName(token, input, singlePath);
  if (fromName !== undefined) return fromName;
  if (located.many !== undefined && located.many.length > 1 && (facts.kind === 'read' || token === 'read' || token === 'view_file' || token === 'read_file')) {
    return { kind: 'generic', summary: located.many.join(', '), detail: { paths: located.many, operation: 'read' } };
  }
  if (facts.titleFallback === true) {
    if ((facts.kind === 'execute' || facts.kind === 'command') && firstString(input, COMMAND_KEYS) === undefined) {
      return { kind: 'command', command: summary };
    }
    if ((facts.kind === 'search' || facts.kind === 'webSearch') && firstString(input, QUERY_KEYS) === undefined) {
      return { kind: 'search', query: summary };
    }
  }
  return generic();
}

/**
 * Keep a display that is already a native kind. Recover a generic or missing
 * one from the recorded facts. The source wire record is left unchanged.
 */
export function normalizeStoredExternalToolDisplay(stored: unknown, facts: ExternalToolDisplayFacts): unknown {
  const record = objectOf(stored);
  const kind = stringOf(record?.['kind']);
  if (kind !== undefined && kind !== 'generic' && NATIVE_KINDS.has(kind)) return stored;
  const projected = projectExternalToolDisplay({
    ...facts,
    summary: facts.summary ?? (typeof record?.['summary'] === 'string' ? record['summary'] : undefined),
  });
  if (projected.kind !== 'generic') return projected;
  if (recoveredDetail(projected.detail) && (!recoveredDetail(record?.['detail']) || operationOf(projected.detail) !== undefined && operationOf(record?.['detail']) === undefined)) return projected;
  if (record?.['kind'] === 'generic' && typeof record['summary'] === 'string') return stored;
  return projected;
}

/** A specific kind that contradicts a known tool name. Kind `other` is missing metadata, not a conflict. */
export function externalToolKindConflicts(facts: ExternalToolDisplayFacts): boolean {
  return conflictingKind(toolToken(facts), facts.kind);
}

function projectKind(kind: string | undefined, token: string | undefined, raw: unknown, input: Readonly<Record<string, unknown>> | undefined, path: string | undefined, summary: string): ProjectedToolDisplay | undefined {
  const pattern = firstString(input, QUERY_KEYS);
  if ((kind === 'read' || kind === 'search') && pattern !== undefined) {
    const scope = firstString(input, SCOPE_KEYS);
    return scope === undefined || scope === pattern ? { kind: 'search', query: pattern } : { kind: 'search', query: pattern, scope };
  }
  if (kind === 'read' && path !== undefined && token !== 'glob' && token !== 'find_by_name' && token !== 'list_dir' && token !== 'list_directory' && token !== 'read_url_content') {
    return { kind: 'file_io', operation: 'read', path };
  }
  if (kind === 'edit' && path !== undefined) {
    return editOrWrite(input, path, token === 'write' || token === 'write_file' || token === 'write_to_file');
  }
  if (kind === 'execute' || kind === 'command') {
    const command = firstString(input, COMMAND_KEYS);
    if (command === undefined) return undefined;
    const cwd = firstString(input, CWD_KEYS);
    return cwd === undefined ? { kind: 'command', command } : { kind: 'command', command, cwd };
  }
  if (kind === 'fetch') {
    const source = objectOf(input?.['source']);
    const url = firstString(input, ['url', 'Url']) ?? (source?.['kind'] === 'url' ? stringOf(source['url']) : undefined);
    if (url !== undefined) return { kind: 'url_fetch', url };
    const query = firstString(input, QUERY_KEYS);
    if (query !== undefined) return { kind: 'search', query };
    return undefined;
  }
  if (kind === 'search' || kind === 'webSearch') {
    const query = firstString(input, QUERY_KEYS) ?? pattern;
    if (query !== undefined) return { kind: 'search', query };
    return undefined;
  }
  if (kind === 'collabAgentToolCall' || kind === 'subAgentActivity') {
    return {
      kind: 'agent_call',
      agent_name: firstString(input, ['agent', 'recipient']) ?? summary,
      prompt: firstString(input, ['prompt', 'message']) ?? summary,
    };
  }
  if (kind === 'file' || kind === 'delete' || kind === 'move') {
    const diffs = changeDiffs(raw);
    if (diffs.length > 1) {
      const paths = unique(diffs.map((entry) => entry.path));
      return { kind: 'generic', summary: paths.join(', '), detail: { diffs } };
    }
    if (diffs.length === 1) {
      const diff = diffs[0]!;
      return { kind: 'file_io', operation: 'edit', path: diff.path, before: diff.before, after: diff.after };
    }
    const paths = changePaths(raw);
    if (paths.length > 1) return { kind: 'generic', summary: paths.join(', '), detail: { paths, operation: 'edit' } };
    const changePath = paths[0];
    if (changePath !== undefined) return { kind: 'file_io', operation: 'edit', path: changePath };
  }
  return undefined;
}

function projectName(token: string, input: Readonly<Record<string, unknown>> | undefined, path: string | undefined): ProjectedToolDisplay | undefined {
  if (token === 'bash' || token === 'shell' || token === 'run_command' || token === 'runcommand' || token === 'run_shell_command' || token === 'execute_command') {
    const command = firstString(input, COMMAND_KEYS);
    if (command === undefined) return undefined;
    const cwd = firstString(input, CWD_KEYS);
    return cwd === undefined ? { kind: 'command', command } : { kind: 'command', command, cwd };
  }
  if (token === 'grep' || token === 'grep_search' || token === 'search' || token === 'search_file_content' || token === 'websearch' || token === 'search_web' || token === 'web_search' || token === 'google_web_search' || token === 'xsearch') {
    const query = firstString(input, QUERY_KEYS);
    if (query === undefined) return undefined;
    const scope = firstString(input, SCOPE_KEYS);
    return scope === undefined || scope === query ? { kind: 'search', query } : { kind: 'search', query, scope };
  }
  if (token === 'glob' || token === 'find_by_name' || token === 'list_dir' || token === 'list_directory') {
    const pattern = firstString(input, QUERY_KEYS);
    const scope = firstString(input, SCOPE_KEYS);
    if (pattern !== undefined) return scope === undefined || scope === pattern ? { kind: 'search', query: pattern } : { kind: 'search', query: pattern, scope };
    if (scope !== undefined) return { kind: 'file_io', operation: 'glob', path: scope };
    return undefined;
  }
  if (token === 'fetchurl' || token === 'webfetch' || token === 'web_fetch' || token === 'read_url_content') {
    const source = objectOf(input?.['source']);
    const url = firstString(input, ['url', 'Url']) ?? (source?.['kind'] === 'url' ? stringOf(source['url']) : undefined);
    if (url !== undefined) return { kind: 'url_fetch', url };
    const query = firstString(input, QUERY_KEYS);
    if (query !== undefined) return { kind: 'search', query };
    return undefined;
  }
  if (token === 'manage_task') {
    const action = firstString(input, ['Action', 'action']);
    const taskId = firstString(input, ['TaskId', 'task_id', 'taskId']);
    if (action === undefined || taskId === undefined) return undefined;
    if (action === 'kill' || action === 'stop' || action === 'cancel') return { kind: 'task_stop', task_id: taskId, task_description: taskId };
    if (action === 'status') return { kind: 'task', task_id: taskId, status: action, description: taskId };
    return undefined;
  }
  if (token === 'read' || token === 'view_file' || token === 'read_file') {
    if (path === undefined) return undefined;
    return { kind: 'file_io', operation: 'read', path };
  }
  if ((token === 'write' || token === 'write_file' || token === 'write_to_file' || token === 'edit' || token === 'edit_file' || token === 'multiedit' || token === 'multi_edit' || token === 'replace' || token === 'replace_file_content' || token === 'multi_replace_file_content' || token === 'str_replace_editor') && path !== undefined) {
    return editOrWrite(input, path, token === 'write' || token === 'write_file' || token === 'write_to_file');
  }
  return undefined;
}

function editOrWrite(input: Readonly<Record<string, unknown>> | undefined, path: string, preferWrite = false): ProjectedToolDisplay {
  const chunks = chunkEntries(input, path);
  if (chunks.length > 1) return { kind: 'generic', summary: path, detail: { diffs: chunks } };
  if (chunks.length === 1) {
    const chunk = chunks[0]!;
    return { kind: 'file_io', operation: 'edit', path, before: chunk.before, after: chunk.after };
  }
  const before = firstText(input, BEFORE_KEYS);
  const after = firstText(input, AFTER_KEYS);
  const content = firstString(input, CONTENT_KEYS);
  if (content !== undefined && before === undefined) return { kind: 'file_io', operation: 'write', path, content };
  if (preferWrite && before === undefined && after === undefined) return { kind: 'file_io', operation: 'write', path };
  if (before !== undefined && after !== undefined && (before !== '' || after !== '')) {
    return { kind: 'file_io', operation: 'edit', path, before, after };
  }
  return { kind: 'file_io', operation: preferWrite ? 'write' : 'edit', path };
}

function chunkEntries(input: Readonly<Record<string, unknown>> | undefined, path: string): { path: string; before: string; after: string }[] {
  for (const key of CHUNK_KEYS) {
    const raw = input?.[key];
    if (!Array.isArray(raw)) continue;
    const chunks = raw.flatMap((item) => {
      const record = objectOf(item);
      const before = firstText(record, BEFORE_KEYS);
      const after = firstText(record, AFTER_KEYS);
      if (before === undefined || after === undefined || (before === '' && after === '')) return [];
      const itemPath = firstString(record, PATH_KEYS) ?? path;
      return [{ path: itemPath, before, after }];
    });
    if (chunks.length > 0) return chunks;
  }
  return [];
}

function recoveredDetail(detail: unknown): boolean {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return false;
  const record = detail as Readonly<Record<string, unknown>>;
  return Array.isArray(record['diffs']) || Array.isArray(record['paths']);
}

function operationOf(detail: unknown): 'read' | 'edit' | undefined {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return undefined;
  const operation = (detail as Readonly<Record<string, unknown>>)['operation'];
  return operation === 'read' || operation === 'edit' ? operation : undefined;
}

function conflictingKind(token: string | undefined, kind: string | undefined): boolean {
  if (token === undefined || kind === undefined || kind === '' || kind === 'other') return false;
  const expected = EXPECTED_KIND[token];
  return expected !== undefined && !expected.includes(kind);
}

function toolToken(facts: ExternalToolDisplayFacts): string | undefined {
  const name = tokenOf(facts.name);
  if (name !== undefined) return name;
  return tokenOf(facts.title);
}

function tokenOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const token = value.trim().toLowerCase();
  return token === '' || EXPECTED_KIND[token] === undefined && token !== 'manage_task' ? undefined : token;
}

function locatedPaths(locations: readonly unknown[] | undefined): { one?: string; many?: string[] } {
  const paths = unique((locations ?? []).flatMap((item) => {
    const path = stringOf(objectOf(item)?.['path']);
    return path === undefined ? [] : [path];
  }));
  if (paths.length > 1) return { many: paths };
  if (paths.length === 1) return { one: paths[0] };
  return {};
}

function diffEntries(content: readonly unknown[] | undefined): { path: string; before: string; after: string }[] {
  return (content ?? []).flatMap((item) => {
    const record = objectOf(item);
    if (record?.['type'] !== 'diff') return [];
    const path = stringOf(record['path']);
    const after = typeof record['newText'] === 'string' ? record['newText'] : undefined;
    const oldText = record['oldText'];
    if (path === undefined || after === undefined || (oldText !== null && oldText !== undefined && typeof oldText !== 'string')) return [];
    return [{ path, before: oldText ?? '', after }];
  });
}

function changeDiffs(raw: unknown): { path: string; before: string; after: string }[] {
  const list = Array.isArray(raw) ? raw : Array.isArray(objectOf(raw)?.['changes']) ? (objectOf(raw)!['changes'] as unknown[]) : [];
  return list.flatMap((item) => {
    const record = objectOf(item);
    const path = firstString(record, PATH_KEYS);
    const before = firstText(record, BEFORE_KEYS);
    const after = firstText(record, AFTER_KEYS);
    if (path === undefined || before === undefined || after === undefined || (before === '' && after === '')) return [];
    return [{ path, before, after }];
  });
}

function changePaths(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : Array.isArray(objectOf(raw)?.['changes']) ? (objectOf(raw)!['changes'] as unknown[]) : [];
  return unique(list.flatMap((item) => {
    const path = stringOf(item) ?? firstString(objectOf(item), PATH_KEYS);
    return path === undefined ? [] : [path];
  }));
}

function firstString(input: Readonly<Record<string, unknown>> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function firstText(input: Readonly<Record<string, unknown>> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
