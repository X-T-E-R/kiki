/**
 * Prompt prose on the model page, for one identity scope.
 *
 * The bodies come from the engine's `cognition_bodies` projection rather than
 * from the model entity, because only the engine knows what a slot's reference
 * currently resolves to. That matters for the main question this section
 * answers: whether the text on screen is something the person may change.
 *
 * Two rules are load-bearing and are enforced by how this renders:
 *
 *   - A readable file-backed slot can be edited as model-owned prose when the
 *     projection permits writing. Its source files are never modified here.
 *   - Saving a slot the person edited writes the text into the model and leaves
 *     the file untouched. That is stated next to the control before the save,
 *     because it is the one conversion here that cannot be undone from this page
 *     except by configuring the original reference again.
 */

import { useState } from 'react';

import type { ModelCognitionBodies } from '@kiki/protocol';

import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import {
  COGNITION_SLOTS, initialSlotText, restoreHint, savesAsInlineText, slotView,
  type CognitionSlot, type SlotView,
} from './modelCognitionBodies';
import type { EditScope } from './modelEditScope';
import { Hint } from '../controls';
import { SMALL_INPUT } from '../ui';

const SLOT_LABEL = {
  overlay: 'st.modelPrompt.system',
  steering: 'st.modelPrompt.steer',
  anchor: 'st.modelPrompt.anchor',
} as const satisfies Readonly<Record<CognitionSlot, I18nKey>>;

/**
 * The label follows what the slot actually holds.
 *
 * These three slots usually point at a file, but they do not have to: a slot can
 * hold text stored on the model, or nothing yet. Calling an inline body "Prompt
 * file" would tell the reader the opposite of the truth, and the path beside it
 * is what names the file when there is one.
 */
function slotLabelKey(slot: CognitionSlot, view: SlotView | undefined): I18nKey {
  return view?.source === 'files' ? SLOT_LABEL_FILE[slot] : SLOT_LABEL[slot];
}

const SLOT_LABEL_FILE = {
  overlay: 'st.modelPrompt.systemFile',
  steering: 'st.modelPrompt.steerFile',
  anchor: 'st.modelPrompt.anchorFile',
} as const satisfies Readonly<Record<CognitionSlot, I18nKey>>;

