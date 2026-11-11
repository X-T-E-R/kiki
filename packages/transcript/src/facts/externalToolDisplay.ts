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

interface ParsedDiffEntry {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

const NATIVE_KINDS = new Set([
  'command', 'file_io', 'diff', 'search', 'url_fetch', 'agent_call', 'skill_call',
  'todo_list', 'task', 'task_stop', 'plan_review', 'plan_enter', 'goal_start', 'external_permission',
]);

const READ_TOKENS = new Set([
  'read', 'view_file', 'read_file', 'fs_read', 'notebookread', 'notebook_read', 'readlints', 'read_lints',
]);

const WRITE_TOKENS = new Set([
  'write', 'write_file', 'write_to_file', 'create_file', 'fs_write',
]);

const EDIT_TOKENS = new Set([
  'edit', 'edit_file', 'multiedit', 'multi_edit', 'replace', 'replace_file_content',
  'multi_replace_file_content', 'str_replace_editor', 'notebookedit', 'notebook_edit',
  'apply_patch', 'apply_diff', 'patch', 'delete', 'delete_file', 'fs_delete',
]);

const GREP_SEARCH_TOKENS = new Set([
  'grep', 'grep_search', 'search', 'search_file_content', 'semsearch', 'sem_search',
  'codebase_search', 'codesearch', 'code_search', 'lsp',
  'websearch', 'search_web', 'web_search', 'google_web_search', 'xsearch',
]);

const GLOB_LIST_TOKENS = new Set([
  'glob', 'find_by_name', 'find', 'list_dir', 'list_directory', 'list_files', 'ls',
]);

const COMMAND_TOKENS = new Set([
  'bash', 'shell', 'run_command', 'runcommand', 'run_shell_command', 'execute_command', 'execute_bash',
]);

const FETCH_TOKENS = new Set([
  'fetchurl', 'webfetch', 'web_fetch', 'read_url_content', 'fetch_url',
]);

const AGENT_TOKENS = new Set([
  'agent', 'task', 'subagent', 'spawn_subagent', 'spawn_agent', 'invoke_sub_agent', 'cursortask',
]);

const TASK_STATUS_TOKENS = new Set([
  'taskoutput', 'task_output', 'get_command_or_subagent_output', 'wait_commands_or_subagents', 'monitor',
]);

const TASK_STOP_TOKENS = new Set([
  'taskstop', 'task_stop', 'kill_command_or_subagent', 'killtask', 'kill_shell', 'killshell',
]);

const EXPECTED_KIND: Readonly<Record<string, readonly string[]>> = {
  read: ['read'], view_file: ['read'], read_file: ['read'], fs_read: ['read'],
  notebookread: ['read'], notebook_read: ['read'], readlints: ['read'], read_lints: ['read'],
  grep: ['read', 'search'], grep_search: ['read', 'search'], search: ['read', 'search'], search_file_content: ['read', 'search'],
  semsearch: ['read', 'search'], sem_search: ['read', 'search'], codebase_search: ['read', 'search'],
  codesearch: ['read', 'search', 'fetch'], code_search: ['read', 'search', 'fetch'], lsp: ['read', 'search'],
  glob: ['read', 'search'], find_by_name: ['read', 'search'], find: ['read', 'search'],
  list_dir: ['read', 'search'], list_directory: ['read', 'search'], list_files: ['read', 'search'], ls: ['read', 'search'],
  edit: ['edit', 'file'], edit_file: ['edit', 'file'], multiedit: ['edit', 'file'], multi_edit: ['edit', 'file'],
  write: ['edit', 'file'], write_file: ['edit', 'file'], write_to_file: ['edit', 'file'], create_file: ['edit', 'file'], fs_write: ['edit', 'file'],
  replace: ['edit', 'file'], replace_file_content: ['edit', 'file'], multi_replace_file_content: ['edit', 'file'], str_replace_editor: ['edit', 'file'],
  notebookedit: ['edit', 'file'], notebook_edit: ['edit', 'file'],
  apply_patch: ['edit', 'file'], apply_diff: ['edit', 'file'], patch: ['edit', 'file'],
  delete: ['edit', 'file', 'delete'], delete_file: ['edit', 'file', 'delete'], fs_delete: ['edit', 'file', 'delete'],
  bash: ['execute', 'command'], shell: ['execute', 'command'], run_command: ['execute', 'command'],
  runcommand: ['execute', 'command'], run_shell_command: ['execute', 'command'], execute_command: ['execute', 'command'], execute_bash: ['execute', 'command'],
  websearch: ['fetch', 'search', 'webSearch'], search_web: ['fetch', 'search', 'webSearch'], web_search: ['fetch', 'search', 'webSearch'],
  google_web_search: ['fetch', 'search', 'webSearch'], xsearch: ['fetch', 'search', 'webSearch'],
  fetchurl: ['fetch'], webfetch: ['fetch'], web_fetch: ['fetch'], read_url_content: ['fetch', 'read'], fetch_url: ['fetch'],
  agent: ['collabAgentToolCall', 'subAgentActivity', 'agent'],
  task: ['collabAgentToolCall', 'subAgentActivity', 'agent'],
  subagent: ['collabAgentToolCall', 'subAgentActivity', 'agent'],
  spawn_subagent: ['collabAgentToolCall', 'subAgentActivity', 'agent'],
  spawn_agent: ['collabAgentToolCall', 'subAgentActivity', 'agent'],
  invoke_sub_agent: ['collabAgentToolCall', 'subAgentActivity', 'agent'],
  cursortask: ['collabAgentToolCall', 'subAgentActivity', 'agent'],
};

const PATH_KEYS = [
  'AbsolutePath', 'TargetFile', 'filePath', 'filepath', 'file_path', 'notebook_path', 'notebookPath',
  'path', 'Path', 'target_file', 'targetDirectory', 'target_directory', 'DirectoryPath', 'SearchDirectory', 'dir_path',
];
const COMMAND_KEYS = ['command', 'cmd', 'CommandLine'];
const CWD_KEYS = ['workdir', 'cwd', 'Cwd', 'workingDirectory', 'working_directory', 'dir_path', 'directory'];
const QUERY_KEYS = ['pattern', 'globPattern', 'glob_pattern', 'query', 'Query', 'Pattern', 'operation'];
const SCOPE_KEYS = ['SearchPath', 'path', 'Path', 'targetDirectory', 'target_directory', 'SearchDirectory', 'DirectoryPath', 'dir_path', 'directory'];
const CONTENT_KEYS = ['content', 'Content', 'CodeContent', 'contents', 'file_text', 'new_source', 'newSource'];
const BEFORE_KEYS = ['oldString', 'old_string', 'OldString', 'old_str', 'TargetContent', 'Target', 'Replace', 'oldText', 'before'];
const AFTER_KEYS = ['newString', 'new_string', 'NewString', 'new_str', 'ReplacementContent', 'Replacement', 'With', 'newText', 'after'];
const CHUNK_KEYS = ['ReplacementChunks', 'replacement_chunks', 'edits'];
const PATCH_TEXT_KEYS = ['patch', 'patchText', 'patch_text', 'diff', 'unified_diff', 'unifiedDiff', 'input'];
const AGENT_NAME_KEYS = ['subagent_type', 'subAgentType', 'agent', 'name', 'recipient', 'profile', 'role', 'model'];
const AGENT_PROMPT_KEYS = ['prompt', 'description', 'task', 'message', 'query', 'instructions'];

export function projectExternalToolDisplay(facts: ExternalToolDisplayFacts): ProjectedToolDisplay {
  const summary = facts.summary ?? facts.title ?? facts.name ?? 'Tool';
  const generic = (detail?: unknown): ProjectedToolDisplay => detail === undefined
    ? { kind: 'generic', summary }
    : { kind: 'generic', summary, detail };
  const input = objectOf(facts.rawInput);
  if (input?.['truncated'] === true) return generic();
  const token = toolToken(facts, input);
  if (conflictingKind(token, facts.kind)) return generic();
  const located = locatedPaths(facts.locations);
  const inputPaths = arrayStrings(input?.['paths']);
  const multiPaths = located.many ?? (inputPaths.length > 1 ? inputPaths : undefined);
  const singlePath = located.one ?? (multiPaths === undefined ? (inputPaths[0] ?? firstString(input, PATH_KEYS)) : undefined);
  const diffs = diffEntries(facts.content);
  if (diffs.length > 1) {
    const paths = unique(diffs.map((entry) => entry.path));
    return { kind: 'generic', summary: paths.join(', '), detail: { diffs } };
  }
  if (diffs.length === 1 && (facts.kind === 'edit' || facts.kind === 'file' || (token !== undefined && EXPECTED_KIND[token]?.includes('edit') === true))) {
    const diff = diffs[0]!;
    return { kind: 'diff', path: diff.path, before: diff.before, after: diff.after };
  }
  const fromKind = projectKind(facts.kind, token, facts.rawInput, input, singlePath, summary);
  if (fromKind !== undefined) return fromKind;
  const fromName = token === undefined ? undefined : projectName(token, facts.rawInput, input, singlePath, summary);
  if (fromName !== undefined) return fromName;
  if (multiPaths !== undefined && multiPaths.length > 1 && (facts.kind === 'read' || (token !== undefined && READ_TOKENS.has(token)))) {
    return { kind: 'generic', summary: multiPaths.join(', '), detail: { paths: multiPaths, operation: 'read' } };
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
  return conflictingKind(toolToken(facts, objectOf(facts.rawInput)), facts.kind);
}

function projectKind(
  kind: string | undefined,
  token: string | undefined,
  raw: unknown,
  input: Readonly<Record<string, unknown>> | undefined,
  path: string | undefined,
  summary: string,
): ProjectedToolDisplay | undefined {
  const pattern = firstString(input, QUERY_KEYS);
  if ((kind === 'read' || kind === 'search') && pattern !== undefined && (token === undefined || !READ_TOKENS.has(token))) {
    const scope = firstString(input, SCOPE_KEYS);
    return scope === undefined || scope === pattern ? { kind: 'search', query: pattern } : { kind: 'search', query: pattern, scope };
  }
  if (kind === 'read' && path !== undefined && (token === undefined || (!GLOB_LIST_TOKENS.has(token) && token !== 'read_url_content'))) {
    return { kind: 'file_io', operation: 'read', path };
  }
  if (kind === 'edit') {
    const patched = projectPatchPayload(raw, input);
    if (patched !== undefined) return patched;
    if (path !== undefined) return editOrWrite(input, path, token !== undefined && WRITE_TOKENS.has(token));
    return undefined;
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
      agent_name: firstString(input, AGENT_NAME_KEYS) ?? summary,
      prompt: firstString(input, AGENT_PROMPT_KEYS) ?? summary,
    };
  }
  if (kind === 'file' || kind === 'delete' || kind === 'move') {
    return projectFileCollection(raw, kind === 'file' ? input : undefined);
  }
  return undefined;
}

function projectName(
  token: string,
  raw: unknown,
  input: Readonly<Record<string, unknown>> | undefined,
  path: string | undefined,
  summary: string,
): ProjectedToolDisplay | undefined {
  if (COMMAND_TOKENS.has(token)) {
    const command = firstString(input, COMMAND_KEYS);
    if (command === undefined) return undefined;
    const cwd = firstString(input, CWD_KEYS);
    return cwd === undefined ? { kind: 'command', command } : { kind: 'command', command, cwd };
  }
  if (GREP_SEARCH_TOKENS.has(token)) {
    if (token === 'lsp') {
      const op = firstString(input, ['operation']);
      const lspPath = path ?? firstString(input, SCOPE_KEYS);
      if (op !== undefined) return lspPath === undefined ? { kind: 'search', query: op } : { kind: 'search', query: op, scope: lspPath };
      return undefined;
    }
    const query = firstString(input, QUERY_KEYS);
    if (query === undefined) return undefined;
    const scope = firstString(input, SCOPE_KEYS);
    return scope === undefined || scope === query ? { kind: 'search', query } : { kind: 'search', query, scope };
  }
  if (GLOB_LIST_TOKENS.has(token)) {
    const pattern = firstString(input, QUERY_KEYS);
    const scope = firstString(input, SCOPE_KEYS) ?? path;
    if (pattern !== undefined) return scope === undefined || scope === pattern ? { kind: 'search', query: pattern } : { kind: 'search', query: pattern, scope };
    if (scope !== undefined) return { kind: 'file_io', operation: 'glob', path: scope };
    return undefined;
  }
  if (FETCH_TOKENS.has(token)) {
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
  if (TASK_STATUS_TOKENS.has(token)) {
    const taskId = firstString(input, ['task_id', 'taskId', 'TaskId', 'id', 'shell_id', 'shellId', 'command_id']) ?? firstArrayString(input, ['ids', 'task_ids', 'taskIds']);
    if (taskId === undefined) return undefined;
    const description = firstString(input, ['description', 'prompt']) ?? taskId;
    return { kind: 'task', task_id: taskId, status: token === 'monitor' ? 'running' : 'status', description };
  }
  if (TASK_STOP_TOKENS.has(token)) {
    const taskId = firstString(input, ['task_id', 'taskId', 'TaskId', 'id', 'shell_id', 'shellId', 'command_id']);
    if (taskId === undefined) return undefined;
    const description = firstString(input, ['description', 'reason']) ?? taskId;
    return { kind: 'task_stop', task_id: taskId, task_description: description };
  }
  if (AGENT_TOKENS.has(token)) {
    const agentName = firstString(input, AGENT_NAME_KEYS);
    const prompt = firstString(input, AGENT_PROMPT_KEYS);
    if (agentName === undefined && prompt === undefined) return undefined;
    return {
      kind: 'agent_call',
      agent_name: agentName ?? summary,
      prompt: prompt ?? agentName ?? summary,
    };
  }
  if (READ_TOKENS.has(token)) {
    if (path === undefined) return undefined;
    return { kind: 'file_io', operation: 'read', path };
  }
  if (token === 'apply_patch' || token === 'apply_diff' || token === 'patch') {
    const patched = projectPatchPayload(raw, input);
    if (patched !== undefined) return patched;
    const collection = projectFileCollection(raw, input);
    if (collection !== undefined) return collection;
  }
  if (token === 'delete' || token === 'delete_file' || token === 'fs_delete') {
    if (path === undefined) return undefined;
    return { kind: 'file_io', operation: 'edit', path };
  }
  if ((WRITE_TOKENS.has(token) || EDIT_TOKENS.has(token)) && path !== undefined) {
    return editOrWrite(input, path, WRITE_TOKENS.has(token));
  }
  return undefined;
}

function projectFileCollection(raw: unknown, input: Readonly<Record<string, unknown>> | undefined): ProjectedToolDisplay | undefined {
  if (input !== undefined) {
    const patched = projectPatchPayload(raw, input);
    if (patched !== undefined) return patched;
  }
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
  return undefined;
}

function projectPatchPayload(raw: unknown, input: Readonly<Record<string, unknown>> | undefined): ProjectedToolDisplay | undefined {
  const patchText = typeof raw === 'string' ? raw : firstString(input, PATCH_TEXT_KEYS);
  if (patchText === undefined) return undefined;
  const diffs = parsePatchDiffs(patchText);
  if (diffs.length > 1) {
    const paths = unique(diffs.map((entry) => entry.path));
    return { kind: 'generic', summary: paths.join(', '), detail: { diffs } };
  }
  if (diffs.length === 1) {
    const diff = diffs[0]!;
    return { kind: 'file_io', operation: 'edit', path: diff.path, before: diff.before, after: diff.after };
  }
  const paths = parsePatchPaths(patchText);
  if (paths.length > 1) return { kind: 'generic', summary: paths.join(', '), detail: { paths, operation: 'edit' } };
  if (paths.length === 1) return { kind: 'file_io', operation: 'edit', path: paths[0]! };
  return undefined;
}

function editOrWrite(input: Readonly<Record<string, unknown>> | undefined, path: string, preferWrite = false): ProjectedToolDisplay {
  const chunks = chunkEntries(input, path);
  if (chunks.length > 1) {
    const paths = unique(chunks.map((entry) => entry.path));
    return { kind: 'generic', summary: paths.join(', '), detail: { diffs: chunks } };
  }
  if (chunks.length === 1) {
    const chunk = chunks[0]!;
    return { kind: 'file_io', operation: 'edit', path: chunk.path, before: chunk.before, after: chunk.after };
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

function chunkEntries(input: Readonly<Record<string, unknown>> | undefined, path: string): ParsedDiffEntry[] {
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

function parsePatchDiffs(text: string): ParsedDiffEntry[] {
  if (text.includes('*** Begin Patch') || /^\*\*\* (?:Add|Update|Delete) File:/m.test(text)) {
    return parseApplyPatchDiffs(text);
  }
  if (text.includes('diff --git ') || /^---\s+\S+/m.test(text)) {
    return parseUnifiedDiffEntries(text);
  }
  return [];
}

function parsePatchPaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const trimmed = line.trim();
    for (const prefix of ['*** Add File:', '*** Update File:', '*** Delete File:', '*** Move to:']) {
      if (trimmed.startsWith(prefix)) {
        const candidate = cleanPatchPath(trimmed.slice(prefix.length));
        if (candidate !== '') paths.push(candidate);
      }
    }
    const gitMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(trimmed);
    if (gitMatch?.[2]) paths.push(cleanPatchPath(gitMatch[2]));
  }
  return unique(paths);
}

function parseApplyPatchDiffs(text: string): ParsedDiffEntry[] {
  const entries: ParsedDiffEntry[] = [];
  let path: string | undefined;
  let movePath: string | undefined;
  let before: string[] = [];
  let after: string[] = [];
  let sawBody = false;

  const flush = (): void => {
    const target = movePath ?? path;
    if (target !== undefined && sawBody) {
      const beforeText = before.join('\n');
      const afterText = after.join('\n');
      if (beforeText !== '' || afterText !== '') {
        entries.push({ path: target, before: beforeText, after: afterText });
      }
    }
    path = undefined;
    movePath = undefined;
    before = [];
    after = [];
    sawBody = false;
  };

  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*** Add File:') || trimmed.startsWith('*** Update File:') || trimmed.startsWith('*** Delete File:')) {
      flush();
      const colon = trimmed.indexOf(':');
      const nextPath = cleanPatchPath(trimmed.slice(colon + 1));
      path = nextPath === '' ? undefined : nextPath;
      continue;
    }
    if (trimmed === '*** Begin Patch' || trimmed === '*** End Patch') {
      if (trimmed === '*** End Patch') flush();
      continue;
    }
    if (path === undefined) continue;
    if (trimmed.startsWith('*** Move to:')) {
      const target = cleanPatchPath(trimmed.slice('*** Move to:'.length));
      if (target !== '') movePath = target;
      continue;
    }
    if (trimmed === '*** End of File' || line.startsWith('@@') || line.startsWith('\\ No newline')) continue;
    if (line.startsWith('-')) {
      before.push(line.slice(1));
      sawBody = true;
    } else if (line.startsWith('+')) {
      after.push(line.slice(1));
      sawBody = true;
    } else if (line.startsWith(' ')) {
      before.push(line.slice(1));
      after.push(line.slice(1));
      sawBody = true;
    }
  }
  flush();
  return entries;
}

function parseUnifiedDiffEntries(text: string): ParsedDiffEntry[] {
  const entries: ParsedDiffEntry[] = [];
  let path: string | undefined;
  let before: string[] = [];
  let after: string[] = [];
  let inHunk = false;

  const flush = (): void => {
    if (path !== undefined && inHunk) {
      const beforeText = before.join('\n');
      const afterText = after.join('\n');
      if (beforeText !== '' || afterText !== '') {
        entries.push({ path, before: beforeText, after: afterText });
      }
    }
    path = undefined;
    before = [];
    after = [];
    inHunk = false;
  };

  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.trim());
      if (match?.[2]) path = cleanPatchPath(match[2]);
      continue;
    }
    if (line.startsWith('--- ') && inHunk) flush();
    if (line.startsWith('--- ')) {
      if (path === undefined && line !== '--- /dev/null') path = cleanPatchPath(line.slice(4)).replace(/^a\//, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (line !== '+++ /dev/null') path = cleanPatchPath(line.slice(4)).replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\ No newline')) continue;
    if (line.startsWith('-')) before.push(line.slice(1));
    else if (line.startsWith('+')) after.push(line.slice(1));
    else if (line.startsWith(' ')) {
      before.push(line.slice(1));
      after.push(line.slice(1));
    }
  }
  flush();
  return entries;
}

