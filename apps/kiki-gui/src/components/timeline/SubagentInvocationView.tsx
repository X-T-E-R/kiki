import { createContext, memo, useContext, useEffect, useState } from 'react';
import type { ToolBlock } from '@kiki/session-core';
import type { SessionViewTranscriptDetail } from '@kiki/klient/session-view';
import { ContentContinuation, frameContentSource, INPUT_ROOTS, INPUT_TEXT_ROOTS, OUTPUT_ROOTS } from '../ContentContinuation';
import { useTranscriptController, useTranscriptTarget } from '../transcriptDetail';
import { ReadableToolText } from './LoadedToolText';

import { useI18n } from '../../i18n';
import { CopyButton } from './ContentCopyButton';
import { DisclosureChevron, Icon } from '../icons';

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseAgentReceipt(output: string): {
  headers: Readonly<Record<string, string>>;
  advisories?: readonly JsonObject[];
  first?: JsonObject;
} {
  const headers: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') break;
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const parse = (key: string): unknown => {
    try { return JSON.parse(headers[key] ?? ''); } catch { return undefined; }
  };
  const list = parse('binding_advisories');
  const first = parse('binding_advisory_first');
  return {
    headers,
    advisories: Array.isArray(list) && list.every(isObject) ? list : undefined,
    first: isObject(first) ? first : undefined,
  };
}

export const InvocationContext = createContext<{
  callerAgentId: string;
  tools: ReadonlyMap<string, ToolBlock>;
  hasMore: boolean;
  loadOlder: () => Promise<boolean>;
} | null>(null);

const WELL = 'max-h-60 overflow-auto rounded-md bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink select-text';
/**
 * The caller's own words, read rather than scanned: the same paper-ink prose
 * face the transcript gives a message body, at the reading column's smaller
 * measure so an invocation's text never outweighs the turn it belongs to. It
 * takes the page rather than a well — this is the one thing in the record a
 * reader came to read, and a boxed panel would frame it as another field
 * beside the envelope. The scroll stays, because a long body is still a body
 * and the well's selection is what a reader copies from.
 */
const SAID = 'kiki-prose max-h-72 overflow-auto px-1 py-0.5 !text-[13.5px] whitespace-pre-wrap break-words text-ink select-text';
const asText = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);