export function ModelPromptBodies({
  modelId,
  bodies,
  scope,
  branchSelection,
  draft,
  onDraftChange,
  disabled = false,
}: {
  modelId: string;
  bodies: ModelCognitionBodies | undefined;
  scope: EditScope;
  /** `off` for an identity that takes no model cognition at all. */
  branchSelection: 'common' | 'custom' | 'off';
  draft: Record<string, string>;
  onDraftChange: (slot: CognitionSlot, text: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  if (branchSelection === 'off') {
    return (
      <div className="min-w-0 space-y-3" data-model-prompt-bodies={scope}>
        <p className="text-[12px] leading-5 text-ink-soft" data-prompt-bodies-off>
          {t('st.modelPrompt.identityOff')}
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4" data-model-prompt-bodies={scope} data-model={modelId}>
      {scope !== 'shared' && branchSelection === 'common' ? (
        <Hint><span data-prompt-identity-inherited>{t('st.modelPrompt.identityInherited')}</span></Hint>
      ) : null}
      {COGNITION_SLOTS.map((slot) => {
        const view = slotView(bodies, scope, slot);
        return (
          <PromptBodyField
            key={slot}
            slot={slot}
            label={t(slotLabelKey(slot, view))}
            view={view}
            text={draft[slot] ?? initialSlotText(view)}
            disabled={disabled}
            onChange={(text) => { onDraftChange(slot, text); }}
          />
        );
      })}
      {bodies === undefined ? (
        <Hint>{t('st.modelPrompt.bodiesUnavailable')}</Hint>
      ) : null}
    </div>
  );
}

/** One slot: its prose, where it came from, and whether it can be changed. */
function PromptBodyField({ slot, label, view, text, onChange, disabled }: {
  slot: CognitionSlot;
  label: string;
  view: SlotView | undefined;
  text: string;
  onChange: (text: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  // A read failure is stated, never rendered as empty prose: an empty box would
  // look like a decision the person had made.
  if (view?.error !== undefined) {
    return (
      <div className="space-y-1.5" data-prompt-body={slot} data-prompt-body-source="error">
        <p className="text-[12px] font-medium text-ink-soft">{label}</p>
        <p role="alert" className="text-[12px] leading-5 text-danger">{view.error}</p>
        {view.files.length === 0 ? null : (
          <p className="break-all font-mono text-[11px] text-ink-faint">{view.files.map((file) => file.path).join('\n')}</p>
        )}
      </div>
    );
  }

  const editable = view === undefined || view.writable;

  return (
    <div className="space-y-1.5" data-prompt-body={slot} data-prompt-body-source={view?.source ?? 'unset'}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-[12px] font-medium text-ink-soft">{label}</p>
        {view === undefined || view.source === 'unset' ? null : (
          <span className="font-mono text-[11px] text-ink-faint" data-prompt-body-origin={slot}>
            {view.source === 'files' ? view.files.map((file) => file.path).join(', ') : t('st.modelPrompt.inlineBody')}
          </span>
        )}
      </div>

      {editable ? (
        <>
          {/*
            An unset slot has no prose to show, and an empty box would read as
            "the person decided to say nothing here" rather than "nothing is
            stored yet". The placeholder says which it is.
          */}
          <textarea rows={8} spellCheck={false} disabled={disabled} aria-label={label}
            placeholder={view?.source === 'unset' || view === undefined ? t('st.modelPrompt.emptySlot') : undefined}
            className={`${SMALL_INPUT} h-auto w-full resize-y font-mono text-[12px] leading-5`}
            data-prompt-body-editor={slot} value={text}
            onChange={(event) => { onChange(event.target.value); }} />
          {/*
            A slot backed by an author file is a one-way move: saving stores the
            text on the model and the file itself is untouched. That is said once
            per slot, next to the words it describes, rather than as a question —
            the conversion is the ordinary result of editing and saving, and a
            person who wanted the file itself would be editing that file.
          */}
          {view !== undefined && savesAsInlineText(view) ? (
            <p className="text-[11.5px] leading-5 text-ink-faint" data-prompt-convert-notice={slot}>{t('st.modelPrompt.savingConvertsHint')}</p>
          ) : null}
        </>
      ) : (
        <>
          {/*
            Read-only does not mean unreadable: the prose is selectable so it can
            be checked and copied, and the paths stay visible so the original
            can be restored.
          */}
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-ink/[0.035] px-3 py-2 font-mono text-[12px] leading-5 text-ink-soft select-text"
            data-prompt-body-readonly={slot}>{view?.text ?? ''}</pre>
          <div className="space-y-1">
            <button type="button"
              className="text-[11.5px] text-ink-soft underline decoration-ink/20 underline-offset-4 hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40"
              data-prompt-body-expand={slot}
              onClick={() => { setExpanded(!expanded); }}>
              {t(expanded ? 'st.modelPrompt.hideFiles' : 'st.modelPrompt.showFiles', { count: String(view?.files.length ?? 0) })}
            </button>
            {expanded ? (
              <ul className="space-y-1.5" data-prompt-body-files={slot}>
                {(view?.files ?? []).map((file) => (
                  <li key={file.path} className="space-y-0.5">
                    <p className="break-all font-mono text-[11px] text-ink-faint">{file.path}</p>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-ink/[0.03] px-2 py-1.5 font-mono text-[11px] leading-4 text-ink-soft select-text">{file.text}</pre>
                  </li>
                ))}
              </ul>
            ) : null}
            {restoreHint(view ?? { slot: 'overlay', source: 'unset', text: '', files: [], writable: false, sourceReadOnly: true, error: undefined }) === undefined ? null : (
              <p className="text-[11px] leading-5 text-ink-faint">{t('st.modelPrompt.restoreHint')}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}