/**
 * RoomMembersPanel — the room's right rail: who is in the room, what each is
 * doing, and the settings that are the room's own (host, mute, budget,
 * roster). Host, mute and budget change any time; the roster waits while a
 * member holds a turn (the server refuses it), so the panel says so and
 * offers the stop right there instead of failing silently.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { PersonaSummary, RoomDocument, Session, UpdateRoomInput } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { INSPECTOR_LINK, InspectorSection } from '../agent-panel/InspectorSection';
import { Toggle } from '../controls';
import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { PersonaAvatar, personaAvatarOf } from '../persona/PersonaAvatar';
import { SECONDARY_BUTTON, SMALL_INPUT } from '../ui';

export function RoomMembersPanel({
  room,
  personas,
  sessionById,
  running,
  stopFirst,
  busy,
  onUpdate,
  onStop,
  onClose,
}: {
  readonly room: RoomDocument;
  readonly personas: ReadonlyMap<string, PersonaSummary>;
  readonly sessionById: ReadonlyMap<string, Session>;
  /** A member holds a turn or an open question: the roster is locked. */
  readonly running: boolean;
  /** The last roster change was refused because a turn was live. */
  readonly stopFirst: boolean;
  readonly busy: boolean;
  readonly onUpdate: (input: UpdateRoomInput) => void;
  readonly onStop: () => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [budget, setBudget] = useState(String(room.budget.botMessagesPerUserMessage));
  const [adding, setAdding] = useState('');
  const budgetValue = Number(budget);
  const budgetValid = Number.isInteger(budgetValue) && budgetValue >= 1 && budgetValue <= 1000;
  const budgetDirty = budgetValid && budgetValue !== room.budget.botMessagesPerUserMessage;
  const membersInput = (members: RoomDocument['members']) => members.map((member) => ({ personaId: member.personaId, muted: member.muted }));
  const candidates = [...personas.values()].filter((persona) => !persona.archived && room.members.every((member) => member.personaId !== persona.id));
  const rosterLocked = running || busy;

  return (
    <aside data-room-members aria-label={t('room.members')}
      className="flex h-full min-h-0 flex-col bg-paper">
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{t('room.members')}</h2>
        <span className="text-[12px] text-ink-faint tabular-nums">{room.members.length}</span>
        <button type="button" onClick={onClose} aria-label={t('room.close')} title={t('room.close')}
          className="-mr-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-7 lg:w-7">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6">
        {stopFirst || running ? (
          <div role={stopFirst ? 'alert' : 'status'} data-room-roster-locked
            className={`flex flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-[12.5px] ${stopFirst ? 'bg-amber-card text-amber-ink' : 'bg-ink/[0.04] text-ink-soft'}`}>
            <span className="leading-5 text-pretty">{stopFirst ? t('room.stopFirst') : t('room.membersLocked')}</span>
            <button type="button" onClick={onStop} disabled={busy} data-room-stop-inline
              className="-mx-1.5 min-h-7 rounded-md px-1.5 text-[12.5px] leading-5 font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-60">
              {t('room.stopAll')}
            </button>
          </div>
        ) : null}

        <ul className="space-y-1">
          {room.members.map((member) => {
            const summary = personas.get(member.personaId);
            const face = summary === undefined ? { id: member.personaId, name: member.personaId } : personaAvatarOf(summary);
            const session = sessionById.get(member.sessionId);
            const waiting = session?.pending_interaction !== undefined;
            const working = session?.busy === true;
            const host = member.personaId === room.host;
            const name = summary?.name ?? member.personaId;
            return (
              <li key={member.personaId} data-room-member={member.personaId} className="rounded-lg py-2">
                <div className="flex items-start gap-2.5">
                  <PersonaAvatar persona={face} size={32} decorative />
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-1.5">
                      <span className={`truncate text-[13px] font-medium ${member.muted ? 'text-ink-soft' : 'text-ink'}`}>{name}</span>
                      {host ? <span className="shrink-0 rounded-full bg-selected px-1.5 text-[11px] leading-[18px] text-selected-ink">{t('room.hostTag')}</span> : null}
                      {member.muted ? <span className="shrink-0 text-[11.5px] text-ink-faint">{t('room.mutedTag')}</span> : null}
                    </p>
                    <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-faint">
                      {working || waiting ? (
                        <>
                          <LifeMark markId={`room-member:${member.sessionId}`} life={waiting ? 'waiting' : 'working'} still
                            tone={waiting ? 'bg-attention' : undefined} />
                          <span className={waiting ? 'text-attention' : 'text-ink-soft'}>
                            {waiting ? t('sidebar.status.question') : t('room.memberWorking')}
                          </span>
                        </>
                      ) : <span className="truncate">{summary?.title ?? summary?.job ?? ''}</span>}
                    </p>
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[42px]">
                  <Link to={`/s/${encodeURIComponent(member.sessionId)}`} className={INSPECTOR_LINK} data-room-member-process>
                    {t('room.openProcess')}
                  </Link>
                  {host ? null : (
                    <button type="button" className={INSPECTOR_LINK} disabled={busy}
                      data-room-set-host onClick={() => { onUpdate({ host: member.personaId }); }}>
                      {t('room.setHost')}
                    </button>
                  )}
                  {room.members.length > 2 && !host ? (
                    <button type="button" className={`${INSPECTOR_LINK} disabled:cursor-not-allowed disabled:opacity-50`}
                      disabled={rosterLocked} title={running ? t('room.membersLocked') : undefined}
                      aria-label={t('room.removeMember', { name })}
                      data-room-remove-member
                      onClick={() => { onUpdate({ members: membersInput(room.members.filter((item) => item.personaId !== member.personaId)) }); }}>
                      {t('room.remove')}
                    </button>
                  ) : null}
                  <span className="ml-auto">
                    <Toggle label={t('room.mute')} checked={member.muted} disabled={busy}
                      onChange={(muted) => {
                        onUpdate({ members: membersInput(room.members.map((item) => item.personaId === member.personaId ? { ...item, muted } : item)) });
                      }} />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>

        {room.members.length < 6 && candidates.length > 0 ? (
          <div className="flex items-center gap-2">
            <select value={adding} aria-label={t('room.addMember')} disabled={rosterLocked}
              onChange={(event) => { setAdding(event.target.value); }}
              className={`${SMALL_INPUT} min-h-8 min-w-0 flex-1 text-[12.5px]`}>
              <option value="">{t('room.addMember')}</option>
              {candidates.map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}
            </select>
            <button type="button" className={SECONDARY_BUTTON} disabled={rosterLocked || adding === ''} data-room-add-member
              onClick={() => {
                onUpdate({ members: [...membersInput(room.members), { personaId: adding, muted: false }] });
                setAdding('');
              }}>
              {t('room.addMember')}
            </button>
          </div>
        ) : null}

        <InspectorSection title={t('room.budget', { count: room.budget.botMessagesPerUserMessage })} collapsible={false} data-room-budget-section>
          <form className="space-y-2" onSubmit={(event) => {
            event.preventDefault();
            if (budgetDirty) onUpdate({ budget: { botMessagesPerUserMessage: budgetValue } });
          }}>
            <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-soft">
              <span>{t('room.budgetLabel')}</span>
              <input type="number" inputMode="numeric" min={1} max={1000} step={1} value={budget}
                data-room-budget-input aria-invalid={!budgetValid}
                onChange={(event) => { setBudget(event.target.value); }}
                className={`${SMALL_INPUT} h-8 w-20 text-right tabular-nums`} />
              <span>{t('room.budgetUnit')}</span>
            </label>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[12px] text-ink-faint tabular-nums">
                {t('room.budgetUsed', { used: room.budgetUsed, limit: room.budget.botMessagesPerUserMessage })}
              </span>
              <button type="submit" className={SECONDARY_BUTTON} disabled={!budgetDirty || busy} data-room-budget-save>
                {t('room.budgetSave')}
              </button>
            </div>
          </form>
        </InspectorSection>
      </div>
    </aside>
  );
}
