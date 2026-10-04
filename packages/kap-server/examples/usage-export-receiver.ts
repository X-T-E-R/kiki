import { resolve } from 'node:path';
import { UsageExportReceiver, createUsageExportReceiverServer } from '../src/usage/export/receiver';

const receiver = new UsageExportReceiver(resolve('usage-receiver.sqlite'));
const server = createUsageExportReceiverServer(receiver, { hmac: process.env['KIKI_USAGE_RECEIVER_HMAC'] });
server.listen(9080, '127.0.0.1', () => process.stdout.write('Local usage receiver: http://127.0.0.1:9080/usage\n'));
let closing = false;
const close = () => {
  if (closing) return; closing = true;
  server.close(() => receiver.close()); server.closeAllConnections();
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
server.once('error', (error) => { receiver.close(); process.stderr.write(`Receiver failed: ${(error as NodeJS.ErrnoException).code ?? 'network-error'}\n`); process.exitCode = 1; });
