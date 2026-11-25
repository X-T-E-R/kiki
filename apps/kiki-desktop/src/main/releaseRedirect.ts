import { spawn, type SpawnOptions } from 'node:child_process';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { basename, dirname, join, normalize } from 'pathe';
import { z } from 'zod';

export const NO_RELEASE_REDIRECT_ENV = 'KIKI_NO_RELEASE_REDIRECT';
export const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';

const RELEASE_ID_RE = /^[0-9a-f]{24}-[0-9a-f]{24}$/;

const fileDigestSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  bytes: z.number().int().positive(),
});

const currentReleaseV1Schema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().regex(RELEASE_ID_RE),
  files: z
    .object({
      'kiki-desktop.exe': fileDigestSchema.optional(),
      'kiki-server.exe': fileDigestSchema.optional(),
    })
    .optional(),
});

const currentReleaseV2Schema = z.object({
  schemaVersion: z.literal(2),
  runtimeKind: z.literal('electron-single-binary'),
  releaseId: z.string().regex(RELEASE_ID_RE),
  serverEntry: z.string().min(1).default('resources/app.asar.unpacked/dist/server/server-entry.mjs'),
  files: z.record(z.string(), fileDigestSchema).optional(),
});

const currentReleaseManifestSchema = z.discriminatedUnion('schemaVersion', [
  currentReleaseV1Schema,
  currentReleaseV2Schema,
]);

const activeReleaseManifestSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  releaseId: z.string().regex(RELEASE_ID_RE),
  runtimeKind: z.literal('electron-single-binary').optional(),
});

export type CurrentReleaseManifest = z.infer<typeof currentReleaseManifestSchema>;

export interface ReleaseLayout {
  readonly runtimeRoot: string;
  readonly kind: 'active' | 'versioned';
  readonly releaseId?: string;
  readonly releaseDir: string;
}

export interface PromotedRelease {
  readonly schemaVersion: 1 | 2;
  readonly releaseId: string;
  readonly releaseDir: string;
  readonly desktopExe: string;
  readonly isActive: boolean;
  readonly serverEntry?: string;
}

export interface RedirectPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly release: PromotedRelease;
}

export interface ReleaseRedirectDeps {
  readonly platform?: NodeJS.Platform;
  readonly desktopExeName?: string;
  readonly serverExeName?: string;
  readonly readText?: (filePath: string) => string | null;
  readonly isRealDirectory?: (dirPath: string) => boolean;
  readonly isRealNonEmptyFile?: (filePath: string) => boolean;
  readonly isNonEmptyFile?: (filePath: string) => boolean;
  readonly spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => { unref?: () => void };
  readonly exitProcess?: (code: number) => void;
}

function desktopExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'kiki-desktop.exe' : 'kiki-desktop';
}

function serverExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'kiki-server.exe' : 'kiki-server';
}

function stripWindowsVerbatimPrefix(rawPath: string): string {
  if (rawPath.startsWith('\\\\?\\UNC\\')) return `\\\\${rawPath.slice(8)}`;
  if (rawPath.startsWith('\\\\?\\')) return rawPath.slice(4);
  return rawPath;
}

