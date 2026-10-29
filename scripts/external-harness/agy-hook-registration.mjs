import { readFile, writeFile, mkdir, open, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const KEY = 'kiki-agy-permission-bridge';
const STEERING_KEY = 'kiki-agy-steering-bridge';
const OWNED = Object.freeze({
  [KEY]: { state: '.kiki-agy-hook-ownership.json', definition: command => ({ PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, timeout: 86400 }] }] }) },
  [STEERING_KEY]: { state: '.kiki-agy-steering-ownership.json', definition: command => ({ PostInvocation: [{ type: 'command', command, timeout: 30 }] }) },
});
const LOCK = '.kiki-agy-hook-ownership.json.lock';
const ownedKeys = hooks => Object.keys(hooks).filter(key => Object.hasOwn(OWNED, key));
export const AGY_PERMISSION_HOOK_KEY = KEY;
export const AGY_STEERING_HOOK_KEY = STEERING_KEY;

export function hookCommand(nodePath, handlerPath, args = []) {
  if (args.some(arg => !/^--[a-z-]+$/.test(arg))) throw Error('AGY hook arguments must be fixed flags');
  if (process.platform !== 'win32') return [`"${nodePath}"`, `"${handlerPath}"`, ...args].join(' ');
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $encoding=New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding=$encoding; [Console]::OutputEncoding=$encoding; $OutputEncoding=$encoding; $json=[Console]::In.ReadToEnd(); $json | & ${[nodePath, handlerPath, ...args].map(literal).join(' ')}; exit $LASTEXITCODE`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `${join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')} -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function optional(path) { try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }

function ownedRange(text, ownedKey) {
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
    if (key === ownedKey) return previousComma === undefined
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

/**
 * Adds one owned key to `.agents/hooks.json` and leases it to this adapter session.
 * `key` selects the permission gate (PreToolUse) or the steering bridge (PostInvocation);
 * each owned key keeps its own receipt, while the original file bytes come back only
 * after the last owned key and lease are gone.
 */
export async function registerProjectHook({ cwd, nodePath, handlerPath, sessionId, key = KEY, args = [] }) {
  const owned = OWNED[key];
  if (!owned) throw Error('Unknown AGY owned hook key');
  const dir = join(cwd, '.agents');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'hooks.json');
  const statePath = join(dir, owned.state);
  const lockPath = join(dir, LOCK);
  const definition = owned.definition(hookCommand(nodePath, handlerPath, args));
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
      if (Object.hasOwn(hooks, key)) throw Error('Project AGY hook key is already owned; do not overwrite it');
      const original = await originalBytes(dir, before);
      state = { version: 1, definitionHash, original, leases: [] };
      const end = text.lastIndexOf('}');
      const updated = text.slice(0, end) + `${Object.keys(hooks).length ? ',' : ''}\n  ${JSON.stringify(key)}: ${JSON.stringify(definition)}\n` + text.slice(end);
      const current = await optional(path);
      if (Boolean(current) !== Boolean(before) || current && sha(current) !== sha(before)) throw Error('Project hooks changed during registration');
      await atomic(statePath, JSON.stringify(state));
      await atomic(path, updated);
    } else if (sha(JSON.stringify(hooks[key])) !== definitionHash) throw Error('Owned AGY hook definition changed; preserve the concurrent edit');
    state.leases = state.leases.filter(lease => processAlive(lease.pid));
    state.leases.push({ sessionId, pid: process.pid });
    await atomic(statePath, JSON.stringify(state));
  });
  let closed = false;
  let closePromise;
  return { path, close() {
    if (closed) return Promise.resolve();
    closePromise ??= locked(lockPath, async () => {
      const saved = await optional(statePath);
      if (!saved) throw Error('AGY hook ownership receipt is missing');
      const state = JSON.parse(saved.toString('utf8'));
      state.leases = state.leases.filter(lease => lease.sessionId !== sessionId && processAlive(lease.pid));
      if (state.leases.length) { await atomic(statePath, JSON.stringify(state)); closed = true; return; }
      const bytes = await optional(path);
      if (bytes) {
        const text = bytes.toString('utf8');
        const hooks = JSON.parse(text);
        if (sha(JSON.stringify(hooks[key])) !== definitionHash) throw Error('Owned AGY hook changed; manual scoped recovery required');
        const range = ownedRange(text, key);
        if (!range) throw Error('Owned AGY hook cannot be located safely');
        const remaining = text.slice(0, range.start) + text.slice(range.end);
        const original = state.original === null ? undefined : Buffer.from(state.original, 'base64');
        const originalHooks = original ? JSON.parse(original.toString('utf8')) : {};
        delete hooks[key];
        const current = await optional(path);
        if (!current || sha(current) !== sha(bytes)) throw Error('Project hooks changed during cleanup');
        if (ownedKeys(hooks).length === 0 && JSON.stringify(hooks) === JSON.stringify(originalHooks)) {
          if (original) await atomic(path, original); else await unlink(path);
        } else await atomic(path, remaining);
      }
      await unlink(statePath);
      closed = true;
    }).finally(() => { closePromise = undefined; });
    return closePromise;
  } };
}

async function originalBytes(dir, before) {
  for (const { state } of Object.values(OWNED)) {
    const saved = await optional(join(dir, state));
    if (saved) return JSON.parse(saved.toString('utf8')).original ?? null;
  }
  return before?.toString('base64') ?? null;
}


/**
 * Recover only this adapter's dead registrations in an explicitly selected workspace.
 * `node agy-cli-acp.mjs --recover-project-hook <absolute-workspace>` starts no vendor
 * process. A live lease or changed definition is preserved; successful recovery
 * restores original bytes or removes only the owned keys alongside foreign edits.
 */
export async function recoverProjectHook({ cwd, nodePath, handlerPath }) {
  const results = [];
  for (const [key, owned] of Object.entries(OWNED)) {
    results.push(await recoverOwnedKey({ cwd, nodePath, handlerPath, key, statePath: join(cwd, '.agents', owned.state) }));
  }
  for (const status of ['owned-session-still-live', 'registration-changed-retry-recovery', 'owned-registration-recovered']) {
    if (results.includes(status)) return { status };
  }
  return { status: 'no-owned-registration' };
}

async function recoverOwnedKey({ cwd, nodePath, handlerPath, key, statePath }) {
  const bytes = await optional(statePath);
  if (!bytes) return 'no-owned-registration';
  const state = JSON.parse(bytes.toString('utf8'));
  if (state.version !== 1 || !Array.isArray(state.leases)) throw Error('Invalid AGY hook ownership receipt; preserve it for scoped recovery');
  if (state.leases.some(lease => processAlive(lease.pid))) return 'owned-session-still-live';
  const hookBytes = await optional(join(cwd, '.agents', 'hooks.json'));
  if (!hookBytes || !Object.hasOwn(JSON.parse(hookBytes.toString('utf8')), key)) {
    return locked(join(cwd, '.agents', LOCK), async () => {
      const current = await optional(statePath);
      if (!current || sha(current) !== sha(bytes)) return 'registration-changed-retry-recovery';
      await unlink(statePath);
      return 'owned-registration-recovered';
    });
  }
  const args = key === STEERING_KEY ? ['--steering'] : [];
  const registration = await registerProjectHook({ cwd, nodePath, handlerPath, sessionId: `recovery-${randomUUID()}`, key, args });
  await registration.close();
  return await optional(statePath) ? 'owned-session-still-live' : 'owned-registration-recovered';
}
