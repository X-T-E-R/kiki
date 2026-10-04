import type { Klient } from '@kiki/klient';
import { webAccessEnableInputSchema, type WebAccessEnableInput } from '@kiki/protocol';

export async function executeWebCommand(klient: Klient, args: string): Promise<{ message: string; openUrl?: string }> {
  const web = klient.rest?.webAccess;
  if (web === undefined) throw new Error('This daemon does not expose Web access.');
  const tokens = args.trim() === '' ? [] : args.trim().split(/\s+/u);
  const action = tokens[0]?.startsWith('--') || tokens.length === 0 ? 'temporary' : tokens.shift()!;
  let open = true;
  const input: WebAccessEnableInput = { mode: action === 'persistent' ? 'persistent' : 'temporary' };
  let sessionId: string | undefined;
  if (action === 'revoke' && tokens[0] !== undefined && !tokens[0].startsWith('--')) sessionId = tokens.shift();
  while (tokens.length > 0) {
    const flag = tokens.shift();
    if (flag === '--no-open') { open = false; continue; }
    if (flag === '--insecure-no-tls') { input.insecureNoTls = true; continue; }
    if (!['--host', '--port', '--public-url'].includes(flag!)) throw new Error('Use /web temporary|persistent|status|off|link|revoke [id], with --host, --port, --public-url, --insecure-no-tls or --no-open.');
    const value = tokens.shift(); if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    if (flag === '--host') input.host = value;
    if (flag === '--port') input.port = Number(value);
    if (flag === '--public-url') input.publicUrl = value;
  }
  if (!['temporary', 'persistent', 'status', 'off', 'link', 'revoke'].includes(action)) throw new Error('Use /web temporary|persistent|status|off|link|revoke [id].');
  if (['status', 'off', 'revoke', 'link'].includes(action) && Object.keys(input).length > 1) throw new Error('Network options apply to /web temporary or /web persistent.');
  if (sessionId !== undefined && !/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error('Invalid browser session id.');
  if (['status', 'off', 'revoke'].includes(action)) {
    const status = action === 'off' ? await web.disable() : action === 'revoke' ? await web.revoke(sessionId) : await web.status();
    if (!status.enabled) return { message: 'Web access is off. Links handed out earlier no longer work. Kiki and its running tasks keep going.' };
    const browsers = status.sessions.map((s) => `${s.label} (${s.id})`).join(', ');
    return {
      message: [
        `Web access is on — ${modeLabel(status.mode)}. ${status.url ?? ''}`.trim(),
        'Anyone holding the link can use this Kiki in full.',
        ...(status.insecure ? ['This address is plain HTTP: what is sent is not encrypted.'] : []),
        browsers === '' ? 'No browser has used a link yet.' : `Browsers: ${browsers}`,
      ].join('\n'),
    };
  }
  const status = action === 'link' ? await web.status() : await web.enable(webAccessEnableInputSchema.parse(input));
  const link = await web.issueLink();
  return {
    message: [
      `Web access is on — ${modeLabel(status.mode)}.`,
      link.url,
      'This link works once and expires in 10 minutes. Whoever opens it can use this Kiki in full.',
      ...(status.insecure ? ['This address is plain HTTP: what is sent is not encrypted.'] : []),
      'Use /web off to close access without stopping Kiki.',
    ].join('\n'),
    openUrl: open ? link.url : undefined,
  };
}

/**
 * How long the door stays open. "Temporary" says nothing about what can be
 * done through it, so it must never be shortened into a permission word.
 */
function modeLabel(mode: string | null): string {
  return mode === 'persistent' ? 'always on' : 'temporary';
}
