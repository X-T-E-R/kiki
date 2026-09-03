import type { PublicError, SearchRunSyncEnvelope } from '@nb-corp/nb-search';

import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { INbSearchService } from '#/app/nbSearch/nbSearch';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolOutputAccumulator } from '#/tool/output-accumulator';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';

import { IWebSearchTool, WebSearchInputSchema, type WebSearchInput } from './web-search';
import DESCRIPTION from './web-search.md?raw';

export class WebSearchTool implements IWebSearchTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'WebSearch' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WebSearchInputSchema);

  constructor(@INbSearchService private readonly nbSearch: INbSearchService) {}

  resolveExecution(args: WebSearchInput): ToolExecution {
    const preview = args.query.length > 40 ? `${args.query.slice(0, 40)}…` : args.query;
    return {
      accesses: ToolAccesses.none(),
      description: `Searching: ${preview}`,
      display: { kind: 'search', query: args.query },
      approvalRule: literalRulePattern(this.name, args.query),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.query),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: WebSearchInput,
    { toolCallId, signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.nbSearch.search(args.query, { requestId: toolCallId, signal });
      signal.throwIfAborted();
      return renderSearchResult(result);
    } catch (error) {
      signal.throwIfAborted();
      return { isError: true, output: classifyThrownSearchError(error) };
    }
  }
}

function renderSearchResult(envelope: SearchRunSyncEnvelope): ExecutableToolResult {
  if (envelope.output?.channel !== 'results') {
    return { isError: true, output: classifySearchFailure(envelope.error, envelope.status) };
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

  if (envelope.status === 'succeeded' && envelope.output.results.length > 0) {
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
  if (status === 'empty') {
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
