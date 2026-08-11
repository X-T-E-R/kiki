import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { SessionRouteView, TerminalToggle } from './SessionView';

vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));

function renderTerminalToggle(available: boolean): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <TerminalToggle available={available} open={false} onToggle={() => {}} />
    </I18nProvider>,
  );
}

describe('SessionView terminal capability', () => {
  it('omits the terminal toggle when the server omits terminal capability', () => {
    expect(renderTerminalToggle(false)).not.toContain('data-terminal-toggle');
  });

  it('renders the terminal toggle when the server advertises terminal capability', () => {
    expect(renderTerminalToggle(true)).toContain('data-terminal-toggle');
  });
});

describe('SessionView route ownership', () => {
  it('changes the child owner key synchronously on session A to B navigation', () => {
    const props = { onToggleSidebar: () => {}, sessions: [] };
    const sessionA = SessionRouteView({ ...props, sessionId: 'session-a' });
    const sessionB = SessionRouteView({ ...props, sessionId: 'session-b' });

    expect(sessionA.key).toBe('session-a');
    expect(sessionB.key).toBe('session-b');
    expect(sessionB.key).not.toBe(sessionA.key);
  });
});
