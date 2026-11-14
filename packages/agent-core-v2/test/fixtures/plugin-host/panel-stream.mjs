import { writeFileSync } from 'node:fs';

export function openPanelStream(name, args, session, context) {
  if (name === 'fail') throw new Error('Stream fixture failure');
  session.sendBinary(new Uint8Array([0, 255, 2, 3]));
  session.sendText({ hello: name });
  const handlers = {
    onBinary(chunk) { session.sendBinary(chunk); },
    onText(text) {
      if (text === 'exit') { process.exit(0); return; }
      if (text === 'close') session.close('Plugin finished');
      else session.sendText(text);
    },
    onClose(reason) {
      if (args?.closedPath) writeFileSync(args.closedPath, JSON.stringify({ reason, aborted: context.signal.aborted }));
    },
  };
  if (name === 'handlers') return { result: { protocol: 'h264-scrcpy-v1' }, ...handlers };
  session.onBinary(handlers.onBinary);
  session.onText(handlers.onText);
  session.onClose(handlers.onClose);
  return { protocol: 'h264-scrcpy-v1', width: 1080, height: 1920, panelId: context.panelId, sessionId: context.sessionId, workspaceId: context.workspaceId };
}
