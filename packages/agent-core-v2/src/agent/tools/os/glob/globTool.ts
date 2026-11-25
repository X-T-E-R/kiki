import { normalize, resolve } from 'pathe';
import { runCpuTask } from '#/app/cpuWorker/runtime';
import type { WorkspacePathIndex } from '#/os/backends/node-local/workspacePathIndex';

import { ensureRgPath, rgUnavailableMessage, type EnsureRgPathOptions, type RgProbe } from '#/os/backends/node-local/tools/rgLocator';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  formatRgSpawnError,
  rgErrorCode,
  runRgOnce,
  shouldRetryRipgrepEagain,
} from '#/os/backends/node-local/tools/runRg';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { SshHostProcessService } from '#/os/backends/ssh/sshHostServices';
import { IAgentRuntimeService, inspectAgentRuntime, inspectAgentWorkspaceRoots } from '#/agent/runtimeBinding/agentRuntime';
import { RuntimeWorkspaceView, runtimeShellPathBridge } from '#/runtime/runtimeWorkspaceView';
import { acquireToolRuntime, prepareToolRuntime, resolveSshToolTarget, tagSshResult, toolApprovalRule, hostToolParameters } from '#/agent/tools/os/sshToolTarget';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { kikiDefinitionReadRoots } from '#/app/bootstrap/definitionReadRoots';
import { resolveSpaceInheritance } from '#/app/bootstrap/spaceInheritance';
import {
  DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS,
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import {
  resolveRealPathAccess,
  resolveRealPathAccessPath,
  withDefinitionReadRoots,
  type PathClass,
  isSensitiveFile,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import globDescription from './glob.md?raw';
import {
  type GlobInput,
  GlobInputSchema,
  IGlobTool,
  DEFAULT_HEAD_LIMIT,
  WINDOWS_PATH_HINT,
} from './glob';

const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'] as const;

interface SharedRgGlobOutcome {
  readonly kind: 'ok';
  readonly rawPaths: readonly string[];
  readonly kept: readonly string[];
  readonly filteredSensitive: number;
  readonly bufferTruncated: boolean;
  readonly timedOut: boolean;
  readonly traversalWarning?: string;
}

interface SharedRgGlobFlight {
  readonly promise: Promise<SharedRgGlobOutcome | ExecutableToolResult>;
  readonly controller: AbortController;
  waiters: number;
}

const inflightRgGlobs = new Map<string, SharedRgGlobFlight>();
const sensitiveFilterCache = new WeakMap<readonly string[], { readonly kept: readonly string[]; readonly filteredSensitive: number }>();

export class GlobTool implements IGlobTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Glob' as const;
  readonly foregroundPolicy = 'bounded_io' as const;
  get parameters(): Record<string, unknown> {
    return hostToolParameters(GlobInputSchema, this.runtime.nativeSshEnabled?.() === true);
  }
  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
    @IBootstrapService private readonly bootstrap?: IBootstrapService,
  ) {}

  private rgShareOptions(): Pick<EnsureRgPathOptions, 'shareDir' | 'fallbackShareDirs'> {
    if (this.bootstrap === undefined) return {};
    const baseHomeDir = resolveSpaceInheritance(this.bootstrap).baseHomeDir;
    return {
      shareDir: this.bootstrap.homeDir,
      fallbackShareDirs: baseHomeDir === undefined ? [] : [baseHomeDir],
    };
  }

  get description(): string {
    return inspectAgentRuntime(this.runtime).environment.pathClass === 'win32'
      ? globDescription + WINDOWS_PATH_HINT
      : globDescription;
  }

  private workspaceConfig(view: RuntimeWorkspaceView): WorkspaceConfig {
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  async resolveExecution(args: GlobInput): Promise<ToolExecution> {
    const target = resolveSshToolTarget(args.host, args.path);
    args = { ...args, path: target.path };
    const inspected = await prepareToolRuntime(this.runtime, target.host);
    const generation = inspected.identity.generation;
    const view = new RuntimeWorkspaceView(inspected, inspectAgentWorkspaceRoots(this.runtime, this.workspaceCtx));
    const env = { _serviceBrand: undefined, ...inspected.environment, ready: Promise.resolve() };
    const roots = inspected.identity.runtimeId.startsWith('ssh:') ? [] : this.skillCatalog?.catalog.getSkillRoots() ?? [];
    const workspace = withDefinitionReadRoots(this.workspaceConfig(view), roots, env.homeDir,
      inspected.identity.runtimeId === 'local' ? kikiDefinitionReadRoots(this.bootstrap) : []);
    const pathOptions = { env, workspace, operation: 'search' as const, shellPathBridge: runtimeShellPathBridge(inspected) };
    let path: string | undefined;
    let implicitExternal = false;
    if (args.path !== undefined) {
      const preparation = acquireToolRuntime(this.runtime, target.host, ['fs']);
      try {
        if (preparation.runtime.identity.generation !== generation) {
          return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
        }
        const admitted = await resolveRealPathAccess(args.path, pathOptions, preparation.runtime.fs!);
        path = admitted.path;
        implicitExternal = admitted.implicitExternal === true ||
          (inspected.identity.runtimeId.startsWith('ssh:') && admitted.outsideWorkspace);
      } finally {
        preparation.dispose();
      }
    }
    const searchRoots = [path ?? workspace.workspaceDir];

    const detailParts: string[] = [`pattern: ${args.pattern}`];
    if (args.path !== undefined) {
      detailParts.push(`path: ${args.path}`);
    }
    if (args.include_ignored === true) {
      detailParts.push('include_ignored: true');
    }

    return {
      accesses: ToolAccesses.searchTree(searchRoots[0]!, implicitExternal),
      description: `Searching ${args.pattern}`,
      display: {
        kind: 'file_io',
        operation: 'glob',
        path: searchRoots[0]!,
        detail: detailParts.join(', '),
      },
      approvalRule: toolApprovalRule(this.name, args.pattern, inspected, target.host),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.pattern),
      execute: async ({ signal }) => {
        const lease = target.host === undefined
          ? this.runtime.acquire(['fs', 'process']) : acquireToolRuntime(this.runtime, target.host, ['fs', 'process']);
        try {
          if (lease.runtime.identity.generation !== generation) {
            return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
          }
          if (args.path !== undefined) {
            try {
              const currentPath = await resolveRealPathAccessPath(args.path, pathOptions, lease.runtime.fs!);
              if ((env.pathClass === 'win32' ? currentPath.toLowerCase() : currentPath) !==
                (env.pathClass === 'win32' ? path?.toLowerCase() : path)) {
                return { isError: true, output: `Search target changed after path admission: admitted "${path}", actual "${currentPath}". Use the actual absolute path or resolve a changed link first.` };
              }
            } catch (error) {
              return { isError: true, output: error instanceof Error ? error.message : String(error) };
            }
          }
          return tagSshResult(await this.execution(
            lease.runtime.fs!,
            lease.runtime.process!,
            env,
            workspace,
            args,
            signal,
            searchRoots,
            lease.runtime.pathIndex,
          ), inspected);
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private async execution(
    fs: IHostFileSystem,
    processService: IHostProcessService,
    env: IHostEnvironment,
    workspace: WorkspaceConfig,
    args: GlobInput,
    signal: AbortSignal,
    searchRoots: readonly string[],
    pathIndex?: WorkspacePathIndex,
  ): Promise<ExecutableToolResult> {
    const searchRoot = searchRoots[0] ?? workspace.workspaceDir;

    try {
      const st = await fs.stat(searchRoot);
      if (!st.isDirectory) {
        return { isError: true, output: `${searchRoot} is not a directory` };
      }
    } catch (error) {
      if (rgErrorCode(error) === 'ENOENT') {
        return { isError: true, output: `${searchRoot} does not exist` };
      }
      return { isError: true, output: error instanceof Error ? error.message : String(error) };
    }

    if (signal.aborted) {
      return { isError: true, output: 'Glob aborted' };
    }

    let rawPaths = args.include_ignored === true || processService instanceof SshHostProcessService
      ? undefined : await pathIndex?.glob(searchRoot, args.pattern);
    let bufferTruncated = false;
    let timedOut = false;
    let traversalWarning: string | undefined;
    if (rawPaths === undefined) {
      const canShareFlight = !(processService instanceof SshHostProcessService);
      const flightKey = canShareFlight
        ? `${resolve(searchRoot)}\0${args.pattern}\0${args.include_ignored === true ? '1' : '0'}`
        : undefined;
      let sharedFlight = flightKey === undefined ? undefined : inflightRgGlobs.get(flightKey);
      if (sharedFlight === undefined) {
        const controller = new AbortController();
        const flightSignal = canShareFlight ? controller.signal : signal;
        const runFlight = (async (): Promise<SharedRgGlobOutcome | ExecutableToolResult> => {
          let rgPath: string;
          try {
            if (processService instanceof SshHostProcessService) {
              rgPath = 'rg';
            } else {
              const resolution = await ensureRgPath(createRgProbe(processService), {
                signal: flightSignal,
                allowCachedFallback: true,
                ...this.rgShareOptions(),
              });
              rgPath = resolution.path;
              if (resolution.source !== 'system-path') {
                this.telemetry.track2('glob_tool_rg_fallback', {
                  source: resolution.source,
                  outcome: 'resolved',
                });
              }
            }
          } catch (error) {
            if (flightSignal.aborted) {
              return { isError: true, output: 'Glob aborted' };
            }
            this.telemetry.track2('glob_tool_rg_fallback', { outcome: 'failed' });
            return { isError: true, output: rgUnavailableMessage(error) };
          }

          let run;
          try {
            run = await runRgOnce(processService, buildRgArgs(rgPath, args, false, env.pathClass === 'win32'), flightSignal, { cwd: searchRoot });
          } catch (error) {
            return { isError: true, output: formatRgSpawnError(error) };
          }
          if (run.kind === 'aborted') {
            return { isError: true, output: 'Glob aborted' };
          }

          if (shouldRetryRipgrepEagain(run)) {
            try {
              run = await runRgOnce(processService, buildRgArgs(rgPath, args, true, env.pathClass === 'win32'), flightSignal, { cwd: searchRoot });
            } catch (error) {
              return { isError: true, output: formatRgSpawnError(error) };
            }
            if (run.kind === 'aborted') {
              return { isError: true, output: 'Glob aborted' };
            }
          }

          const { exitCode, stdoutText, stderrText } = run;
          const runBufferTruncated = run.bufferTruncated;
          const runTimedOut = run.timedOut;
          let runTraversalWarning: string | undefined;
          if (!runTimedOut && (exitCode !== 0 && exitCode !== 1 || exitCode === 1 && stderrText.trim() !== '')) {
            const rawPathsBeforeError = splitCompletePaths(stdoutText, true);
            if (rawPathsBeforeError.length === 0) {
              return { isError: true, output: formatGlobError(searchRoot, stderrText) };
            }
            runTraversalWarning = formatGlobWarning(stderrText);
          }
          if (flightSignal.aborted) {
            return { isError: true, output: 'Glob aborted' };
          }

          const normalizedRoot = resolve(searchRoot);
          const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
          const splitPaths = splitCompletePaths(stdoutText, runBufferTruncated || runTimedOut);
          const resolvedPaths: string[] = [];
          let resolveYieldAt = performance.now();
          for (let i = 0; i < splitPaths.length; i += 1) {
            const entry = splitPaths[i]!;
            const trimmed = entry.startsWith('./') || entry.startsWith('.\\') ? entry.slice(2) : entry;
            if (
              trimmed.length > 0 &&
              trimmed.charCodeAt(0) !== 47 &&
              trimmed.charCodeAt(0) !== 92 &&
              !trimmed.includes(':') &&
              !trimmed.includes('..')
            ) {
              resolvedPaths.push(`${rootPrefix}${trimmed.includes('\\') ? trimmed.replaceAll('\\', '/') : trimmed}`);
            } else {
              resolvedPaths.push(resolve(normalizedRoot, entry));
            }
            if ((i & 511) === 511 && performance.now() - resolveYieldAt >= 2.5) {
              await new Promise<void>((resolveYield) => { setImmediate(resolveYield); });
              if (flightSignal.aborted) return { isError: true, output: 'Glob aborted' };
              resolveYieldAt = performance.now();
            }
          }
          let flightPaths: readonly string[] = resolvedPaths;
          if (args.include_ignored !== true && !(processService instanceof SshHostProcessService) && flightPaths.length > 0) {
            const filteredText = await runCpuTask<string | null>(
              { type: 'workspace.pathFilterPacked', root: searchRoot, pathsText: flightPaths.join('\n') },
              { signal: flightSignal, priority: 'low' },
            );
            if (filteredText !== null) {
              flightPaths = filteredText.length === 0 ? [] : filteredText.split('\n');
            }
          }
          const flightKept: string[] = [];
          let flightFilteredSensitive = 0;
          let filterYieldAt = performance.now();
          for (let i = 0; i < flightPaths.length; i += 1) {
            const candidate = flightPaths[i]!;
            if (isSensitiveFile(candidate)) flightFilteredSensitive++;
            else flightKept.push(candidate);
            if ((i & 511) === 511 && performance.now() - filterYieldAt >= 2.5) {
              await new Promise<void>((resolveYield) => { setImmediate(resolveYield); });
              if (flightSignal.aborted) return { isError: true, output: 'Glob aborted' };
              filterYieldAt = performance.now();
            }
          }
          sensitiveFilterCache.set(flightPaths, { kept: flightKept, filteredSensitive: flightFilteredSensitive });
          return {
            kind: 'ok',
            rawPaths: flightPaths,
            kept: flightKept,
            filteredSensitive: flightFilteredSensitive,
            bufferTruncated: runBufferTruncated,
            timedOut: runTimedOut,
            traversalWarning: runTraversalWarning,
          };
        })();
        sharedFlight = { promise: runFlight, controller, waiters: 0 };
        if (flightKey !== undefined) {
          inflightRgGlobs.set(flightKey, sharedFlight);
          const currentFlight = sharedFlight;
          void runFlight.finally(() => {
            if (inflightRgGlobs.get(flightKey) === currentFlight) inflightRgGlobs.delete(flightKey);
          });
        }
      }
      const activeFlight = sharedFlight;
      activeFlight.waiters += 1;
      const outcome = await new Promise<SharedRgGlobOutcome | ExecutableToolResult>((resolveOutcome, rejectOutcome) => {
        if (signal.aborted) {
          activeFlight.waiters -= 1;
          if (activeFlight.waiters <= 0) activeFlight.controller.abort();
          resolveOutcome({ isError: true, output: 'Glob aborted' });
          return;
        }
        let settled = false;
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          activeFlight.waiters -= 1;
          if (activeFlight.waiters <= 0) activeFlight.controller.abort();
          resolveOutcome({ isError: true, output: 'Glob aborted' });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        activeFlight.promise.then(
          (result) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            activeFlight.waiters -= 1;
            resolveOutcome(result);
          },
          (error) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            activeFlight.waiters -= 1;
            rejectOutcome(error);
          },
        );
      });
      if (!('kind' in outcome)) {
        return outcome;
      }
      rawPaths = outcome.rawPaths;
      bufferTruncated = outcome.bufferTruncated;
      timedOut = outcome.timedOut;
      traversalWarning = outcome.traversalWarning;
    }

    let kept: readonly string[];
    let filteredSensitive: number;
    const cachedSensitive = sensitiveFilterCache.get(rawPaths);
    if (cachedSensitive !== undefined) {
      kept = cachedSensitive.kept;
      filteredSensitive = cachedSensitive.filteredSensitive;
    } else {
      const nextKept: string[] = [];
      let nextFiltered = 0;
      let yieldedAt = performance.now();
      for (let i = 0; i < rawPaths.length; i += 1) {
        const candidate = rawPaths[i]!;
        if (isSensitiveFile(candidate)) nextFiltered++;
        else nextKept.push(candidate);
        if ((i & 511) === 511 && performance.now() - yieldedAt >= 2.5) {
          await new Promise<void>((resolveYield) => { setImmediate(resolveYield); });
          if (signal.aborted) return { isError: true, output: 'Glob aborted' };
          yieldedAt = performance.now();
        }
      }
      sensitiveFilterCache.set(rawPaths, { kept: nextKept, filteredSensitive: nextFiltered });
      kept = nextKept;
      filteredSensitive = nextFiltered;
    }

    const offset = args.offset ?? 0;
    const headLimit = args.head_limit ?? DEFAULT_HEAD_LIMIT;
    const limited = headLimit === 0 ? kept.slice(offset) : kept.slice(offset, offset + headLimit);
    const partial = bufferTruncated || timedOut || traversalWarning !== undefined;

    const pathClass = env.pathClass;
    const shouldRelativize = !(processService instanceof SshHostProcessService);
    const candidates = limited;

    const warnings: string[] = [];
    if (timedOut) {
      warnings.push(
        `Glob timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s; partial results returned.`,
      );
    }
    if (bufferTruncated) {
      warnings.push(
        `[stdout truncated at ${String(MAX_OUTPUT_BYTES)} bytes; results may be incomplete — use a more specific pattern]`,
      );
    }
    if (traversalWarning !== undefined) {
      warnings.push(traversalWarning);
    }
    const pageNotices = (
      count: number,
      characterLimited: boolean,
    ): { lines: string[]; footer: string[] } => {
      const lines = [...warnings];
      const footer: string[] = [];
      const truncated = characterLimited || offset + count < kept.length;
      if (count === 0) {
        if (kept.length > 0) {
          const resultSet = partial ? 'collected partial result set' : 'current result set';
          lines.push(
            `No more matches at offset=${String(offset)} in the ${resultSet} (${String(kept.length)} matches).`,
          );
        } else if (partial) {
          lines.push('No matches collected; search incomplete.');
        } else if (filteredSensitive > 0) {
          lines.push(`No matches found (${String(filteredSensitive)} sensitive file(s) filtered).`);
        } else {
          lines.push('No matches found');
        }
      } else if (truncated || offset > 0 || partial) {
        const total = partial
          ? `${String(kept.length)} collected matches (partial result set)`
          : String(kept.length);
        lines.push(
          `Showing matches ${String(offset + 1)}–${String(offset + count)} of ${total}.`,
        );
      }
      if (characterLimited) {
        lines.push('Character limit reached; only complete paths are returned.');
      }
      if (truncated) {
        lines.push(
          `Continue with the same search arguments and offset=${String(offset + count)}.`,
        );
        if (!characterLimited) {
          lines.push('To remove the match-count limit, omit offset and use head_limit=0.');
        }
      }
      if (filteredSensitive > 0 && (kept.length > 0 || partial)) {
        footer.push(`Filtered ${String(filteredSensitive)} sensitive file(s).`);
      }
      if (!truncated && !partial && offset === 0 && headLimit > 0 && count === headLimit) {
        footer.push(`Found ${String(count)} matches`);
      }
      return { lines, footer };
    };
    const noticeChars = Math.max(
      ...([false, true] as const).map((characterLimited) => {
        const notices = pageNotices(candidates.length, characterLimited);
        return [...notices.lines, ...notices.footer].join('\n').length + 2;
      }),
    );
    let remaining = DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS - noticeChars;
    const displayLines: string[] = [];
    for (const path of candidates) {
      const p = shouldRelativize ? relativizeIfUnder(path, workspace.workspaceDir, pathClass) : path;
      if (p.length + 1 > remaining) break;
      displayLines.push(p);
      remaining -= p.length + 1;
    }
    if (candidates.length > 0 && displayLines.length === 0) {
      return {
        isError: true,
        output:
          'Glob cannot fit a complete path and its diagnostics within the output limit. Narrow the search path or pattern.',
      };
    }
    const notices = pageNotices(displayLines.length, displayLines.length < candidates.length);
    return { output: [...notices.lines, ...displayLines, ...notices.footer].join('\n') };
  }
}

registerAgentToolService(IGlobTool, GlobTool, {
  name: 'Glob',
  domain: 'os/backends',
  requiredRuntimeCapabilities: ['fs', 'process'],
});

function createRgProbe(processService: IHostProcessService): RgProbe {
  return {
    exec: async (args) => {
      const [command, ...rest] = args;
      if (command === undefined) return { exitCode: -1 };
      const proc = await processService.spawn(command, rest);
      try {
        proc.stdin.end();
      } catch {
      }
      proc.stdout.resume();
      proc.stderr.resume();
      const exitCode = await proc.wait();
      try {
        void proc.dispose();
      } catch {
      }
      return { exitCode };
    },
  };
}

function buildRgArgs(rgPath: string, args: GlobInput, singleThreaded = false, insensitive = false): string[] {
  const cmd: string[] = [rgPath];
  if (singleThreaded) cmd.push('-j', '1');
  cmd.push('--files', '--hidden', '--sortr=modified');
  const pattern = args.pattern.replace(/^\//, '');
  if (!/\{[^}]*\//u.test(pattern) && !pattern.includes('**') && (pattern === '*' || pattern.includes('/'))) {
    cmd.push('--max-depth', String(pattern.split('/').length));
  }
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    cmd.push('--glob', `!${dir}`);
  }
  if (insensitive) cmd.push('--glob-case-insensitive');
  cmd.push('--glob', pattern);
  if (args.include_ignored) cmd.push('--no-ignore');
  cmd.push('.');
  return cmd;
}

function formatGlobError(searchRoot: string, stderr: string): string {
  const trimmed = stderr.trim();
  if (/no such file or directory/i.test(trimmed)) {
    return `${searchRoot} does not exist`;
  }
  return trimmed.length > 0 ? `Glob failed: ${trimmed}` : 'Glob failed';
}

function formatGlobWarning(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > 0
    ? `Glob completed with warnings; some directories could not be read: ${trimmed}`
    : 'Glob completed with warnings; some directories could not be read.';
}

export function splitCompletePaths(stdoutText: string, truncatedOutput: boolean): string[] {
  let text = stdoutText;
  if (truncatedOutput && !text.endsWith('\n')) {
    const lastNewline = text.lastIndexOf('\n');
    text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
  }
  return text.split('\n').filter((p) => p.length > 0);
}

function relativizeIfUnder(candidate: string, base: string, pathClass: PathClass): string {
  const normCandidate = normalize(candidate);
  const normBase = normalize(base);
  const comparableCandidate = pathClass === 'win32' ? normCandidate.toLowerCase() : normCandidate;
  const comparableBase = pathClass === 'win32' ? normBase.toLowerCase() : normBase;
  if (comparableCandidate === comparableBase) return '.';
  const prefix = comparableBase.endsWith('/') ? comparableBase : comparableBase + '/';
  if (comparableCandidate.startsWith(prefix)) {
    return normCandidate.slice(prefix.length);
  }
  return normCandidate;
}