function AdvisoriesRow({
  advisories,
  countHeader,
  hasAdvisoriesHeader,
}: {
  advisories: readonly JsonObject[];
  countHeader?: string;
  hasAdvisoriesHeader: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const label = !hasAdvisoriesHeader
    ? t('subagent.call.advisoriesLegacy', { count: countHeader ?? '?' })
    : `${t('subagent.call.advisories')} (${advisories.length})`;

  return (
    <div className="mb-2" data-binding-advisories>
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        className="inline-flex items-center gap-1 text-[12px] text-ink-faint transition-colors hover:text-ink"
      >
        <DisclosureChevron open={open} className="text-current" />
        <span>{label}</span>
      </button>
      {open ? (
        <div className="mt-1 space-y-1">
          {advisories.map((advisory, index) => <pre key={index} className={WELL}>{asText(advisory)}</pre>)}
        </div>
      ) : null}
      <div className="sr-only">
        {advisories.map((advisory, index) => <pre key={index}>{asText(advisory)}</pre>)}
      </div>
    </div>
  );
}

export const SubagentInvocationView = memo(function SubagentInvocationView({ toolBlock, callerAgentId }: { toolBlock: ToolBlock; callerAgentId?: string }) {
  const { t } = useI18n();
  const source = frameContentSource(toolBlock);
  const controller = useTranscriptController();
  const target = useTranscriptTarget();
  const caller = callerAgentId ?? target?.agentId;
  const prepare = (root: 'input' | 'output') => controller === undefined || caller === undefined ? undefined : (signal: AbortSignal) => controller.copyToolCallField(caller, toolBlock.toolCallId, root, signal);
  const rangeField = (field: string) => controller !== undefined && caller !== undefined && source !== undefined && controller.contentRefsFor(caller, source).some((ref) => ref.path.length === 1 && ref.path[0] === field && controller.isContentRange(caller, ref));
  const args = isObject(toolBlock.args) ? toolBlock.args : undefined;
  const textFields = args === undefined ? [] : Object.entries(args).filter(([key, value]) => (key === 'prompt' || key === 'message') && typeof value === 'string');
  const parameters = args === undefined ? undefined : Object.fromEntries(Object.entries(args).filter(([key, value]) => !((key === 'prompt' || key === 'message') && typeof value === 'string')));
  const receipt = toolBlock.name === 'AgentRun' && typeof toolBlock.output === 'string' ? parseAgentReceipt(toolBlock.output) : undefined;
  const advisories = receipt?.advisories ?? (receipt?.first === undefined ? [] : [receipt.first]);
  // The text a caller handed this agent IS the body of the invocation: it is
  // what the reader opened the call to read, so it leads the input section,
  // named by its own field and copyable verbatim, with nothing of it left to a
  // second press. The remaining arguments are the machine envelope around that
  // text — a separate object, and with nothing left of it, nothing to show.
  const envelope = rangeField('input') || rangeField('inputText') ? undefined : args === undefined ? toolBlock.argsText || (toolBlock.args === undefined ? t('tc.noInput') : asText(toolBlock.args)) : asText(parameters);
  return (
    <div data-invocation-tool={toolBlock.toolCallId} className="space-y-3 text-ink">
      <div>
        <div className="mb-1 flex items-center justify-between text-[12px] font-medium text-ink-faint">
          <span>{t('tc.input')}</span><CopyButton label={t('tc.input')} text={toolBlock.argsText || asText(toolBlock.args)} prepare={prepare('input')} />
        </div>
        {textFields.map(([key, value]) => (
          <div key={key} className={envelope === undefined ? undefined : 'mb-3'} data-invocation-text={key}>
            <div className="mb-1 flex items-center justify-between text-[12px] text-ink-faint">
              <span>{t(key === 'prompt' ? 'tc.sem.prompt' : 'tc.sem.message')}</span>
              <CopyButton label={t(key === 'prompt' ? 'tc.sem.prompt' : 'tc.sem.message')} text={value as string} prepare={controller === undefined || caller === undefined || source === undefined ? undefined : (signal: AbortSignal) => controller.copyContentField(caller, source, ['input', key], signal)} />
            </div>
            <ReadableToolText text={value as string} className={SAID} />
          </div>
        ))}
        {envelope === undefined || envelope === '{}' ? null : <ReadableToolText text={envelope} className={WELL} />}
        <ContentContinuation source={source} roots={toolBlock.args === undefined ? INPUT_TEXT_ROOTS : INPUT_ROOTS} callerAgentId={callerAgentId} label={t('tc.input')} headingPresent />
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between text-[12px] font-medium text-ink-faint">
          <span>{t('tc.output')}{toolBlock.isError === true ? t('tc.outputError') : ''}</span>
          {toolBlock.output === undefined ? null : <CopyButton label={t('tc.output')} text={asText(toolBlock.output)} prepare={prepare('output')} />}
        </div>
        {receipt === undefined ? null : (
          <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] font-mono text-ink-soft">
            {['task_id', 'agent_id', 'actual_profile'].map((key) => receipt.headers[key] === undefined ? null : <span key={key}>{key}: {receipt.headers[key]}</span>)}
          </div>
        )}
        {advisories.length === 0 ? null : (
          <AdvisoriesRow
            advisories={advisories}
            countHeader={receipt?.headers['binding_advisory_count']}
            hasAdvisoriesHeader={receipt?.advisories !== undefined}
          />
        )}
        <div data-invocation-output>{rangeField('output') || rangeField('error') ? null : <ReadableToolText text={toolBlock.output === undefined ? t(toolBlock.status === 'running' ? 'subagent.call.noOutputYet' : 'subagent.call.noOutput') : asText(toolBlock.output)} className={`${WELL} ${toolBlock.isError === true ? 'text-danger' : ''}`} />}</div>
        <ContentContinuation source={source} roots={OUTPUT_ROOTS} callerAgentId={callerAgentId} label={t('tc.output')} headingPresent />
      </div>
    </div>
  );
});

