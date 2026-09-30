/**
 * Who the timeline speaks as. SessionView provides it once, so the process
 * view's SendMessage bubbles and "内部" labels, and the message view's rows,
 * read the same identity without threading props through every memo row.
 */

import { createContext, useContext } from 'react';

import type { PersonaAvatarData } from '../persona/PersonaAvatar';

export interface MessageViewContextValue {
  /** The session's bound persona (frozen at creation), when there is one. */
  readonly persona?: PersonaAvatarData;
  readonly sessionId?: string;
  /** Delivery is `message`: plain assistant prose is internal, not speech. */
  readonly internalProse: boolean;
  /** Open another session (a handoff's far side). */
  readonly onOpenSession?: (sessionId: string) => void;
}

export const MessageViewContext = createContext<MessageViewContextValue>({ internalProse: false });

export function useMessageViewContext(): MessageViewContextValue {
  return useContext(MessageViewContext);
}
