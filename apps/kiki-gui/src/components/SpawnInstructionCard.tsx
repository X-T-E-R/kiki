/**
 * "Instruction from the main agent" card — pinned at the top of the subagent
 * detail page, visually distinct from the conversation below it. Long prompts
 * start clamped to three lines with an expand toggle (repo idiom: button +
 * useState + aria-expanded + rotating chevron).
 */

import { memo, useState } from 'react';

import { useI18n } from '../i18n';

const CLAMP_LENGTH = 240;
const CLAMP_LINES = 3;

export const SpawnInstructionCard = memo(function SpawnInstructionCard({
  prompt,
  fromLabel,
}: {
  prompt: string;
  /** Parent agent display name; undefined/omitted means the main agent. */
  fromLabel?: string;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const collapsible = prompt.length > CLAMP_LENGTH || prompt.split('\n').length > CLAMP_LINES;
  const title = fromLabel === undefined ? t('sv.spawnInstruction') : t('sv.spawnInstructionFrom', { agent: fromLabel });
  return (
    <div
      data-spawn-instruction
      className="rounded-xl border border-accent/30 bg-accent-soft/50 px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="shrink-0 text-[11px] text-accent">
          ↳
        </span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold tracking-[0.06em] text-accent uppercase">
          {title}
        </span>
        {collapsible ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => { setExpanded((value) => !value); }}
            className="flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-ink-soft transition-colors hover:text-accent"
          >
            <span
              aria-hidden
              className={`inline-block text-[8px] transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
            >
              ▶
            </span>
            {expanded ? t('cb.showLess') : t('cb.expand')}
          </button>
        ) : null}
      </div>
      <p
        className={`mt-1 text-[12px] leading-relaxed whitespace-pre-wrap text-ink ${
          collapsible && !expanded ? 'line-clamp-3' : ''
        }`}
      >
        {prompt}
      </p>
    </div>
  );
});
