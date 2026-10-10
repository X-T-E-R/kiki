import { readFile, writeFile, mkdir, open, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const KEY = 'kiki-agy-permission-bridge';

export function hookCommand(nodePath, handlerPath) {
  if (process.platform !== 'win32') return `"${nodePath}" "${handlerPath}"`;
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $encoding=New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding=$encoding; [Console]::OutputEncoding=$encoding; $OutputEncoding=$encoding; $json=[Console]::In.ReadToEnd(); $json | & ${literal(nodePath)} ${literal(handlerPath)}; exit $LASTEXITCODE`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `${join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')} -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function optional(path) { try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }

function ownedRange(text) {
  JSON.parse(text);
  let i = text.indexOf('{') + 1;
  let previousComma;
  while (i < text.length) {
    while (/\s/.test(text[i] ?? '')) i++;
    if (text[i] === '}') break;
    const start = i;
    let escaped = false;
    i++;
    for (; i < text.length; i++) {
      if (escaped) { escaped = false; continue; }
      if (text[i] === '\\') { escaped = true; continue; }
      if (text[i] === '"') { i++; break; }
    }
    const key = JSON.parse(text.slice(start, i));
    while (/\s/.test(text[i] ?? '')) i++;
    if (text[i++] !== ':') throw Error('Invalid hook object');
    let depth = 0; let string = false; escaped = false;
    for (; i < text.length; i++) {
      const char = text[i];
      if (string) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') string = false;
        continue;
      }
      if (char === '"') string = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') { if (depth === 0) break; depth--; }
      else if (char === ',' && depth === 0) break;
    }
    if (key === KEY) return previousComma === undefined
      ? { start, end: text[i] === ',' ? i + 1 : i }
      : { start: previousComma, end: i };
    previousComma = i;
    i++;
  }
  return undefined;
}

async function atomic(path, bytes) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, bytes, { flag: 'wx' });
  try { await rename(temp, path); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function locked(lockPath, operation) {
  let file;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { file = await open(lockPath, 'wx'); await file.writeFile(JSON.stringify({ pid: process.pid })); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const before = await optional(lockPath);
      if (before?.length) {
        const owner = JSON.parse(before.toString('utf8'));
        if (!processAlive(owner.pid)) {
          const current = await optional(lockPath);
          if (current && sha(current) === sha(before)) await unlink(lockPath);
        }
      }
      await new Promise(done => setTimeout(done, 20));
    }
  }
  if (!file) throw Error('AGY hook registry is busy; preserve the existing registration and retry recovery');
  try { return await operation(); }
  finally { await file.close(); await unlink(lockPath); }
}

export async function registerProjectHook({ cwd, nodePath, handlerPath, sessionId }) {
  const dir = join(cwd, '.agents');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'hooks.json');
  const statePath = join(dir, '.kiki-agy-hook-ownership.json');
  const lockPath = `${statePath}.lock`;
  const definition = { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: hookCommand(nodePath, handlerPath), timeout: 86400 }] }] };
  const definitionHash = sha(JSON.stringify(definition));
  await locked(lockPath, async () => {
    const before = await optional(path);
    const text = before?.toString('utf8') ?? '{}';
    const hooks = JSON.parse(text);
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw Error('Project hooks must be a JSON object');
    const saved = await optional(statePath);
    let state = saved ? JSON.parse(saved.toString('utf8')) : undefined;
    if (state && (state.version !== 1 || state.definitionHash !== definitionHash)) throw Error('AGY hook registration version differs; recover its owned registration first');
    if (!state) {
      if (Object.hasOwn(hooks, KEY)) throw Error('Project AGY hook key is already owned; do not overwrite it');
      state = { version: 1, definitionHash, original: before?.toString('base64') ?? null, leases: [] };
      const end = text.lastIndexOf('}');
      const updated = text.slice(0, end) + `${Object.keys(hooks).length ? ',' : ''}\n  ${JSON.stringify(KEY)}: ${JSON.stringify(definition)}\n` + text.slice(end);
      const current = await optional(path);
      if (Boolean(current) !== Boolean(before) || current && sha(current) !== sha(before)) throw Error('Project hooks changed during registration');
      await atomic(statePath, JSON.stringify(state));
      await atomic(path, updated);
    } else if (sha(JSON.stringify(hooks[KEY])) !== definitionHash) throw Error('Owned AGY hook definition changed; preserve the concurrent edit');
    state.leases = state.leases.filter(lease => processAlive(lease.pid));
    state.leases.push({ sessionId, pid: process.pid });
    await atomic(statePath, JSON.stringify(state));
  });
  let closed = false;
  let closePromise;
  return { path, close() {
    if (closed) return Promise.resolve();
    return closePromise ??= locked(lockPath, async () => {
      const saved = await optional(statePath);
      if (!saved) throw Error('AGY hook ownership receipt is missing');
      const state = JSON.parse(saved.toString('utf8'));
      state.leases = state.leases.filter(lease => lease.sessionId !== sessionId && processAlive(lease.pid));
      if (state.leases.length) { await atomic(statePath, JSON.stringify(state)); closed = true; return; }
      const bytes = await optional(path);
      if (bytes) {
        const text = bytes.toString('utf8');
        const hooks = JSON.parse(text);
        if (sha(JSON.stringify(hooks[KEY])) !== definitionHash) throw Error('Owned AGY hook changed; manual scoped recovery required');
        const range = ownedRange(text);
        if (!range) throw Error('Owned AGY hook cannot be located safely');
        const remaining = text.slice(0, range.start) + text.slice(range.end);
        const original = state.original === null ? undefined : Buffer.from(state.original, 'base64');
        const originalHooks = original ? JSON.parse(original.toString('utf8')) : {};
        delete hooks[KEY];
        const current = await optional(path);
        if (!current || sha(current) !== sha(bytes)) throw Error('Project hooks changed during cleanup');
        if (JSON.stringify(hooks) === JSON.stringify(originalHooks)) {
          if (original) await atomic(path, original); else await unlink(path);
        } else await atomic(path, remaining);
      }
      await unlink(statePath);
      closed = true;
    });
  } };
}


