/**
 * Child-process mailbox writer fixture.
 */

import { MiniDbMailboxBackend } from '../../../../src/app/threadCommunication/miniDbMailboxBackend.ts';

const [dir, writerText, countText] = process.argv.slice(2);
if (dir === undefined || writerText === undefined || countText === undefined) {
  throw new Error('usage: mailbox-writer <dir> <writer> <count>');
}
const writer = Number.parseInt(writerText, 10);
const count = Number.parseInt(countText, 10);
const source = { hostId: 'host-a', workspaceId: 'workspace-a', sessionId: `source-${writer}` };
const target = { hostId: 'host-a', workspaceId: 'workspace-b', sessionId: 'target' };
const store = new MiniDbMailboxBackend(dir);
const seqs: number[] = [];
for (let index = 0; index < count; index++) {
  const accepted = await store.acceptMessage({
    producer: { kind: 'peer_thread', source },
    target,
    content: `writer-${writer}-message-${index}`,
    idempotencyKey: `writer-${writer}-key-${index}`,
  });
  seqs.push(accepted.message.targetSeq);
}
process.stdout.write(JSON.stringify(seqs));
