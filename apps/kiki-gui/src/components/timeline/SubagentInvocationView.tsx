import { createContext, memo, useContext, useEffect, useRef, useState } from 'react';
import type { ToolBlock } from '@kiki/session-core';

import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
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

export function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" aria-label={t('cb.copy')} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:bg-paper hover:text-ink"
      onClick={() => { void copyTextToClipboard(text).then(() => { setCopied(true); }).catch(() => { setCopied(false); }); }}>
      <Icon name={copied ? 'check' : 'copy'} size={12} />{t(copied ? 'cb.copied' : 'cb.copy')}
    </button>
  );
}

const WELL = 'max-h-60 overflow-auto rounded-md bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink select-text';
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

export const SubagentInvocationView = memo(function SubagentInvocationView({ toolBlock }: { toolBlock: ToolBlock }) {
  const { t } = useI18n();
  const args = isObject(toolBlock.args) ? toolBlock.args : undefined;
  const textFields = args === undefined ? [] : Object.entries(args).filter(([key, value]) => (key === 'prompt' || key === 'message') && typeof value === 'string');
  const parameters = args === undefined ? undefined : Object.fromEntries(Object.entries(args).filter(([key, value]) => !((key === 'prompt' || key === 'message') && typeof value === 'string')));
  const receipt = toolBlock.name === 'AgentRun' && typeof toolBlock.output === 'string' ? parseAgentReceipt(toolBlock.output) : undefined;
  const advisories = receipt?.advisories ?? (receipt?.first === undefined ? [] : [receipt.first]);
  return (
    <div data-invocation-tool={toolBlock.toolCallId} className="space-y-3 text-ink">
      <div>
        <div className="mb-1 flex items-center justify-between text-[12px] font-medium text-ink-faint">
          <span>{t('tc.input')}</span><CopyButton text={toolBlock.argsText || asText(toolBlock.args)} />
        </div>
        <pre className={WELL}>{args === undefined ? toolBlock.argsText || (toolBlock.args === undefined ? t('tc.noInput') : asText(toolBlock.args)) : asText(parameters)}</pre>
        {textFields.map(([key, value]) => (
          <details key={key} className="mt-1" data-invocation-text={key}>
            <summary className="cursor-pointer text-[12px] text-ink-faint">
              {t(key === 'prompt' ? 'subagent.call.expandPrompt' : 'subagent.call.expandMessage', { count: (value as string).length })}
            </summary>
            <div className="flex justify-end"><CopyButton text={value as string} /></div>
            <pre className={WELL}>{value as string}</pre>
          </details>
        ))}
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between text-[12px] font-medium text-ink-faint">
          <span>{t('tc.output')}{toolBlock.isError === true ? t('tc.outputError') : ''}</span>
          {toolBlock.output === undefined ? null : <CopyButton text={asText(toolBlock.output)} />}
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
        <pre data-invocation-output className={`${WELL} ${toolBlock.isError === true ? 'text-danger' : ''}`}>
          {toolBlock.output === undefined ? t(toolBlock.status === 'running' ? 'subagent.call.noOutputYet' : 'subagent.call.noOutput') : asText(toolBlock.output)}
        </pre>
      </div>
    </div>
  );
});

export function useInvocationDetails(toolCallId: string | undefined, callerAgentId?: string, compact = false) {
  const { t } = useI18n();
  const context = useContext(InvocationContext);
  const [open, setOpen] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const fetching = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const sameCaller = callerAgentId === undefined || callerAgentId === context?.callerAgentId;
  const tool = sameCaller ? context?.tools.get(toolCallId ?? '') : undefined;
  useEffect(() => {
    if (!open || !sameCaller || tool !== undefined || !context?.hasMore || exhausted || fetching.current) return;
    fetching.current = true;
    void context.loadOlder().then((more) => { if (!more) setExhausted(true); }).catch(() => { setExhausted(true); }).finally(() => {
      fetching.current = false;
      setAttempt((value) => value + 1);
    });
  }, [open, sameCaller, tool, context, exhausted, attempt]);
  const button = toolCallId === undefined || !sameCaller ? null : (
    <button type="button" data-invocation-toggle={toolCallId} aria-expanded={open}
      aria-label={t(open ? 'subagent.call.collapseDetails' : 'subagent.call.expandDetails')}
      title={t('subagent.call.details')}
      onClick={() => { setOpen((value) => !value); }}
      className={compact
        ? 'inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-ink-faint hover:bg-panel hover:text-ink'
        : 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-paper hover:text-ink'}>
      {compact ? <Icon name="file" size={12} /> : null}
      {compact ? <span className="sr-only @[480px]:not-sr-only">{t('subagent.call.details')}</span> : null}
      {compact ? null : <DisclosureChevron open={open} className="text-current" />}
    </button>
  );
  const body = !open ? null : (
    <div className="mt-1 space-y-3 border-l border-hairline pl-3" role="region" aria-label={t('subagent.call.details')}>
      {tool === undefined ? <p className="text-[12px] text-ink-faint">{t(context?.hasMore && !exhausted ? 'subagent.call.loading' : 'subagent.call.unavailable')}</p> : <SubagentInvocationView key={tool.toolCallId} toolBlock={tool} />}
    </div>
  );
  return { button, body };
}
