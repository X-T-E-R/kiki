import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROMOTE_TEST_COMMANDS, pnpmLaunch, pnpmSpawnArgs, pnpmSpawnOptions } from './run-promote-tests.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SHARED_PREFIXES = [
  '.github/workflows/',
  'build/',
  'vendor/',
];
const FULL_FILES = new Set([
  '.npmrc',
  '.nvmrc',
  'flake.lock',
  'flake.nix',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vitest.config.ts',
]);
const VITEST_PROJECTS = new Map([
  ['apps/kiki-gui', 'gui'],
  ['apps/kimi-code', 'cli'],
  ['apps/vscode', 'kiki'],
  ['packages/acp-client', 'acp-client'],
  ['packages/acp-server', 'acp-server'],
  ['packages/agent-core-v2', 'agent-core-v2'],
  ['packages/agent-profiles', 'agent-profiles'],
  ['packages/codex-client', '@kiki/codex-client'],
  ['packages/kaos', 'kaos'],
  ['packages/kap-server', 'kap-server'],
  ['packages/klient', 'klient'],
  ['packages/minidb', 'minidb'],
  ['packages/node-sdk', 'kimi-sdk'],
  ['packages/oauth', 'kimi-oauth'],
  ['packages/protocol', 'protocol'],
  ['packages/session-core', 'session-core'],
  ['packages/transcript', 'transcript'],
  ['packages/transcript-live', 'transcript-live'],
  ['packages/tree-sitter-bash', 'tree-sitter-bash'],
]);

function slash(path) {
  return path.split(sep).join('/').replace(/^\.\//, '');
}

function command(label, args, options = {}) {
  return { label, args, ...options };
}

function quote(value) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
}

export function displayPnpm(args) {
  return `pnpm ${args.map(quote).join(' ')}`;
}

function git(root, args, options = {}) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
}

function assertGit(result, description) {
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString().trim() ?? `exit ${String(result.status)}`;
    throw new Error(`${description}: ${detail}`);
  }
  return result.stdout;
}

export function parseNameStatus(output) {
  const fields = output.split('\0');
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) break;
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      const oldPath = fields[index++];
      const path = fields[index++];
      if (!oldPath || !path) throw new Error(`incomplete git ${kind} record`);
      changes.push({ status, oldPath: slash(oldPath), path: slash(path) });
      continue;
    }
    const path = fields[index++];
    if (!path) throw new Error(`incomplete git ${kind} record`);
    changes.push({ status, path: slash(path) });
  }
  return changes;
}

function dedupeChanges(changes) {
  const byIdentity = new Map();
  for (const change of changes) {
    const key = `${change.status[0]}\0${change.oldPath ?? ''}\0${change.path}`;
    byIdentity.set(key, change);
  }
  return [...byIdentity.values()];
}

