import net from 'node:net';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
const [root, session, namespace, id] = process.argv.slice(2);
const directory = join(root, 'namespaces', namespace, 'run');
await mkdir(directory, { recursive: true });
const tabs = [{ tabId: 't1', targetId: `${id}-target`, title: id, url: 'about:blank', active: true }];
let active = tabs[0];
let frame = 'main';
const commands = [];
const server = net.createServer(socket => {
  let line = '';
  const onData = async chunk => {
    line += chunk;
    if (!line.includes('\n')) return;
    const command = JSON.parse(line.split('\n')[0]);
    commands.push(command);
    await writeFile(join(root, `${id}-commands.json`), JSON.stringify(commands));
    let data = {};
    switch (command.action) {
      case 'launch': data = { launched: true }; break;
      case 'session_info': data = { backgroundPid: process.pid, browserLaunched: true, pageCount: tabs.length }; break;
      case 'tab_list': case 'tablist': data = { tabs }; break;
      case 'tab_new': case 'tabnew': { active = { tabId: `t${tabs.length + 1}`, targetId: `${id}-target-${tabs.length + 1}`, title: id, url: command.url ?? 'about:blank', active: true }; tabs.push(active); data = active; break; }
      case 'tab_switch': case 'tabswitch': { active = tabs.find(tab => tab.targetId === command.tabId || tab.tabId === command.tabId); data = active ?? {}; break; }
      case 'mainframe': frame = 'main'; data = { frame }; break;
      case 'frame': frame = command.selector ?? command.name ?? command.frame; data = { frame }; break;
      case 'snapshot': data = { snapshot: `- button ${id}`, refs: { '@e1': { role: 'button', name: id } }, origin: 'about:blank' }; break;
      case 'click': { if (command.selector === '#lose-response') { socket.destroy(); return; } data = { clicked: true, targetId: active?.targetId, frame }; break; }
      case 'upload': { const values = []; for (const path of command.files ?? []) values.push(await readFile(path, 'utf8')); data = { uploaded: values.length, values }; break; }
      case 'download': await writeFile(command.path, `download-from-${id}`); data = { path: command.path }; break;
      case 'close': data = { closed: true }; setTimeout(() => {
        void Promise.all(['pid', 'port', 'version', 'config'].map(extension => rm(join(directory, `${session}.${extension}`), { force: true }))).then(() => {
          server.close(); process.exit(0);
        });
      }, 150); break;
      default: data = { action: command.action, targetId: active?.targetId, frame };
    }
    socket.end(JSON.stringify({ success: true, data }) + '\n');
  };
  socket.on('data', chunk => { void onData(chunk); });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await Promise.all([
  writeFile(join(directory, `${session}.port`), String(server.address().port)),
  writeFile(join(directory, `${session}.pid`), String(process.pid)),
  writeFile(join(directory, `${session}.version`), '0.38.2'),
  writeFile(join(directory, `${session}.config`), '8ac7231d51426f23'),
]);
process.stdout.write('ready\n');
