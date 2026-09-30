import { useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import type { SystemBlock } from '@kiki/session-core/session';

import { useI18n } from '../../i18n';
import { kikiHookParts, type KikiHookEvent } from '../harness/kikiHook';
import { Icon } from '../icons';
import { ActivityRow } from './ActivityRow';
import { useFindReveal } from './findReveal';

/** Product names of the engines the hook bridge serves; the id stays as-is for anything else. */
const HARNESS_NAMES: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build', antigravity: 'Antigravity',
};

const EVENT_KEYS: Record<string, I18nKey> = {
  SessionStart: 'transcript.kikiHook.event.SessionStart',
  UserPromptSubmit: 'transcript.kikiHook.event.UserPromptSubmit',
  PreCompact: 'transcript.kikiHook.event.PreCompact',
  PostCompact: 'transcript.kikiHook.event.PostCompact',
  PreInvocation: 'transcript.kikiHook.event.PreInvocation',
  PreToolUse: 'transcript.kikiHook.event.PreToolUse',
  Stop: 'transcript.kikiHook.event.Stop',
};

const ORIGIN_KEYS: Record<string, I18nKey> = {
  memory: 'transcript.kikiHook.part.memory',
  goal_state: 'transcript.kikiHook.part.goal_state',
  todo_state: 'transcript.kikiHook.part.todo_state',
  handoff: 'transcript.kikiHook.part.handoff',
  task: 'transcript.kikiHook.part.task',
  agent_message: 'transcript.kikiHook.part.agent_message',
};

function partLabel(t: ReturnType<typeof useI18n>['t'], origin: string): string {
  if (origin === '') return t('transcript.kikiHook.part.other');
  if (origin.startsWith('injection:')) return t('transcript.kikiHook.part.injection');
  return ORIGIN_KEYS[origin] === undefined ? origin : t(ORIGIN_KEYS[origin]);
}

/**
 * Context Kiki's own hooks handed an external engine: who (the engine), when
 * (the hook moment) and what (the labelled parts, folded). A PreCompact row
 * only readied the compaction handoff; it says so in the outcome column and
 * never reads as delivered.
 */
export function KikiHookRow({ block, hook }: { block: SystemBlock; hook: KikiHookEvent }) {
  const { t, time } = useI18n();
  const [open, setOpen] = useState(false);
  useFindReveal(block.id, open, setOpen);
  const parts = kikiHookParts(block.text);
  const engine = HARNESS_NAMES[hook.harness] ?? hook.harness;
  const moment = EVENT_KEYS[hook.event] === undefined ? hook.event : t(EVENT_KEYS[hook.event]!);
  const kinds = [...new Set(parts.map((part) => partLabel(t, part.origin)))];
  return (
    <ActivityRow
      attrs={{ 'data-system': 'hook_result', 'data-kiki-hook': `${hook.harness}:${hook.event}`, 'data-hook-outcome': hook.prepared ? 'prepared' : 'injected' }}
      glyph={<Icon name={hook.prepared ? 'notes' : 'memory'} />}
      label={t(hook.prepared ? 'transcript.kikiHook.labelPrepared' : 'transcript.kikiHook.label', { engine })}
      detail={<span><span className="text-ink-soft">{moment}</span>{kinds.length > 0 ? <span> · {kinds.join(t('transcript.kikiHook.listSep'))}</span> : null}</span>}
      meta={hook.prepared ? <span data-hook-prepared className="text-ink-faint">{t('transcript.kikiHook.prepared')}</span> : undefined}
      metaWidth="auto"
      title={[`kiki:${hook.harness}:${hook.event}`, time.absoluteTime(block.createdAt)].filter(Boolean).join(' · ')}
      expanded={open}
      onToggle={parts.length === 0 ? undefined : () => { setOpen((value) => !value); }}
    >
      {open ? (
        <div data-kiki-hook-body className="max-h-[260px] space-y-2.5 overflow-auto border-l border-hairline pr-2 pl-3 text-[12px] leading-relaxed">
          {hook.prepared ? <p className="text-ink-soft">{t('transcript.kikiHook.preparedBody', { engine })}</p> : null}
          {parts.map((part, index) => (
            <section key={`${part.origin}-${index}`} data-kiki-hook-part={part.origin || 'other'} className="min-w-0">
              <h4 className="text-[11.5px] font-medium text-ink-soft">{partLabel(t, part.origin)}</h4>
              <p className="whitespace-pre-wrap break-words text-ink-faint">{part.text}</p>
            </section>
          ))}
        </div>
      ) : undefined}
    </ActivityRow>
  );
}
