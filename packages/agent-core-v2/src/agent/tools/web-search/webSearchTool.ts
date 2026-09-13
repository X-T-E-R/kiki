import type { PublicError, SearchInput, SearchRunSyncEnvelope } from '@nb-corp/nb-search';
import { parseNativeSearchInput, nativeSearchParameters } from '#/app/nbSearch/nativeInput';
import { renderNativeEnvelope } from '#/app/nbSearch/nativeOutput';

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

import { IWebSearchTool, type WebSearchInput } from './web-search';
import DESCRIPTION from './web-search.md?raw';

export class WebSearchTool implements IWebSearchTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'WebSearch' as const;
  get description(): string {
    return `${DESCRIPTION}\n\n${this.nbSearch.toolDescription('WebSearch')}`;
  }
  readonly parameters: Record<string, unknown> = nativeSearchParameters();

  constructor(@INbSearchService private readonly nbSearch: INbSearchService) {}

  resolveExecution(args: WebSearchInput): ToolExecution {
    try {
      const input = parseNativeSearchInput(args);
      const subject = input.action === 'run' ? (Array.isArray(input.query) ? input.query.join('\n') : input.query) : `${input.action} ${input.job_id}`;
      return {
        accesses: ToolAccesses.none(),
        description: `Search: ${subject.slice(0, 80)}`,
        display: { kind: 'search', query: subject },
        approvalRule: literalRulePattern(this.name, subject),
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, subject),
        execute: (ctx) => this.execution(input, ctx),
      };
    } catch (error) {
      return { isError: true, output: `Invalid search input: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async execution(
    args: SearchInput,
    { toolCallId, signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.nbSearch.search(args, { requestId: toolCallId, signal });
      signal.throwIfAborted();
      const compact = args.action === 'run' && typeof args.query === 'string' && Object.keys(args).every((key) => ['action', 'query', 'lane'].includes(key));
      return compact && result.action === 'run' && result.execution === 'sync' ? renderSearchResult(result) : renderNativeEnvelope(result);
    } catch (error) {
      signal.throwIfAborted();
      return { isError: true, output: classifyThrownSearchError(error) };
    }
  }
}

function renderSearchResult(envelope: SearchRunSyncEnvelope): ExecutableToolResult {
  if (envelope.output === undefined) {
    return { isError: true, output: classifySearchFailure(envelope.error, envelope.status) };
  }
  if (envelope.output.channel === 'typed') {
    return renderTypedSearchResult(envelope);
  }

  const builder = new ToolOutputAccumulator();
  let first = true;
  for (const result of envelope.output.results) {
    if (!first) builder.write('---\n\n');
    first = false;
    builder.write(`Title: ${result.title}\n`);
    if (result.site_name) builder.write(`Site: ${result.site_name}\n`);
    if (result.published_at) builder.write(`Date: ${result.published_at}\n`);
    builder.write(`URL: ${result.url}\n`);
    builder.write(`Snippet: ${result.snippet}\n\n`);
  }

  if (
    envelope.error === undefined &&
    (envelope.status === 'empty' ||
      (envelope.status === 'succeeded' && envelope.output.results.length === 0))
  ) {
    return { isError: false, output: 'No search results found.' };
  }
  if (envelope.status === 'succeeded') {
    builder.write(
      'When you rely on a result in your answer, cite it inline as a markdown link, e.g. [title](url).',
    );
    return builder.ok();
  }

  const detail = classifySearchFailure(envelope.error, envelope.status);
  if (envelope.output.results.length === 0) {
    return { isError: true, output: detail };
  }
  return builder.error(detail);
}

function renderTypedSearchResult(envelope: SearchRunSyncEnvelope): ExecutableToolResult {
  const output = envelope.output;
  if (output?.channel !== 'typed') {
    return { isError: true, output: classifySearchFailure(envelope.error, envelope.status) };
  }
  const builder = new ToolOutputAccumulator();
  builder.write(`Schema: ${output.schema_id}\nSource lane: ${output.lane}\n`);
  const sources = typedSources(output.data);
  builder.write('Sources:\n');
  if (sources.length === 0) {
    builder.write('None\n');
  } else {
    for (const source of sources) {
      builder.write(`- ${source.title === undefined ? source.url : `${source.title}: ${source.url}`}\n`);
    }
  }
  const content = typedContent(output.data);
  if (content !== undefined) {
    builder.write(`\nContent:\n${content}\n`);
    if (isRecord(output.data)) {
      const metadata = Object.fromEntries(Object.entries(output.data).filter(([key]) => !['answer', 'content', 'results', 'sources'].includes(key)));
      if (Object.keys(metadata).length > 0) builder.write(`\nMetadata:\n${JSON.stringify(metadata, null, 2)}\n`);
    }
  } else {
    builder.write(`\nData:\n${JSON.stringify(output.data ?? null, null, 2)}`);
  }
  builder.write('\nSources are provider-supplied and not independently verified. Cite the relevant source URLs inline; fetch primary pages when verification is needed.');

  if (envelope.error === undefined && envelope.status === 'empty') {
    builder.write('\n\nNo search results found.');
    return builder.ok();
  }
  if (envelope.status === 'succeeded') {
    return builder.ok();
  }
  return builder.error(classifySearchFailure(envelope.error, envelope.status));
}

function typedSources(data: unknown): Array<{ url: string; title?: string }> {
  if (!isRecord(data)) return [];
  const sources = [data['sources'], data['results']].flatMap((value) => Array.isArray(value) ? value : []);
  const seen = new Set<string>();
  return sources.flatMap((source) => {
    if (!isRecord(source) || typeof source['url'] !== 'string' || !/^https?:\/\//i.test(source['url']) || seen.has(source['url'])) return [];
    seen.add(source['url']);
    return [{
      url: source['url'],
      title: typeof source['title'] === 'string' ? source['title'] : undefined,
    }];
  });
}

function typedContent(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  return [data['answer'], data['content']].find((value): value is string => typeof value === 'string' && value.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function classifySearchFailure(error: PublicError | undefined, status: string): string {
  if (error?.code === 'CANCELLED' || status === 'cancelled') {
    return `Search cancelled: ${error?.message ?? 'The search was cancelled.'}`;
  }
  if (error?.code === 'DEADLINE_EXCEEDED' || status === 'timed_out') {
    return `Search timed out: ${error?.message ?? 'The search deadline was exceeded.'}`;
  }
  if (error?.code === 'PROVIDER_AUTH') {
    return `Search failed (authentication): ${error.message}`;
  }
  if (error?.code === 'DEFAULT_NOT_CONFIGURED') {
    return `Search unavailable: ${error.message}`;
  }
  if (status === 'empty' && error === undefined) {
    return 'Search returned no results. Status: empty.';
  }
  if (status === 'partial') {
    return 'Search completed partially; the results above are incomplete.';
  }
  return `Search failed${error === undefined ? '' : ` (${error.code})`}: ${error?.message ?? `status ${status}`}`;
}

function classifyThrownSearchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Search failed: ${message}`;
}

registerAgentToolService(IWebSearchTool, WebSearchTool, {
  name: 'WebSearch',
  domain: 'nbSearch',
});