export function collectBaseChanges(root, base) {
  const verification = git(root, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (verification.status !== 0) {
    return { ok: false, reason: `base SHA cannot be resolved: ${base}` };
  }
  const committed = parseNameStatus(assertGit(
    git(root, ['diff', '--name-status', '-z', '--find-renames', `${base}...HEAD`]),
    'cannot read committed changes',
  ));
  const dirty = parseNameStatus(assertGit(
    git(root, ['diff', '--name-status', '-z', '--find-renames', 'HEAD']),
    'cannot read worktree changes',
  ));
  const untracked = assertGit(
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    'cannot read untracked paths',
  ).split('\0').filter(Boolean).map(path => ({ status: '?', path: slash(path) }));
  return { ok: true, changes: dedupeChanges([...committed, ...dirty, ...untracked]) };
}

export function parseArguments(argv) {
  const [mode = 'focused', ...rest] = argv;
  if (!['focused', 'full'].includes(mode)) throw new Error(`unknown mode: ${mode}`);
  const options = { mode, base: undefined, paths: [], planOnly: false, receipt: undefined };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--base') {
      options.base = rest[++index];
      if (!options.base) throw new Error('--base requires a SHA or ref');
    } else if (value === '--path') {
      const path = rest[++index];
      if (!path) throw new Error('--path requires a repository path');
      options.paths.push(path);
    } else if (value === '--paths') {
      while (rest[index + 1] && !rest[index + 1].startsWith('--')) options.paths.push(rest[++index]);
      if (options.paths.length === 0) throw new Error('--paths requires at least one repository path');
    } else if (value === '--receipt') {
      options.receipt = rest[++index];
      if (!options.receipt) throw new Error('--receipt requires a file path');
    } else if (value === '--plan') {
      options.planOnly = true;
    } else if (value === '--') {
      continue;
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  if (options.base && options.paths.length > 0) throw new Error('--base and --paths/--path are mutually exclusive');
  if (mode === 'full' && (options.base || options.paths.length > 0)) throw new Error('full mode does not accept a base or path selection');
  return options;
}

export function readWorkspace(root) {
  const packages = [];
  const manifests = assertGit(git(root, ['ls-files', '-z', 'apps/*/package.json', 'packages/*/package.json', 'docs/package.json']), 'cannot list workspace manifests')
    .split('\0').filter(Boolean);
  for (const manifest of manifests) {
    const data = JSON.parse(readFileSync(resolve(root, manifest), 'utf8'));
    packages.push({
      dir: slash(dirname(manifest)),
      name: data.name,
      dependencies: Object.keys({ ...data.dependencies, ...data.optionalDependencies }),
      scripts: data.scripts ?? {},
    });
  }
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
  for (const pkg of packages) pkg.dependencies = pkg.dependencies.filter(name => byName.has(name));
  return packages;
}

function owningPackage(path, packages) {
  const normalized = slash(path);
  return packages
    .filter(pkg => normalized === pkg.dir || normalized.startsWith(`${pkg.dir}/`))
    .toSorted((left, right) => right.dir.length - left.dir.length)[0];
}

function incompleteReason(path) {
  const normalized = slash(path);
  if (/[\r\n\"&|<>^%!]/.test(normalized)) return `path contains unsafe Windows shell characters: ${normalized}`;
  if (FULL_FILES.has(normalized)) return `global repository input changed: ${normalized}`;
  const prefix = SHARED_PREFIXES.find(entry => normalized.startsWith(entry));
  if (prefix) return `shared repository area changed: ${normalized}`;
  if (normalized.startsWith('scripts/')) return `repository verification script changed: ${normalized}`;
  if (/(^|\/)scripts\/(?:native\/|[^/]*(?:build|bundle|package|release|setup)[^/]*\.[cm]?[jt]s$)/.test(normalized)) {
    return `package build or setup script changed: ${normalized}`;
  }
  if (/(^|\/)(?:vitest\.config\.[cm]?[jt]s|test\/setup\.[cm]?[jt]s|tsdown[^/]*\.config\.[cm]?[jt]s)$/.test(normalized)) {
    return `test setup or worker packaging changed: ${normalized}`;
  }
  return undefined;
}

function incompleteSelection(reasons, next = 'provide a narrower --base or --paths selection, or invoke test:full explicitly') {
  return {
    mode: 'incomplete',
    reasons,
    packages: [],
    consumers: [],
    commands: [],
    next,
  };
}

function transitiveConsumers(selected, packages) {
  const selectedNames = new Set(selected.map(pkg => pkg.name));
  let changed = true;
  while (changed) {
    changed = false;
    for (const pkg of packages) {
      if (selectedNames.has(pkg.name)) continue;
      if (pkg.dependencies.some(name => selectedNames.has(name))) {
        selectedNames.add(pkg.name);
        changed = true;
      }
    }
  }
  return packages.filter(pkg => selectedNames.has(pkg.name));
}

function unique(values) {
  return [...new Set(values)];
}

function focusedCommands(changes, selected, affected) {
  const related = unique(changes.flatMap(change => [change.oldPath, change.path]).filter(Boolean));
  const projects = unique(affected.map(pkg => pkg.vitestProject ?? VITEST_PROJECTS.get(pkg.dir)).filter(Boolean));
  const selectedHasVitestProject = selected.some(pkg => pkg.vitestProject !== undefined || VITEST_PROJECTS.has(pkg.dir));
  const commands = [];
  if (selectedHasVitestProject && projects.length > 0) {
    const vitestArgs = ['exec', 'vitest', 'related', '--run', '--maxWorkers=2', '--passWithNoTests=false'];
    for (const project of projects) vitestArgs.push(`--project=${project}`);
    vitestArgs.push(...related);
    commands.push(command('affected root Vitest relation', vitestArgs));
  }
  const nativeTests = related.filter(path => /(?:^|\/)[^/]+\.test\.[cm]js$/.test(path));
  if (nativeTests.length > 0) {
    commands.push(command('selected node:test files', ['exec', 'node', '--test', '--test-concurrency=2', ...nativeTests]));
  }
  const byName = new Set(affected.map(pkg => pkg.name));
  if (byName.has('@kiki/auth-native')) commands.push(command('auth-native node:test suite', ['--filter', '@kiki/auth-native', 'test']));
  if (byName.has('@kiki/pi-tui')) commands.push(command('pi-tui node:test suite', ['--filter', '@kiki/pi-tui', 'test']));
  if (byName.has('@kiki/plugin-sdk')) {
    commands.push(command('plugin SDK build', ['--filter', '@kiki/plugin-sdk', 'run', 'build']));
    commands.push(command('plugin SDK node:test suite', ['exec', 'node', '--test', '--test-concurrency=2', 'packages/plugin-sdk/test/media-download.test.mjs']));
  }
  if (byName.has('@kiki/docs')) {
    commands.push(command('documentation build', ['-C', 'docs', 'run', 'build']));
    commands.push(command('documentation IA node:test suite', ['-C', 'docs', 'run', 'test:ia']));
  }
  const typecheckable = affected.filter(pkg => pkg.scripts.typecheck).map(pkg => pkg.name);
  if (typecheckable.length > 0) {
    const args = typecheckable.flatMap(name => ['--filter', name]);
    commands.push(command('affected workspace typechecks', [...args, 'run', 'typecheck']));
  }
  return commands;
}

export function selectAffected({ changes, packages }) {
  if (changes.length === 0) {
    return {
      mode: 'none',
      reasons: ['selection contained no changed paths; no pass claim can be made'],
      packages: [],
      consumers: [],
      commands: [],
      next: 'provide --base or --paths that identifies the intended change range',
    };
  }
  const direct = new Map();
  for (const change of changes) {
    const paths = [change.oldPath, change.path].filter(Boolean);
    for (const path of paths) {
      const reason = incompleteReason(path);
      if (reason) return incompleteSelection([reason]);
      const pkg = owningPackage(path, packages);
      if (!pkg) return incompleteSelection([`path is not mapped to a workspace package: ${path}`]);
      direct.set(pkg.name, pkg);
    }
    if ((change.status.startsWith('R') || change.status.startsWith('C')) && change.oldPath) {
      const oldOwner = owningPackage(change.oldPath, packages);
      const newOwner = owningPackage(change.path, packages);
      if (!oldOwner || !newOwner) {
        return incompleteSelection([`rename/copy cannot be mapped safely: ${change.oldPath} -> ${change.path}`]);
      }
    }
    if (change.status.startsWith('D')) {
      return incompleteSelection([`deleted path has no remaining import target for focused relation: ${change.path}`]);
    }
  }
  const selected = [...direct.values()];
  const affected = transitiveConsumers(selected, packages);
  const commands = focusedCommands(changes, selected, affected);
  if (commands.length === 0) {
    return {
      mode: 'incomplete',
      reasons: ['mapped packages produced no executable verification command'],
      packages: selected.map(pkg => pkg.name),
      consumers: affected.filter(pkg => !direct.has(pkg.name)).map(pkg => pkg.name),
      commands: [],
      next: 'select test scope explicitly or invoke test:full',
    };
  }
  return {
    mode: 'focused',
    reasons: selected.map(pkg => `changed path maps to ${pkg.name}`),
    packages: selected.map(pkg => pkg.name),
    consumers: affected.filter(pkg => !direct.has(pkg.name)).map(pkg => pkg.name),
    commands,
    next: undefined,
  };
}

export function fullCommands() {
  return [
    command('repository lint', ['run', 'lint']),
    command('workspace manifest lint', ['run', 'sherif']),
    command('repository typecheck', ['run', 'typecheck']),
    command('repository build', ['run', 'build']),
    ...PROMOTE_TEST_COMMANDS,
    command('repository node:test contracts', [
      'exec', 'node', '--test', '--test-concurrency=2',
      'scripts/check-docs-governance.test.mjs',
      'scripts/check-nix-workspace.test.mjs',
      'scripts/ci-test-partition.test.mjs',
      'scripts/release-pipeline.test.mjs',
      'scripts/test-affected.test.mjs',
      'apps/kiki-gui/scripts/desktop-release-feed.test.mjs',
    ]),
    command('CI partition collection proof', ['exec', 'node', 'scripts/ci-test-partition.mjs', 'verify', '--shards=5']),
    command('auth-native node:test suite', ['--filter', '@kiki/auth-native', 'test']),
    command('auth-native offline Nix fixture', ['--filter', '@kiki/auth-native', 'run', 'test:nix-env']),
    command('plugin SDK build', ['--filter', '@kiki/plugin-sdk', 'run', 'build']),
    command('plugin SDK node:test suite', ['exec', 'node', '--test', '--test-concurrency=2', 'packages/plugin-sdk/test/media-download.test.mjs']),
    command('documentation governance check', ['exec', 'node', 'scripts/check-docs-governance.mjs']),
    command('CLI bundle smoke', ['-C', 'apps/kimi-code', 'run', 'smoke']),
  ];
}

function sourceState(root) {
  const head = assertGit(git(root, ['rev-parse', 'HEAD']), 'cannot resolve HEAD').trim();
  const status = assertGit(git(root, ['status', '--porcelain=v1', '-z']), 'cannot read worktree status')
    .split('\0').filter(Boolean);
  return { head, dirty: status.length > 0, status };
}

function inputFiles(root, selection, packages) {
  const files = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vitest.config.ts']);
  const names = new Set([...selection.packages, ...selection.consumers]);
  for (const pkg of packages) {
    if (!names.has(pkg.name)) continue;
    files.add(`${pkg.dir}/package.json`);
    if (existsSync(resolve(root, pkg.dir, 'vitest.config.ts'))) files.add(`${pkg.dir}/vitest.config.ts`);
  }
  return [...files].map(path => ({ path, present: existsSync(resolve(root, path)) }));
}

function pnpmVersion(env) {
  const launch = pnpmLaunch(['--version'], env);
  const result = spawnSync(launch.command, launch.args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
    ...pnpmSpawnOptions(env),
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function runCommands(commands, { root, env, logDirectory, spawnImpl = spawn, stopOnFailure = true }) {
  await mkdir(logDirectory, { recursive: true });
  const results = [];
  let blocked = false;
  for (let index = 0; index < commands.length; index += 1) {
    const entry = commands[index];
    const logPath = join(logDirectory, `${String(index + 1).padStart(2, '0')}-${entry.label.replaceAll(/[^a-z0-9]+/gi, '-').replaceAll(/^-|-$/g, '').toLowerCase()}.log`);
    if (blocked) {
      results.push({ label: entry.label, command: displayPnpm(entry.args), status: 'skipped', reason: 'blocked by an earlier command failure', log: null });
      continue;
    }
    const startedAt = new Date().toISOString();
    const launch = pnpmLaunch(entry.args, env);
    const log = createWriteStream(logPath, { flags: 'wx' });
    log.write(`$ ${displayPnpm(entry.args)}\n`);
    let child;
    try {
      child = spawnImpl(launch.command, pnpmSpawnArgs(launch.args, env), {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...pnpmSpawnOptions(env),
      });
    } catch (error) {
      const endedAt = new Date().toISOString();
      const detail = error instanceof Error ? error.message : String(error);
      log.write(`\nspawn error: ${detail}\n`);
      await new Promise(resolveLog => log.end(resolveLog));
      results.push({
        label: entry.label,
        command: displayPnpm(entry.args),
        executable: launch.command,
        arguments: launch.args,
        startedAt,
        endedAt,
        exitCode: 1,
        status: 'failed',
        error: detail,
        log: slash(relative(root, logPath)),
      });
      if (stopOnFailure) blocked = true;
      continue;
    }
    let spawnError;
    child.stdout?.on('data', chunk => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr?.on('data', chunk => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    child.on('error', error => {
      spawnError = error;
      log.write(`\nspawn error: ${error.message}\n`);
    });
    const exitCode = await new Promise(resolveExit => {
      child.on('close', code => resolveExit(code ?? 1));
    });
    const endedAt = new Date().toISOString();
    await new Promise(resolveLog => log.end(resolveLog));
    const status = exitCode === 0 && !spawnError ? 'passed' : 'failed';
    results.push({
      label: entry.label,
      command: displayPnpm(entry.args),
      executable: launch.command,
      arguments: launch.args,
      startedAt,
      endedAt,
      exitCode,
      status,
      error: spawnError?.message,
      log: slash(relative(root, logPath)),
    });
    if (status === 'failed' && stopOnFailure) blocked = true;
  }
  return results;
}

function outputLine(value, stream = process.stdout) {
  stream.write(`${value}\n`);
}

function printSelection(selection) {
  outputLine(`Selected mode: ${selection.mode}`);
  for (const reason of selection.reasons) outputLine(`Reason: ${reason}`);
  outputLine(`Packages: ${selection.packages.length > 0 ? selection.packages.join(', ') : '(none)'}`);
  outputLine(`Consumers: ${selection.consumers.length > 0 ? selection.consumers.join(', ') : '(none)'}`);
  if (selection.next) outputLine(`Next: ${selection.next}`);
  outputLine('Commands:');
  if (selection.commands.length === 0) outputLine('  (none)');
  for (const entry of selection.commands) outputLine(`  - ${entry.label}: ${displayPnpm(entry.args)}`);
}

function normalizeExplicitPaths(root, paths) {
  return paths.map(input => {
    const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input);
    const path = slash(relative(root, absolute));
    if (path === '..' || path.startsWith('../')) return { status: 'P', path: slash(input) };
    return { status: existsSync(absolute) ? 'P' : 'D', path };
  });
}

function receiptPath(root, requested, runId) {
  return requested ? resolve(root, requested) : resolve(root, '.tmp/test-receipts', `${runId}.json`);
}

export async function main(argv = process.argv.slice(2), root = ROOT) {
  const startedAt = new Date().toISOString();
  const options = parseArguments(argv);
  const sourceAtStart = sourceState(root);
  const packages = readWorkspace(root);
  let selection;
  let selectionInput;
  if (options.mode === 'full') {
    selection = { mode: 'full', reasons: ['full mode requested explicitly'], packages: [], consumers: [], commands: fullCommands() };
    selectionInput = { kind: 'full' };
  } else if (options.paths.length > 0) {
    const changes = normalizeExplicitPaths(root, options.paths);
    selection = selectAffected({ changes, packages });
    selectionInput = { kind: 'paths', changes };
  } else if (options.base) {
    const collected = collectBaseChanges(root, options.base);
    if (collected.ok) {
      selection = selectAffected({ changes: collected.changes, packages });
      selectionInput = { kind: 'base', base: options.base, changes: collected.changes };
    } else {
      selection = incompleteSelection([collected.reason], 'choose a valid --base ref or provide an explicit --paths range');
      selectionInput = { kind: 'base', base: options.base, error: collected.reason };
    }
  } else {
    selection = incompleteSelection(['focused mode requires an explicit --base or --paths selection'], 'provide --base <SHA-or-ref> or --paths <repository-path> [...paths]');
    selectionInput = { kind: 'missing' };
  }
  printSelection(selection);

  const runId = `${startedAt.replaceAll(/[:.]/g, '-')}-${selection.mode}`;
  const output = receiptPath(root, options.receipt, runId);
  const logDirectory = resolve(dirname(output), `${basename(output, '.json')}.logs`);
  const isolatedHome = await mkdtemp(join(tmpdir(), 'kiki-test-affected-'));
  const env = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: join(isolatedHome, 'appdata'),
    LOCALAPPDATA: join(isolatedHome, 'localappdata'),
    XDG_CACHE_HOME: join(isolatedHome, 'cache'),
    KIKI_HOME: join(isolatedHome, 'kiki-home'),
  };
  let results = [];
  try {
    if (!options.planOnly && (selection.mode === 'focused' || selection.mode === 'full')) {
      results = await runCommands(selection.commands, { root, env, logDirectory });
    } else {
      results = selection.commands.map(entry => ({
        label: entry.label,
        command: displayPnpm(entry.args),
        status: 'skipped',
        reason: options.planOnly ? 'plan only' : 'selection incomplete; no commands executed',
      }));
    }
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
  const endedAt = new Date().toISOString();
  const sourceAtEnd = sourceState(root);
  const sourceStable = JSON.stringify(sourceAtStart) === JSON.stringify(sourceAtEnd);
  const counts = {
    passed: results.filter(result => result.status === 'passed').length,
    failed: results.filter(result => result.status === 'failed').length,
    skipped: results.filter(result => result.status === 'skipped').length,
  };
  const status = options.planOnly ? 'planned'
    : selection.mode === 'none' || selection.mode === 'incomplete' ? 'incomplete'
      : counts.failed > 0 ? 'failed'
        : !sourceStable ? 'source-changed' : 'passed';
  const receipt = {
    schemaVersion: 1,
    receiptKind: 'local-candidate-test',
    requestedMode: options.mode,
    selectedMode: selection.mode,
    status,
    fullRepositoryPass: options.mode === 'full' && selection.mode === 'full' && status === 'passed',
    focusedPass: options.mode === 'focused' && selection.mode === 'focused' && status === 'passed',
    reuse: {
      eligible: sourceStable && !sourceAtStart.dirty && status === 'passed',
      conditions: ['same source HEAD', 'same listed inputs', 'same environment and toolchain', 'same selected command set'],
      scope: selection.mode === 'focused' ? 'focused selection only' : selection.mode === 'full' ? 'local full collection only' : 'none',
    },
    source: { start: sourceAtStart, end: sourceAtEnd, stableDuringRun: sourceStable },
    selectionInput,
    selection: {
      reasons: selection.reasons,
      packages: selection.packages,
      consumers: selection.consumers,
      next: selection.next,
      commands: selection.commands.map(entry => ({ label: entry.label, command: displayPnpm(entry.args), arguments: entry.args })),
    },
    inputs: {
      files: inputFiles(root, selection, packages),
      note: sourceAtStart.dirty ? 'Dirty evidence is narrow and requires diff review before reuse.' : 'HEAD identifies repository source; listed paths identify primary test configuration and dependency inputs.',
    },
    environment: {
      node: process.version,
      nodeExecutable: process.execPath,
      pnpm: pnpmVersion(env),
      platform: process.platform,
      osRelease: (await import('node:os')).release(),
      arch: process.arch,
      isolatedHome: true,
    },
    startedAt,
    endedAt,
    exitCode: status === 'failed' || status === 'source-changed' ? 1 : status === 'incomplete' ? 2 : 0,
    commandCounts: { unit: 'commands', ...counts },
    results,
    logDirectory: slash(relative(root, logDirectory)),
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  outputLine(`Receipt: ${output}`);
  if (status === 'passed') outputLine(`${selection.mode} local candidate checks passed.`);
  else if (status === 'planned') outputLine('Plan recorded; no checks were executed.');
  else outputLine(`${selection.mode} local candidate checks did not pass (${status}).`, process.stderr);
  return receipt.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    outputLine(error instanceof Error ? error.stack : String(error), process.stderr);
    process.exitCode = 2;
  }
}