export function useInvocationDetails(toolCallId: string | undefined, callerAgentId?: string, compact = false) {
  const { t } = useI18n();
  const context = useContext(InvocationContext);
  const [open, setOpen] = useState(false);
  const controller = useTranscriptController();
  const target = useTranscriptTarget();
  const caller = callerAgentId ?? context?.callerAgentId ?? target?.agentId;
  const lookupKey = `${target?.sessionId}/${caller}/${toolCallId}/${controller?.getState().transcriptResetVersion ?? 0}`;
  const [lookup, setLookup] = useState<{ key: string; value: Extract<SessionViewTranscriptDetail, { kind: 'tool' }>['lookup'] }>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const current = caller === undefined || toolCallId === undefined ? undefined : controller?.getToolCallDetail(caller, toolCallId) ?? (lookup?.key === lookupKey ? lookup.value : undefined);
  const fallback = caller === context?.callerAgentId ? context?.tools.get(toolCallId ?? '') : undefined;
  const tool = current?.status === 'found' ? invocationTool(current) : fallback;
  useEffect(() => {
    setLookup(undefined);
    setError(undefined);
    if (!open || controller === undefined || caller === undefined || toolCallId === undefined) return;
    const abort = new AbortController();
    void (async () => {
      try {
        while (!abort.signal.aborted) {
          const result = await controller.lookupToolCall(caller, toolCallId, abort.signal);
          if (abort.signal.aborted) return;
          setLookup({ key: lookupKey, value: result });
          if (result.status !== 'preparing') return;
          await new Promise<void>((resolve) => setTimeout(resolve, 80));
        }
      } catch (failure) {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      }
    })();
    return () => { abort.abort(); };
  }, [open, controller, caller, toolCallId, lookupKey, attempt]);
  // The control is the icon, never the word: on the compact card it once shared
  // a white pill with the jump arrow at the row's right edge, which read as a
  // second label rather than a control. The tooltip carries the name, the aria
  // label follows the state, and the chevron is the family's disclosure mark.
  const button = toolCallId === undefined || caller === undefined ? null : (
    <button type="button" data-invocation-toggle={toolCallId} aria-expanded={open}
      data-invocation-open={open || undefined}
      aria-label={t(open ? 'subagent.call.collapseDetails' : 'subagent.call.expandDetails')}
      title={t(open ? 'subagent.call.collapseDetails' : 'subagent.call.expandDetails')}
      onClick={() => { setOpen((value) => !value); }}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${compact ? 'pointer-coarse:h-10 pointer-coarse:w-10' : ''}`}>
      <DisclosureChevron open={open} className="text-current" />
    </button>
  );
  const body = !open ? null : (
    <div className="mt-1 space-y-3 border-l border-hairline pl-3" role="region" aria-label={t('subagent.call.details')}>
      {tool === undefined ? <div className="text-[12px] text-ink-faint"><p>{error !== undefined ? t('subagent.call.failed') : t(current?.status === 'not_found' ? 'subagent.call.unavailable' : current?.status === 'preparing' ? 'subagent.call.preparing' : 'subagent.call.loading')}</p>{error !== undefined ? <button type="button" onClick={() => { setAttempt((value) => value + 1); }} className="mt-1 underline">{t('common.retry')}</button> : null}</div> : <SubagentInvocationView key={`${caller}/${tool.toolCallId}`} callerAgentId={caller} toolBlock={tool} />}
    </div>
  );
  return { button, body };
}

function invocationTool(lookup: Extract<Extract<SessionViewTranscriptDetail, { kind: 'tool' }>['lookup'], { status: 'found' }>): ToolBlock {
  const frame = lookup.frame;
  return { kind: 'tool', id: `tool-${frame.toolCallId}`, toolCallId: frame.toolCallId, name: frame.name, args: frame.input, argsText: frame.inputText ?? '', display: frame.display as ToolBlock['display'], description: undefined, status: frame.state === 'interrupted' ? 'stopped' : frame.state, output: frame.output ?? frame.error, isError: frame.state === 'error', durationMs: undefined, progressText: frame.progress?.text, frameId: frame.frameId, turnId: lookup.turnId, stepId: lookup.stepId };
}