function cleanPatchPath(value: string): string {
  return value.trim().replaceAll(/^["']+|["']+$/g, '');
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

function toolToken(facts: ExternalToolDisplayFacts, input: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const name = tokenOf(facts.name);
  if (name !== undefined) return name;
  const variant = tokenOf(stringOf(input?.['variant']));
  if (variant !== undefined) return variant;
  return tokenOf(facts.title);
}

function tokenOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const token = value.trim().toLowerCase();
  if (token === '') return undefined;
  if (
    EXPECTED_KIND[token] !== undefined ||
    token === 'manage_task' ||
    TASK_STATUS_TOKENS.has(token) ||
    TASK_STOP_TOKENS.has(token)
  ) {
    return token;
  }
  return undefined;
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

function diffEntries(content: readonly unknown[] | undefined): ParsedDiffEntry[] {
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

function changeDiffs(raw: unknown): ParsedDiffEntry[] {
  const record = objectOf(raw);
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(record?.['changes'])
      ? (record['changes'] as unknown[])
      : Array.isArray(record?.['files'])
        ? (record['files'] as unknown[])
        : [];
  return list.flatMap((item) => {
    const entry = objectOf(item);
    const path = firstString(entry, PATH_KEYS);
    const before = firstText(entry, BEFORE_KEYS);
    const after = firstText(entry, AFTER_KEYS);
    if (path === undefined || before === undefined || after === undefined || (before === '' && after === '')) return [];
    return [{ path, before, after }];
  });
}

function changePaths(raw: unknown): string[] {
  const record = objectOf(raw);
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(record?.['changes'])
      ? (record['changes'] as unknown[])
      : Array.isArray(record?.['files'])
        ? (record['files'] as unknown[])
        : [];
  return unique(list.flatMap((item) => {
    const path = stringOf(item) ?? firstString(objectOf(item), PATH_KEYS);
    return path === undefined ? [] : [path];
  }));
}

function arrayStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.filter((entry): entry is string => typeof entry === 'string' && entry !== ''));
}

function firstArrayString(input: Readonly<Record<string, unknown>> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const items = arrayStrings(input?.[key]);
    if (items[0] !== undefined) return items[0];
  }
  return undefined;
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