/**
 * Recover only this adapter's dead registration in an explicitly selected workspace.
 * `node agy-cli-acp.mjs --recover-project-hook <absolute-workspace>` starts no vendor
 * process. A live lease or changed definition is preserved; successful recovery
 * restores original bytes or removes only the owned key alongside foreign edits.
 */
export async function recoverProjectHook({ cwd, nodePath, handlerPath }) {
  const statePath = join(cwd, '.agents', '.kiki-agy-hook-ownership.json');
  const bytes = await optional(statePath);
  if (!bytes) return { status: 'no-owned-registration' };
  const state = JSON.parse(bytes.toString('utf8'));
  if (state.version !== 1 || !Array.isArray(state.leases)) throw Error('Invalid AGY hook ownership receipt; preserve it for scoped recovery');
  if (state.leases.some(lease => processAlive(lease.pid))) return { status: 'owned-session-still-live' };
  const hookBytes = await optional(join(cwd, '.agents', 'hooks.json'));
  if (!hookBytes || !Object.hasOwn(JSON.parse(hookBytes.toString('utf8')), KEY)) {
    return locked(`${statePath}.lock`, async () => {
      const current = await optional(statePath);
      if (!current || sha(current) !== sha(bytes)) return { status: 'registration-changed-retry-recovery' };
      await unlink(statePath);
      return { status: 'owned-registration-recovered' };
    });
  }
  const registration = await registerProjectHook({ cwd, nodePath, handlerPath, sessionId: `recovery-${randomUUID()}` });
  await registration.close();
  return { status: await optional(statePath) ? 'owned-session-still-live' : 'owned-registration-recovered' };
}
