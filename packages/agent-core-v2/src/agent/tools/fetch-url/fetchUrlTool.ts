import type { FetchDocument, FetchRunSyncEnvelope, PublicError } from '@nb-corp/nb-search';
import { parseNativeFetchInput, nativeFetchParameters } from '#/app/nbSearch/nativeInput';
import { renderNativeEnvelope } from '#/app/nbSearch/nativeOutput';
import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { resolvePathAccessPath } from '#/tool/path-access';

import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { INbSearchService } from '#/app/nbSearch/nbSearch';

import { ToolOutputAccumulator } from '#/tool/output-accumulator';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';

import { IFetchURLTool, type FetchURLInput } from './fetch-url';
import DESCRIPTION from './fetch-url.md?raw';

export class FetchURLTool implements IFetchURLTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'FetchURL' as const;
  get description(): string {
    return `${DESCRIPTION}\n\n${this.nbSearch.toolDescription('FetchURL')}`;
  }
  readonly parameters: Record<string, unknown> = nativeFetchParameters();

  constructor(
    @INbSearchService private readonly nbSearch: INbSearchService,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
  ) {}

  async resolveExecution(args: FetchURLInput): Promise<ToolExecution> {
    try {
      const input = this.normalizeTrailingRootDot(parseNativeFetchInput(args));
      const file = input.action === 'run' && input.source.kind === 'file' ? await this.nbSearch.resolveFetchFile(input) : undefined;
      const inspected = file === undefined ? undefined : inspectAgentRuntime(this.runtime);
      const guard = (path: string): string => {
        if (inspected === undefined || inspected.workspace.supportsExternalPaths !== true || inspected.fs === undefined) throw new Error('Scoped donor file inputs require a host-path filesystem runtime.');
        const view = new RuntimeWorkspaceView(inspected, { workDir: this.workspace.workDir, additionalDirs: this.workspace.additionalDirs });
        return view.resolve(resolvePathAccessPath(inspected.path.relative(view.workDir, path), { env: inspected.environment, workspace: { workspaceDir: view.workDir, additionalDirs: view.additionalDirs }, operation: 'read' }), view.workDir, true);
      };
      const path = file === undefined ? undefined : guard(file);
      if (path !== undefined && guard(await inspected!.fs!.realpath(path)) !== path) throw new Error('Scoped fetch file changed or is a symbolic link. Use its admitted canonical path.');
      const identity = path === undefined ? undefined : await this.nbSearch.captureFetchFileIdentity(path);
      const subject = input.action !== 'run' ? `${input.action} ${input.job_id}` : input.source.kind === 'url' ? input.source.url : path ?? input.source.kind;
      return {
        accesses: path === undefined ? ToolAccesses.none() : ToolAccesses.readFile(path),
        description: `Fetch: ${subject.slice(0, 100)}`,
        display: path === undefined ? { kind: 'url_fetch', url: subject } : { kind: 'file_io', operation: 'read', path },
        approvalRule: literalRulePattern(this.name, subject),
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, subject),
        execute: async (ctx) => {
          if (path !== undefined && input.action === 'run') {
            const lease = this.runtime.acquire(['fs']);
            try {
              if (lease.runtime.identity.generation !== inspected!.identity.generation || await this.nbSearch.resolveFetchFile(input) !== path || guard(await lease.runtime.fs!.realpath(path)) !== path) return { isError: true, output: 'Scoped fetch file or runtime changed after admission. Retry the tool call.' };
              return await this.execution(input, ctx, path, identity);
            } finally { lease.dispose(); }
          }
          return this.execution(input, ctx);
        },
      };
    } catch (error) {
      return { isError: true, output: `Fetch input rejected: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Donor `parsePublicUrl` only lowercases the hostname, so a trailing root
   * dot (`metadata.google.internal.`) escapes both the exact metadata list and
   * the `.local` / `.localhost` suffix rules, and the URL then falls through
   * to the Jina lane. The URL spec treats `example.com.` as `example.com`, so
   * strip the root dot before admission (and before the approval subject) —
   * the fetch itself keeps the canonical, stripped spelling.
   */
  private normalizeTrailingRootDot<T>(input: T): T {
    if (
      typeof input !== 'object' || input === null ||
      !('source' in input) || typeof (input as { source: unknown }).source !== 'object'
    ) return input;
    const source = (input as { source: { kind?: unknown; url?: unknown } }).source;
    if (source.kind !== 'url' || typeof source.url !== 'string') return input;
    const url = source.url;
    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)([^]*)$/s.exec(url);
    if (schemeMatch === null) return input;
    const scheme = schemeMatch[1] ?? '';
    const authority = schemeMatch[2] ?? '';
    const rest = schemeMatch[3] ?? '';
    const authorityMatch = /^([^@]*@)?(\[[^\]]*\]|[^/:]*)(.*)$/.exec(authority);
    if (authorityMatch === null) return input;
    const userinfo = authorityMatch[1] ?? '';
    const host = authorityMatch[2] ?? '';
    const hostRest = authorityMatch[3] ?? '';
    if (host.endsWith('.') && !host.endsWith('].') && host !== '.') {
      return { ...input, source: { ...source, url: `${scheme}${userinfo}${host.slice(0, -1)}${hostRest}${rest}` } };
    }
    return input;
  }

  private async execution(
    args: FetchURLInput,
    { toolCallId, signal }: ExecutableToolContext,
    admittedFile?: string,
    identity?: import('#/app/nbSearch/nbSearch').FetchFileIdentity,
  ): Promise<ExecutableToolResult> {
    try {
      const result = admittedFile === undefined
        ? await this.nbSearch.fetch(args, { requestId: toolCallId, signal })
        : await this.nbSearch.fetch(args, { requestId: toolCallId, signal }, admittedFile, identity);
      signal.throwIfAborted();
      const compact = 'source' in args && args.source.kind === 'url' && Object.keys(args).every((key) => ['action', 'source'].includes(key));
      return compact && result.action === 'run' && result.execution === 'sync' ? renderFetchResult(result) : renderNativeEnvelope(result);
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        output: `Fetch failed: ${message}`,
      };
    }
  }
}

function renderFetchResult(envelope: FetchRunSyncEnvelope): ExecutableToolResult {
  const content = envelope.documents.map(renderDocument).filter((value) => value.length > 0).join('\n\n---\n\n');
  const hints = [...new Set([...envelope.documents.flatMap((document) => document.warnings), ...envelope.hints]
    .map((hint) => `${hint.code}: ${hint.message}${hint.data === undefined ? '' : ` ${JSON.stringify(hint.data)}`}`))];
  const guidance = hints.length === 0 ? '' : `Fetch warnings and hints:\n${hints.join('\n')}`;
  const output = [content, guidance].filter(Boolean).join('\n\n');
  if (envelope.status === 'succeeded' && content.length > 0) {
    return { isError: false, output };
  }
  const detail = classifyFetchFailure(envelope.error, envelope.status);
  if (output.length === 0) {
    return { isError: true, output: detail };
  }
  const builder = new ToolOutputAccumulator();
  builder.write(output);
  return builder.error(detail);
}

function renderDocument(document: FetchDocument): string {
  if (document.content.length === 0) return '';
  const note = document.truncated
    ? 'The returned content is truncated and incomplete.'
    : document.warnings.length > 0
      ? 'The returned content has fetch warnings; completeness is not guaranteed.'
      : isExtracted(document)
        ? 'The returned content is the main text extracted from the page.'
        : 'The returned content is the full response body, returned verbatim.';
  const citeReminder =
    'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).';
  return `${note} ${citeReminder}\n\n${document.content}`;
}

function isExtracted(document: FetchDocument): boolean {
  return (
    document.source_lane === 'jina.reader' ||
    document.content_type === 'text/html' ||
    document.content_type === 'application/xhtml+xml'
  );
}

function classifyFetchFailure(error: PublicError | undefined, status: string): string {
  if (error?.code === 'CANCELLED' || status === 'cancelled') {
    return `Fetch cancelled: ${error?.message ?? 'The fetch was cancelled.'}`;
  }
  if (error?.code === 'DEADLINE_EXCEEDED' || status === 'timed_out') {
    return `Fetch timed out: ${error?.message ?? 'The fetch deadline was exceeded.'}`;
  }
  if (error?.code === 'FETCH_DEFAULT_NOT_CONFIGURED') {
    return `Fetch unavailable: ${error.message}`;
  }
  if (status === 'empty') {
    return 'The response body is empty. Status: empty.';
  }
  if (status === 'partial') {
    return 'The URL was fetched partially; the returned content is incomplete.';
  }
  return `Failed to fetch URL${error === undefined ? '' : ` (${error.code})`}: ${error?.message ?? `status ${status}`}`;
}

registerAgentToolService(IFetchURLTool, FetchURLTool, { name: 'FetchURL', domain: 'nbSearch' });
