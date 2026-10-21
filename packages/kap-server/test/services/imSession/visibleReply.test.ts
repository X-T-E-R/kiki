import { describe, expect, it } from 'vitest';

import { visibleReplyMessages } from '../../../src/services/imSession/host';

describe('visible IM reply messages', () => {
  it('returns the assistant text for the prompt turn after an injected reminder', () => {
    const messages = [
      { id: 'im:1', role: 'user', origin: { kind: 'user' }, source: { turnId: 0 }, content: [{ type: 'text', text: 'turn-hello' }] },
      { id: 'reminder', role: 'user', origin: { kind: 'injection', variant: 'runtime_snapshot' }, content: [{ type: 'text', text: '<system-reminder>\nworkspace\n</system-reminder>' }] },
      { id: 'assistant', role: 'assistant', source: { turnId: 0 }, content: [{ type: 'text', text: 'reply-turn-hello' }] },
    ];
    expect(visibleReplyMessages(messages, 'im:1').map((item) => item.content[0]?.text)).toEqual(['reply-turn-hello']);
  });

  it('skips an injection when the prompt has no turn id yet and stops at the next person', () => {
    const messages = [
      { id: 'im:1', role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] },
      { id: 'reminder', role: 'user', origin: { kind: 'injection' }, content: [{ type: 'text', text: '<system-reminder>\nx\n</system-reminder>' }] },
      { id: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'one' }] },
      { id: 'im:2', role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'b' }] },
      { id: 'later', role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    ];
    expect(visibleReplyMessages(messages, 'im:1').map((item) => item.id)).toEqual(['assistant']);
  });
});
