import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
let [path, ...args] = process.argv.slice(2);
let config = JSON.parse(await readFile(path, 'utf8'));
for (const [alias, target] of Object.entries(config.aliases ?? {})) if (args.includes(alias)) { path = target; config = JSON.parse(await readFile(path, 'utf8')); break; }
const log = async (event) => appendFile(config.log, JSON.stringify(event) + '\n');
if (!args.includes('-N')) {
  const command = args.at(-1);
  const ensure = command.includes("'--ensure'");
  await log({ kind: ensure ? 'ensure' : 'query', args });
  if (ensure) { config.running = true; await writeFile(path, JSON.stringify(config)); }
  if (config.failQuery) { process.stderr.write((config.failureText ?? 'fixture-private-secret-not-for-log') + '\n'); process.exit(255); }
  process.stdout.write(JSON.stringify(config.running ? { ...config.bootstrap, running: true } : { running: false }) + '\n');
} else {
  const parts = args[args.indexOf('-L') + 1].split(':');
  const server = createServer((socket) => {
    const target = connect(Number(parts[3]), '127.0.0.1');
    socket.pipe(target).pipe(socket);
    socket.on('error', () => target.destroy()); target.on('error', () => socket.destroy());
    socket.on('close', () => target.destroy()); target.on('close', () => socket.destroy());
  });
  server.on('error', () => process.exit(255));
  server.listen(Number(parts[1]), '127.0.0.1', async () => {
    await log({ kind: 'tunnel', port: Number(parts[1]), pid: process.pid });
    if (!config.noReady) process.stderr.write('debug1: Local forwarding listening on 127.0.0.1 port ' + parts[1] + '.\n');
  });
}