function namesMatch(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function defaultReadText(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function defaultIsRealDirectory(dirPath: string): boolean {
  try {
    const st = lstatSync(dirPath);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function defaultIsRealNonEmptyFile(filePath: string): boolean {
  try {
    const st = lstatSync(filePath);
    return st.isFile() && !st.isSymbolicLink() && st.size > 0;
  } catch {
    return false;
  }
}

function defaultIsNonEmptyFile(filePath: string): boolean {
  try {
    const st = statSync(filePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export function isValidReleaseId(value: string): boolean {
  return RELEASE_ID_RE.test(value);
}

export function parseReleaseLayout(
  currentExe: string,
  platform: NodeJS.Platform = process.platform,
  desktopExeName: string = desktopExecutableName(platform),
): ReleaseLayout | null {
  const normalizedExe = normalize(stripWindowsVerbatimPrefix(currentExe));
  const fileName = basename(normalizedExe);
  if (!namesMatch(fileName, desktopExeName, platform)) return null;

  const releaseDir = dirname(normalizedExe);
  const dirName = basename(releaseDir);
  if (namesMatch(dirName, 'active', platform)) {
    const runtimeRoot = dirname(releaseDir);
    if (!runtimeRoot || runtimeRoot === releaseDir) return null;
    return { runtimeRoot, kind: 'active', releaseDir };
  }

  if (!isValidReleaseId(dirName)) return null;
  const releasesDir = dirname(releaseDir);
  if (!namesMatch(basename(releasesDir), 'releases', platform)) return null;
  const runtimeRoot = dirname(releasesDir);
  if (!runtimeRoot || runtimeRoot === releasesDir) return null;
  return { runtimeRoot, kind: 'versioned', releaseId: dirName, releaseDir };
}

function hasValidRuntimeArtifacts(
  dir: string,
  manifest: CurrentReleaseManifest,
  strictReal: boolean,
  deps: Required<
    Pick<
      ReleaseRedirectDeps,
      'desktopExeName' | 'serverExeName' | 'isRealNonEmptyFile' | 'isNonEmptyFile'
    >
  >,
): { readonly ok: boolean; readonly desktopExe: string; readonly serverEntry?: string } {
  const checkFile = strictReal ? deps.isRealNonEmptyFile : deps.isNonEmptyFile;
  const desktopExe = join(dir, deps.desktopExeName);
  if (!checkFile(desktopExe)) return { ok: false, desktopExe };

  if (manifest.schemaVersion === 2) {
    const entryPath = join(dir, manifest.serverEntry);
    if (!checkFile(entryPath)) return { ok: false, desktopExe };
    return { ok: true, desktopExe, serverEntry: entryPath };
  }

  const serverExe = join(dir, deps.serverExeName);
  if (!checkFile(serverExe)) return { ok: false, desktopExe };
  return { ok: true, desktopExe };
}

export function resolvePromotedRelease(
  layout: ReleaseLayout,
  deps: ReleaseRedirectDeps = {},
): PromotedRelease | null {
  const platform = deps.platform ?? process.platform;
  const readText = deps.readText ?? defaultReadText;
  const isRealDirectory = deps.isRealDirectory ?? defaultIsRealDirectory;
  const artifactDeps = {
    desktopExeName: deps.desktopExeName ?? desktopExecutableName(platform),
    serverExeName: deps.serverExeName ?? serverExecutableName(platform),
    isRealNonEmptyFile: deps.isRealNonEmptyFile ?? defaultIsRealNonEmptyFile,
    isNonEmptyFile: deps.isNonEmptyFile ?? defaultIsNonEmptyFile,
  };

  const currentRaw = readText(join(layout.runtimeRoot, 'current.json'));
  if (currentRaw === null) return null;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(currentRaw);
  } catch {
    return null;
  }
  const parsedManifest = currentReleaseManifestSchema.safeParse(parsedJson);
  if (!parsedManifest.success) return null;
  const manifest = parsedManifest.data;

  const activeDir = join(layout.runtimeRoot, 'active');
  if (isRealDirectory(activeDir)) {
    const activeRaw = readText(join(activeDir, 'active-release.json'));
    if (activeRaw !== null) {
      try {
        const parsedActive = activeReleaseManifestSchema.safeParse(JSON.parse(activeRaw));
        if (
          parsedActive.success &&
          parsedActive.data.schemaVersion === manifest.schemaVersion &&
          namesMatch(parsedActive.data.releaseId, manifest.releaseId, platform)
        ) {
          const check = hasValidRuntimeArtifacts(activeDir, manifest, true, artifactDeps);
          if (check.ok) {
            return {
              schemaVersion: manifest.schemaVersion,
              releaseId: manifest.releaseId,
              releaseDir: activeDir,
              desktopExe: check.desktopExe,
              isActive: true,
              serverEntry: check.serverEntry,
            };
          }
        }
      } catch {
        // Fall through to immutable versioned release directory.
      }
    }
  }

  const releaseDir = join(layout.runtimeRoot, 'releases', manifest.releaseId);
  const check = hasValidRuntimeArtifacts(releaseDir, manifest, false, artifactDeps);
  if (!check.ok) return null;
  return {
    schemaVersion: manifest.schemaVersion,
    releaseId: manifest.releaseId,
    releaseDir,
    desktopExe: check.desktopExe,
    isActive: false,
    serverEntry: check.serverEntry,
  };
}

export function filterGuiChildEnv(
  sourceEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    if (
      namesMatch(key, NO_RELEASE_REDIRECT_ENV, platform) ||
      namesMatch(key, ELECTRON_RUN_AS_NODE_ENV, platform)
    ) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function clearRedirectGuardEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === NO_RELEASE_REDIRECT_ENV) {
      delete env[key];
    }
  }
}

function isRedirectGuardTruthy(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  for (const [key, value] of Object.entries(env)) {
    if (!namesMatch(key, NO_RELEASE_REDIRECT_ENV, platform) || value === undefined) continue;
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') return true;
  }
  return false;
}

function hasNoReleaseRedirectArg(argv: readonly string[]): boolean {
  const parsed = parseArgs({
    args: argv.slice(1),
    strict: false,
    allowPositionals: true,
    options: {
      'no-release-redirect': { type: 'boolean' },
      home: { type: 'string', multiple: true },
      preset: { type: 'string', multiple: true },
      'remote-connection': { type: 'string', multiple: true },
    },
  });
  return parsed.values['no-release-redirect'] === true;
}

export function resolveChildWorkingDir(
  currentExe: string,
  currentDir: string | undefined,
  targetExe: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (currentDir === undefined) return undefined;
  const currentParent = normalize(dirname(stripWindowsVerbatimPrefix(currentExe)));
  const normalizedCwd = normalize(stripWindowsVerbatimPrefix(currentDir));
  if (!namesMatch(currentParent, normalizedCwd, platform)) return undefined;
  return normalize(dirname(stripWindowsVerbatimPrefix(targetExe)));
}

export function resolveLaunchExecutable(
  currentExe: string = process.execPath,
  deps: ReleaseRedirectDeps = {},
): string {
  const platform = deps.platform ?? process.platform;
  const normalized = normalize(stripWindowsVerbatimPrefix(currentExe));
  const layout = parseReleaseLayout(normalized, platform, deps.desktopExeName);
  if (layout === null) return normalized;
  const target = resolvePromotedRelease(layout, deps);
  return target?.desktopExe ?? normalized;
}

export function resolveRedirectPlan(input: {
  readonly currentExe: string;
  readonly currentDir?: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly deps?: ReleaseRedirectDeps;
}): RedirectPlan | null {
  const deps = input.deps ?? {};
  const platform = deps.platform ?? process.platform;
  if (isRedirectGuardTruthy(input.env, platform) || hasNoReleaseRedirectArg(input.argv)) {
    return null;
  }

  const layout = parseReleaseLayout(input.currentExe, platform, deps.desktopExeName);
  if (layout === null || layout.kind !== 'versioned') return null;

  const target = resolvePromotedRelease(layout, deps);
  if (target === null) return null;
  if (layout.releaseId !== undefined && namesMatch(layout.releaseId, target.releaseId, platform)) {
    return null;
  }

  const normalizedCurrent = normalize(stripWindowsVerbatimPrefix(input.currentExe));
  if (namesMatch(normalizedCurrent, target.desktopExe, platform)) return null;

  const childEnv = filterGuiChildEnv(input.env, platform);
  childEnv[NO_RELEASE_REDIRECT_ENV] = '1';

  return {
    executable: target.desktopExe,
    args: input.argv.slice(1),
    cwd: resolveChildWorkingDir(input.currentExe, input.currentDir, target.desktopExe, platform),
    env: childEnv,
    release: target,
  };
}

/**
 * Must execute synchronously before `app.requestSingleInstanceLock()`, window creation,
 * or daemon startup. Always consumes any inherited `KIKI_NO_RELEASE_REDIRECT` guard
 * so descendant processes never inherit it.
 */
export function maybeRedirectToCurrentRelease(
  options: {
    readonly currentExe?: string;
    readonly currentDir?: string;
    readonly argv?: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly deps?: ReleaseRedirectDeps;
  } = {},
): boolean {
  const env = options.env ?? process.env;
  const plan = resolveRedirectPlan({
    currentExe: options.currentExe ?? process.execPath,
    currentDir: options.currentDir ?? process.cwd(),
    argv: options.argv ?? process.argv,
    env,
    deps: options.deps,
  });
  clearRedirectGuardEnv(env);
  if (plan === null) return false;

  const spawnFn =
    options.deps?.spawnProcess ??
    ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  const exitFn = options.deps?.exitProcess ?? ((code) => process.exit(code));

  try {
    const child = spawnFn(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref?.();
    exitFn(0);
    return true;
  } catch (error) {
    console.error(`Kiki could not redirect to promoted release ${plan.executable}:`, error);
    return false;
  }
}
