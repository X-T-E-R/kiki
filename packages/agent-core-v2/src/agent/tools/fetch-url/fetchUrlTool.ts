import type { FetchDocument, FetchRunSyncEnvelope, PublicError } from '@nb-corp/nb-search';

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

import { FetchURLInputSchema, IFetchURLTool, type FetchURLInput } from './fetch-url';
import DESCRIPTION from './fetch-url.md?raw';

export class FetchURLTool implements IFetchURLTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'FetchURL' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FetchURLInputSchema);

  constructor(@INbSearchService private readonly nbSearch: INbSearchService) {}

  resolveExecution(args: FetchURLInput): ToolExecution {
    const preview = args.url.length > 50 ? `${args.url.slice(0, 50)}…` : args.url;
    return {
      accesses: ToolAccesses.none(),
      description: `Fetching: ${preview}`,
      display: { kind: 'url_fetch', url: args.url },
      approvalRule: literalRulePattern(this.name, args.url),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.url),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: FetchURLInput,
    { toolCallId, signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.nbSearch.fetch(args.url, { requestId: toolCallId, signal });
      signal.throwIfAborted();
      return renderFetchResult(result);
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        output: `Failed to fetch URL due to network error: ${args.url}. ${message}`,
      };
    }
  }
}

function renderFetchResult(envelope: FetchRunSyncEnvelope): ExecutableToolResult {
  const content = envelope.documents.map(renderDocument).filter((value) => value.length > 0).join('\n\n---\n\n');
  if (envelope.status === 'succeeded' && content.length > 0) {
    return { isError: false, output: content };
  }
  const detail = classifyFetchFailure(envelope.error, envelope.status);
  if (content.length === 0) {
    return { isError: true, output: detail };
  }
  const builder = new ToolOutputAccumulator();
  builder.write(content);
  return builder.error(detail);
}

function renderDocument(document: FetchDocument): string {
  if (document.content.length === 0) return '';
  const note = isExtracted(document)
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
