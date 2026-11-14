import { appendFileSync, writeFileSync } from 'node:fs';

export async function openPanelStream(name, args, session, context) {
  if (args?.startedPath) writeFileSync(args.startedPath, 'started');
  context.signal.addEventListener('abort', () => {
    if (args?.abortedPath) writeFileSync(args.abortedPath, 'aborted');
  }, { once: true });
  if (name === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (args?.completedPath) writeFileSync(args.completedPath, 'completed');
  }
  if (name === 'fail') throw new Error('Stream fixture failure');
  session.sendBinary(new Uint8Array([0, 255, 2, 3]));
  session.sendText({ hello: name });
  const handlers = {
    onBinary(chunk) {
      if (args?.inputPath) appendFileSync(args.inputPath, 'binary\n');
      session.sendBinary(chunk);
    },
    onText(text) {
      if (args?.inputPath) appendFileSync(args.inputPath, `${text}\n`);
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
