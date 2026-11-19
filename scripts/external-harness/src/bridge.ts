import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  AGY_COMMAND_GUIDANCE_HOOK_KEY,
  AGY_STEERING_HOOK_KEY,
  recoverProjectHook,
  registerProjectHook,
} from '../agy-hook-registration.mjs';
import {
  recoverDeadProjectMcpPlugins,
  registerProjectMcpPlugin,
  type McpServerConfig,
} from '../agy-mcp-plugin.mjs';
import {
  openPermissionChannel,
  permissionChannelIdentity,
  type PermissionResponse,
} from '../agy-permission-hook.mjs';
import {
  accumulateStepUsage,
  catalogDiagnostic,
  configOptions,
  emptyUsage,
  launchArgs,
  processAlive,
  promptText,
  readVendorModelCatalog,
  safeDiagnosticLine,
  subagentPayload,
  takeNewDenials,
  terminate,
  validateEffort,
  type SelectConfigOption,
} from './catalog';
import {
  inspectNativeErrorWatchdogState,
  readLegacyNativeRecovery,
  unconsumedNetworkContinuationProof,
} from './legacyRecovery';
import { NdjsonFrameDecoder, writeNdjsonFrame } from './ndjson';
import {
  DEFAULT,
  ERROR_RESULT_WATCHDOG_MS,
  LEGACY_NETWORK_FAILURE,
  MAX_CONSECUTIVE_NETWORK_RECOVERIES,
  NATIVE_ID,
  NETWORK_RECOVERY_BACKOFF_MS,
  NETWORK_RECOVERY_EXIT_GRACE_MS,
  NETWORK_RECOVERY_INSTRUCTION,
  type AcpClientProxy,
  type ActiveTurn,
  type AgyAccountConfig,
  type AgyBridgeOptions,
  type AgyError,
  type AgyNativeEvent,
  type AgyResultPayload,
  type AgySession,
  type AuditRecord,
  type LegacyRecoveryProof,
  type SpawnProcessFn,
  type StopProcessFn,
  type UnresolvedTool,
  type UsageTotals,
} from './types';

function asAgyError(error: unknown): AgyError {
  if (error instanceof Error) return error as AgyError;
  return new Error(String(error)) as AgyError;
}

export class AgyBridge {
  stopProcess: StopProcessFn;
  continuationExitGraceMs: number;
  networkRecoveryBackoffMs: readonly number[];
  maxConsecutiveNetworkRecoveries: number;
  errorResultWatchdogMs: number;
  account?: AgyAccountConfig;
  requestedModel: string;
  onAccountExit?: () => void;
  model: string;
  cliPath: string;
  cliPrefix: string[];
  auditDir?: string;
  nativeHome: string;
  spawnProcess: SpawnProcessFn;
  sessions: Map<string, AgySession>;
  modelChoices?: string[];
  modelDiagnostic?: string;
  closePromise?: Promise<void[]>;

  constructor({
    cliPath,
    cliPrefix = [],
    auditDir,
    nativeHome = resolve(homedir(), '.gemini', 'antigravity-cli'),
    model = DEFAULT,
    spawnProcess = spawn as SpawnProcessFn,
    stopProcess = terminate,
    account,
    onAccountExit,
    continuationExitGraceMs = NETWORK_RECOVERY_EXIT_GRACE_MS,
    networkRecoveryBackoffMs = NETWORK_RECOVERY_BACKOFF_MS,
    maxConsecutiveNetworkRecoveries = MAX_CONSECUTIVE_NETWORK_RECOVERIES,
    errorResultWatchdogMs = ERROR_RESULT_WATCHDOG_MS,
  }: AgyBridgeOptions = {}) {
    this.stopProcess = stopProcess;
    this.continuationExitGraceMs = continuationExitGraceMs;
    this.networkRecoveryBackoffMs = networkRecoveryBackoffMs;
    this.maxConsecutiveNetworkRecoveries = maxConsecutiveNetworkRecoveries;
    this.errorResultWatchdogMs = errorResultWatchdogMs;
    if (!isAbsolute(cliPath ?? '')) throw new Error('Pass the exact absolute AGY executable path');
    if (typeof model !== 'string' || !model || /\s/.test(model)) {
      throw new Error('AGY model must be a nonempty engine ID');
    }
    if (account && model !== DEFAULT && !account.modelIds.includes(model)) {
      throw new Error('The selected account does not provide the bound AGY model');
    }
    this.account = account;
    this.requestedModel = model;
    this.onAccountExit = onAccountExit;
    this.model = account && model === DEFAULT ? account.modelIds[0]! : model;
    this.cliPath = cliPath!;
    this.cliPrefix = cliPrefix;
    this.auditDir = auditDir;
    this.nativeHome = nativeHome;
    this.spawnProcess = spawnProcess;
    this.sessions = new Map();
  }

  async audit(
    session: { id: string },
    type: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.auditDir) return;
    await mkdir(this.auditDir, { recursive: true });
    await appendFile(
      resolve(this.auditDir, `${session.id}.ndjson`),
      JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n',
    );
  }

  initialize(version: unknown): Record<string, unknown> {
    return {
      protocolVersion: version,
      agentInfo: { name: 'agy-cli-acp', version: '0.2.0' },
      agentCapabilities: {
        loadSession: Boolean(this.auditDir),
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { additionalDirectories: {} },
      },
      authMethods: [],
      _meta: { steering: { supported: true } },
    };
  }

  async requestPermission(): Promise<PermissionResponse> {
    return { decision: 'ask' };
  }

  async newSession(
    params: {
      cwd: string;
      additionalDirectories?: string[];
      mcpServers?: McpServerConfig[];
      _meta?: Record<string, unknown>;
    },
    id: string = randomUUID(),
    event = 'session_new',
    recovery?: unknown,
  ): Promise<{ sessionId: string; configOptions: SelectConfigOption[] }> {
    const mcpServers = params.mcpServers ?? [];
    if (
      !Array.isArray(mcpServers) ||
      mcpServers.some(
        (server) =>
          !server ||
          typeof server.name !== 'string' ||
          !server.name ||
          typeof server.command !== 'string' ||
          !server.command ||
          !Array.isArray(server.args) ||
          server.args.some((arg) => typeof arg !== 'string') ||
          !Array.isArray(server.env) ||
          server.env.some((entry) => typeof entry.name !== 'string' || typeof entry.value !== 'string'),
      )
    ) {
      throw new Error('AGY session MCP requires named stdio servers with command, args and env');
    }
    if (params._meta?.['systemPromptOverride'] !== undefined) {
      throw new Error('System replacement is unsupported; use explicit Kiki preamble delivery');
    }
    if (!isAbsolute(params.cwd)) throw new Error('AGY workspace must be absolute');
    const dirs = params.additionalDirectories ?? [];
    if (!Array.isArray(dirs) || dirs.some((d) => typeof d !== 'string' || !isAbsolute(d))) {
      throw new Error('Additional directories must be absolute');
    }
    const session: AgySession = {
      id,
      cwd: params.cwd,
      additionalDirectories: dirs,
      model: this.model,
      effort: DEFAULT,
      modelChoices: this.modelChoices,
      accountBound: this.account !== undefined,
      mcpServers: structuredClone(mcpServers),
      mcpPlugin: undefined,
      mcpBound: new Set(),
      mcpReady: new Set(),
      permissionIdentity: permissionChannelIdentity(),
      permissionChannel: undefined,
      child: undefined,
      active: undefined,
      broken: false,
      init: undefined,
      exited: undefined,
      denialCounts: new Map(),
      toolIds: new Map(),
      toolDetails: new Map(),
      toolInputs: new Map(),
    };
    this.sessions.set(session.id, session);
    try {
      await this.recoverDeadOwnedResources(session);
      await this.audit(session, event, {
        cwd: session.cwd,
        additionalDirectories: dirs,
        delivery: event === 'session_new' ? 'first_user_preamble' : 'native_conversation',
        systemOverride: false,
        recovery,
      });
      return { sessionId: session.id, configOptions: configOptions(session) };
    } catch (error) {
      await session.permissionChannel?.close();
      await this.closeSteeringHook(session).catch(() => {});
      this.sessions.delete(session.id);
      throw error;
    }
  }

  async loadSession(params: {
    sessionId: string;
    cwd: string;
    additionalDirectories?: string[];
    mcpServers?: McpServerConfig[];
    _meta?: Record<string, unknown>;
  }): Promise<{ configOptions: SelectConfigOption[] }> {
    if (!this.auditDir) throw new Error('AGY native load requires the existing adapter audit directory');
    if (!/^[0-9a-f-]{36}$/i.test(params.sessionId)) throw new Error('Invalid AGY adapter session ID');
    if (this.sessions.has(params.sessionId)) throw new Error('AGY session is already owned by this connection');
    const auditPath = resolve(this.auditDir, `${params.sessionId}.ndjson`);
    const readAudit = async (): Promise<AuditRecord[]> =>
      (await readFile(auditPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AuditRecord);
    const records = await readAudit().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' || params._meta?.['kiki.agyLegacyRecovery'] === undefined) throw error;
      return undefined;
    });
    const workspace = records?.find((record) =>
      ['session_new', 'legacy_native_recovered'].includes(record.type),
    );
    const launch = records?.findLast((record) => record.type === 'launch');
    if (records === undefined || (!launch && workspace?.type === 'legacy_native_recovered')) {
      return this.loadLegacySession(params, readAudit, workspace);
    }
    const init = records.findLast((record) => record.type === 'agy_init');
    if (
      !workspace ||
      !launch ||
      !init?.['conversationId'] ||
      records.indexOf(init) < records.indexOf(launch)
    ) {
      throw new Error(
        'AGY session has no confirmed native conversation to load; retain the failed attempt and create a new session',
      );
    }
    if (
      resolve(params.cwd) !== resolve(workspace['cwd'] as string) ||
      JSON.stringify(params.additionalDirectories ?? []) !==
        JSON.stringify(workspace['additionalDirectories'] ?? [])
    ) {
      throw new Error('AGY native load workspace differs from its original binding');
    }
    if (records.some((record) => record.type === 'mcp_agent_registered')) {
      throw new Error(
        'This native conversation used the former custom MCP agent; retain its original adapter for recovery or create a new native main session',
      );
    }
    const mcpBinding = records.findLast((record) => record.type === 'mcp_plugin_registered');
    if (mcpBinding && typeof mcpBinding['name'] !== 'string') {
      throw new Error(
        'AGY native load has no audited MCP plugin namespace; preserve its original adapter for recovery',
      );
    }
    if (
      mcpBinding &&
      JSON.stringify(params.mcpServers?.map((server) => server.name) ?? []) !==
        JSON.stringify(mcpBinding['servers'])
    ) {
      throw new Error('AGY native load requires fresh MCP connections matching its original server names');
    }
    const launchArgsArr = (launch['args'] as string[]) ?? [];
    const argValue = (name: string): string => {
      const index = launchArgsArr.lastIndexOf(name);
      return index < 0 ? DEFAULT : (launchArgsArr[index + 1] ?? DEFAULT);
    };
    const model = argValue('--model') === DEFAULT ? init['model'] : argValue('--model');
    if (
      typeof model !== 'string' ||
      !model ||
      (this.account
        ? !this.account.modelIds.includes(model) ||
          (this.requestedModel !== DEFAULT && model !== this.requestedModel)
        : this.model !== DEFAULT && model !== this.model)
    ) {
      throw new Error(
        this.account
          ? 'AGY native load model differs from its original binding or is unavailable for the selected account'
          : 'AGY native load model differs from its original binding or was not confirmed',
      );
    }
    const effort = (launch['effort'] as string | undefined) ?? argValue('--effort');
    validateEffort(model, effort);
    if (processAlive(launch['pid'] as number)) {
      throw new Error('AGY native conversation still has an owned process; close it before loading');
    }
    const release = await this.claimResume(params.sessionId);
    try {
      const latest = await readAudit();
      const retired = latest.findLast(
        (record) =>
          record.type === 'cancel_requested' ||
          record.type === 'cancel_failed' ||
          (record.type === 'cancel' && record['resumeSupported'] === false) ||
          (record.type === 'tool_terminal_missing' &&
            Array.isArray(record['tools']) &&
            record['tools'].length > 0),
      );
      if (retired) {
        const error: AgyError = new Error(
          `AGY native session is retired or unreconciled (${retired.type}); inspect the native outcome before deciding what to run in a fresh session; do not replay interrupted prompts or commands`,
        );
        error.code = 'AGY_SESSION_RETIRED';
        error.details = {
          reason: retired.type,
          unresolvedTools: retired['unresolvedTools'] ?? retired['tools'] ?? [],
        };
        throw error;
      }
      const turn = latest.findLast(
        (record) => record.type === 'native_turn_pending' || record.type === 'native_turn_reconciled',
      );
      if (turn?.type === 'native_turn_pending') {
        const unconsumedProof = !mcpBinding
          ? unconsumedNetworkContinuationProof(latest, {
              sessionId: params.sessionId,
              conversationId: init['conversationId'] as string,
              model,
              effort,
              cwd: workspace['cwd'] as string,
              additionalDirectories: (workspace['additionalDirectories'] as string[] | undefined) ?? [],
            })
          : undefined;
        let reconciled = false;
        if (unconsumedProof !== undefined) {
          try {
            await readLegacyNativeRecovery({
              nativeHome: this.nativeHome,
              cwd: workspace['cwd'] as string,
              additionalDirectories: (workspace['additionalDirectories'] as string[] | undefined) ?? [],
              sessionId: params.sessionId,
              proof: unconsumedProof,
              model,
            });
            reconciled = true;
          } catch {}
        }
        if (!reconciled) {
          const error: AgyError = new Error(
            'AGY native session has an unconfirmed turn; wait for its native outcome to be reconciled before loading; do not replay the interrupted prompt or commands',
          );
          error.code = 'AGY_SESSION_UNCONFIRMED';
          throw error;
        }
        await this.audit({ id: params.sessionId }, 'native_turn_reconciled', {
          conversationId: init['conversationId'],
          status: 'ERROR',
          reconciledFromNativeDb: true,
          unconsumedContinuationAttempt: 1,
        });
      }
      await this.newSession(params, params.sessionId, 'session_loaded');
      const session = this.session(params.sessionId);
      session.model = model;
      session.effort = effort;
      session.conversationId = init['conversationId'] as string;
      session.mcpNamespace = mcpBinding?.['name'] as string | undefined;
      session.releaseResume = release;
      return { configOptions: configOptions(session) };
    } catch (error) {
      await release();
      this.sessions.delete(params.sessionId);
      throw error;
    }
  }

  async claimResume(sessionId: string): Promise<() => Promise<void>> {
    await mkdir(this.auditDir!, { recursive: true });
    const path = resolve(this.auditDir!, `${sessionId}.resume-lock`);
    const claim = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    let file;
    try {
      file = await open(path, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = await readFile(path, 'utf8');
      if (processAlive((JSON.parse(previous) as { pid: number }).pid)) {
        throw new Error('AGY native conversation is already being loaded');
      }
      throw new Error(
        `AGY native load lease is stale; recover only this exact owned lease after confirming no live adapter: ${path}`,
      );
    }
    try {
      await file.writeFile(claim);
    } finally {
      await file.close();
    }
    return async () => {
      try {
        if ((await readFile(path, 'utf8')) === claim) await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    };
  }

  async loadLegacySession(
    params: {
      sessionId: string;
      cwd: string;
      additionalDirectories?: string[];
      mcpServers?: McpServerConfig[];
      _meta?: Record<string, unknown>;
    },
    readAudit: () => Promise<AuditRecord[]>,
    previous: AuditRecord | undefined,
  ): Promise<{ configOptions: SelectConfigOption[] }> {
    const additionalDirectories = params.additionalDirectories ?? [];
    if (
      (params.mcpServers?.length ?? 0) !== 0 ||
      !Array.isArray(additionalDirectories) ||
      additionalDirectories.some((dir) => typeof dir !== 'string' || !isAbsolute(dir))
    ) {
      throw new Error('AGY legacy native recovery requires the original default-home non-MCP binding');
    }
    if (
      previous &&
      (resolve(params.cwd) !== resolve(previous['cwd'] as string) ||
        JSON.stringify(additionalDirectories) !==
          JSON.stringify(previous['additionalDirectories'] ?? []))
    ) {
      throw new Error('AGY legacy native conversation or workspace differs from its original binding');
    }
    const prevRecovery = previous?.['recovery'] as { proof?: LegacyRecoveryProof } | undefined;
    const proof = (prevRecovery?.proof ??
      params._meta?.['kiki.agyLegacyRecovery']) as LegacyRecoveryProof | undefined;
    const release = await this.claimResume(params.sessionId);
    try {
      const latest = await readAudit().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return [] as AuditRecord[];
      });
      const latestRecovery = latest.find((record) => record.type === 'legacy_native_recovered');
      if (
        JSON.stringify(latestRecovery) !== JSON.stringify(previous) ||
        latest.some(
          (record) =>
            ![
              'legacy_native_recovered',
              'session_loaded',
              'owned_recovery',
              'permission_mode_configured',
              'close',
            ].includes(record.type),
        )
      ) {
        throw new Error('AGY legacy recovery state changed; preserve the original session without replay');
      }
      const model = proof?.model;
      if (
        typeof model !== 'string' ||
        !model ||
        (this.requestedModel !== DEFAULT && model !== this.requestedModel) ||
        (this.account && !this.account.modelIds.includes(model))
      ) {
        throw new Error('AGY legacy native model is not available for this binding');
      }
      const recovered = await readLegacyNativeRecovery({
        nativeHome: this.nativeHome,
        cwd: params.cwd,
        additionalDirectories,
        sessionId: params.sessionId,
        proof,
        model,
      });
      validateEffort(recovered.model, recovered.effort);
      await this.newSession(
        params,
        params.sessionId,
        previous ? 'session_loaded' : 'legacy_native_recovered',
        previous ? undefined : { ...recovered, proof },
      );
      const session = this.session(params.sessionId);
      session.model = recovered.model;
      session.effort = recovered.effort;
      session.conversationId = recovered.conversationId;
      session.releaseResume = release;
      return { configOptions: configOptions(session) };
    } catch (error) {
      await release();
      this.sessions.delete(params.sessionId);
      throw error;
    }
  }

  session(id: string): AgySession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(
        'Unknown AGY session; use session/load for exact audited native recovery. Fork is unsupported',
      );
    }
    return session;
  }

  async loadVendorModels(): Promise<void> {
    if (this.account) {
      this.modelChoices = this.account.modelIds;
      return;
    }
    try {
      const result = await readVendorModelCatalog({
        cliPath: this.cliPath,
        cliPrefix: this.cliPrefix,
        spawnProcess: this.spawnProcess,
        stopProcess: this.stopProcess,
      });
      this.modelChoices = result.ok ? result.ids : undefined;
      this.modelDiagnostic = result.ok ? undefined : result.diagnostic;
    } catch (error) {
      this.modelChoices = undefined;
      this.modelDiagnostic = catalogDiagnostic(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  setModel(session: AgySession, value: string): { configOptions: SelectConfigOption[] } {
    if (session.accountBound && value === DEFAULT) value = this.account!.modelIds[0]!;
    if (typeof value !== 'string' || value.length === 0 || /\s/u.test(value)) {
      throw new Error('AGY model must be a nonempty engine ID');
    }
    if (session.child && session.model !== value) {
      throw new Error('AGY model/effort is frozen after process launch; select a fresh session');
    }
    if (!Array.isArray(session.modelChoices)) {
      throw new Error('AGY model catalog is unavailable; model is selected by argv in its own namespace');
    }
    if (value !== DEFAULT && value !== session.model && !session.modelChoices.includes(value)) {
      throw new Error(`AGY model ID ${value} is not in the vendor catalog`);
    }
    validateEffort(value, session.effort);
    session.model = value;
    return { configOptions: configOptions(session) };
  }

  setConfig(params: {
    sessionId: string;
    configId: string;
    value: string;
  }): { configOptions: SelectConfigOption[] } | Promise<{ configOptions: SelectConfigOption[] }> {
    const session = this.session(params.sessionId);
    if (params.configId === 'model') return this.setModel(session, params.value);
    if (params.configId === 'permission-mode') return this.setPermissionMode(session, params.value);
    if (params.configId === 'native-agent') {
      if (params.value !== DEFAULT) {
        throw new Error(
          'AGY adapter supports only the native default agent; other native agents have not been discovered',
        );
      }
      return { configOptions: configOptions(session) };
    }
    const key = params.configId === 'effort' ? 'effort' : undefined;
    if (!key) {
      throw new Error('Unsupported AGY config option; model is selected by argv in its own namespace');
    }
    if (session.child && session[key] !== params.value) {
      throw new Error('AGY model/effort is frozen after process launch; select a fresh session');
    }
    validateEffort(session.model, params.value);
    session[key] = params.value;
    return { configOptions: configOptions(session) };
  }

  async setPermissionMode(
    session: AgySession,
    value: string,
  ): Promise<{ configOptions: SelectConfigOption[] }> {
    if (![DEFAULT, 'manual', 'auto', 'yolo'].includes(value)) {
      throw new Error(
        `AGY native permission mode ${value} is unsupported; review requires the Kiki native executor`,
      );
    }
    if (session.permissionMode === value) return { configOptions: configOptions(session) };
    if (session.active) throw new Error('AGY permission mode cannot change during an active turn');
    if (session.child) {
      const conversationId = session.init?.conversation_id;
      if (!conversationId || session.broken) {
        throw new Error('AGY permission changes require a confirmed healthy native conversation');
      }
      session.restarting = true;
      try {
        await this.stopProcess(session.child);
        await session.cleanup;
        session.conversationId = conversationId;
        session.child = undefined;
        session.init = undefined;
        session.exited = undefined;
        session.cleanup = undefined;
        session.permissionChannel = undefined;
        session.mcpPlugin = undefined;
        session.mcpBound.clear();
        session.mcpReady.clear();
        session.broken = false;
      } finally {
        session.restarting = false;
      }
    }
    session.permissionMode = value;
    await this.audit(session, 'permission_mode_configured', {
      value,
      mechanism: 'native-session-settings',
    });
    return { configOptions: configOptions(session) };
  }

  async syncPermissionHook(session: AgySession): Promise<void> {
    session.permissionChannel ??= await openPermissionChannel(
      (input) =>
        ['mcp_bootstrap', 'mcp_ready'].includes(String(input?.['type']))
          ? this.bindMcpBootstrap(session, input)
          : input?.['type'] === 'steer_poll'
            ? this.pollSteering(session, input)
            : this.requestPermission(),
      session.permissionIdentity,
    );
  }

  async registerMcpPlugin(session: AgySession): Promise<void> {
    if (!session.mcpServers.length || session.mcpPlugin) return;
    session.mcpPlugin = await registerProjectMcpPlugin({
      cwd: session.cwd,
      sessionId: session.id,
      namespace: session.mcpNamespace,
      nodePath: process.execPath,
      handlerPath: fileURLToPath(import.meta.url),
      servers: session.mcpServers,
    });
    await this.audit(session, 'mcp_plugin_registered', {
      name: session.mcpPlugin.name,
      path: session.mcpPlugin.path,
      servers: session.mcpServers.map((server) => server.name),
      nativeAgent: 'engine-default',
    });
  }

  async bindMcpBootstrap(
    session: AgySession,
    input: Record<string, unknown>,
  ): Promise<PermissionResponse> {
    const key = typeof input['key'] === 'string' ? input['key'] : '';
    if (!session.mcpPlugin || !Object.hasOwn(session.mcpPlugin.env, key) || session.broken) {
      return { decision: 'deny', reason: 'The MCP bootstrap does not belong to this active session' };
    }
    if (input['type'] === 'mcp_ready') {
      if (!session.mcpBound.has(key)) {
        return { decision: 'deny', reason: 'The MCP bootstrap has not been admitted' };
      }
      session.mcpReady.add(key);
    } else {
      session.mcpBound.add(key);
    }
    const serverIndex = Object.keys(session.mcpPlugin.env).indexOf(key);
    await this.audit(session, input['type'] === 'mcp_ready' ? 'mcp_stdio_ready' : 'mcp_stdio_bound', {
      server: session.mcpServers[serverIndex]?.name,
    });
    return { decision: 'allow' };
  }

  /**
   * A previous adapter killed before its close ran can leave its owned hook keys and MCP
   * plugin in this workspace. Before this session registers its own, recover only those
   * whose every recorded owner process has exited; live leases, edited files and foreign
   * entries are preserved and reported in the audit instead of failing the session.
   */
  async recoverDeadOwnedResources(session: AgySession): Promise<void> {
    if (session.ownedRecoveryDone) return;
    session.ownedRecoveryDone = true;
    const results: Record<string, unknown> = {};
    try {
      results['hooks'] = (
        await recoverProjectHook({
          cwd: session.cwd,
          nodePath: process.execPath,
          handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)),
        })
      ).status;
    } catch (error) {
      results['hooks'] = {
        status: 'preserved',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      results['plugins'] = await recoverDeadProjectMcpPlugins({ cwd: session.cwd });
    } catch (error) {
      results['plugins'] = {
        status: 'preserved',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const plugins = results['plugins'];
    if (
      results['hooks'] !== 'no-owned-registration' ||
      (Array.isArray(plugins) && plugins.length > 0)
    ) {
      this.auditQuietly(session, 'owned_recovery', results);
    }
  }

  async registerSteeringHook(session: AgySession): Promise<void> {
    session.steeringRegistration ??= await registerProjectHook({
      cwd: session.cwd,
      nodePath: process.execPath,
      handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)),
      sessionId: session.id,
      key: AGY_STEERING_HOOK_KEY,
      args: ['--steering'],
    });
    if (!session.child && !session.conversationId) {
      session.commandGuidanceRegistration ??= await registerProjectHook({
        cwd: session.cwd,
        nodePath: process.execPath,
        handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)),
        sessionId: session.id,
        key: AGY_COMMAND_GUIDANCE_HOOK_KEY,
        args: ['--command-guidance'],
      });
    }
  }

  /**
   * Removes the turn's owned steering and startup guidance keys. A failed removal keeps
   * its registration for the next turn end, cancel or close; cleanup never replaces the result.
   */
  async closeSteeringHook(session: AgySession): Promise<void> {
    const errors: unknown[] = [];
    for (const key of ['steeringRegistration', 'commandGuidanceRegistration'] as const) {
      const registration = session[key];
      if (!registration) continue;
      try {
        await registration.close();
        if (session[key] === registration) session[key] = undefined;
      } catch (error) {
        this.auditQuietly(session, 'steering_hook_close_failed', {
          registration: key,
          error: error instanceof Error ? error.message : String(error),
        });
        errors.push(error);
      }
    }
    if (errors.length) throw errors[0];
  }

  auditQuietly(session: { id: string }, type: string, data?: Record<string, unknown>): void {
    this.audit(session, type, data).catch(() => {});
  }

  /**
   * Accepts one steering message for the running native turn. The text waits in this
   * session until AGY's next PostInvocation hook drains it into the same invocation loop.
   * An idle session returns `promptRequired` so the host submits a normal prompt instead.
   */
  async steer(params: {
    sessionId: string;
    prompt: unknown;
  }): Promise<{ outcome: string; reason?: string }> {
    const session = this.session(params.sessionId);
    const active = session.active;
    if (!active || session.broken || !session.steeringRegistration) {
      return { outcome: 'promptRequired', reason: 'noRunningTurn' };
    }
    const text = promptText(params.prompt);
    const id = randomUUID();
    await this.audit(session, 'steer_queued', {
      steerId: id,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
    if (session.active !== active || session.broken || !session.steeringRegistration) {
      this.auditQuietly(session, 'steer_not_delivered', { steerIds: [id] });
      return { outcome: 'promptRequired', reason: 'turnEnded' };
    }
    return new Promise((resolveSteer) => active.steering.push({ id, text, resolve: resolveSteer }));
  }

  releaseSteering(session: AgySession, active: ActiveTurn): void {
    const pending = active.steering.splice(0);
    if (pending.length) {
      this.auditQuietly(session, 'steer_not_delivered', { steerIds: pending.map((item) => item.id) });
    }
    for (const item of pending) item.resolve({ outcome: 'promptRequired', reason: 'turnEnded' });
  }

  async pollSteering(
    session: AgySession,
    input: Record<string, unknown>,
  ): Promise<PermissionResponse> {
    const active = session.active;
    if (
      !active ||
      session.broken ||
      !session.init ||
      input['conversationId'] !== session.init.conversation_id
    ) {
      return { decision: 'deny', reason: 'AGY steering poll does not belong to the running turn' };
    }
    if (active.steering.length === 0) return { decision: 'allow', steering: { injectSteps: [] } };
    const batch = active.steering.splice(0);
    this.auditQuietly(session, 'steer_delivering', {
      steerIds: batch.map((item) => item.id),
      invocationNum: input['invocationNum'],
    });
    let settled = false;
    const settle = (outcome: string, type: string): void => {
      if (settled) return;
      settled = true;
      if (outcome !== 'injected') active.steerDeliveryUnknown = true;
      this.auditQuietly(session, type, { steerIds: batch.map((item) => item.id) });
      for (const item of batch) item.resolve({ outcome });
    };
    return {
      decision: 'allow',
      steering: { injectSteps: batch.map((item) => ({ userMessage: item.text })) },
      afterWrite: () => settle('injected', 'steer_delivered'),
      afterFailure: () => settle('deliveryUnknown', 'steer_delivery_unknown'),
    };
  }

  async start(session: AgySession): Promise<void> {
    session.denialCounts = new Map();
    await this.registerMcpPlugin(session);
    const args = [...this.cliPrefix, ...launchArgs(session)];
    const env: NodeJS.ProcessEnv = { ...process.env, ...session.permissionIdentity };
    for (const key of Object.keys(env)) {
      if (key.startsWith('KIKI_AGY_MCP_')) delete env[key];
    }
    Object.assign(env, session.mcpPlugin?.env);
    const account = this.account;
    if (account) {
      Object.assign(env, { GEMINI_API_KEY: account.apiKey, GOOGLE_GEMINI_BASE_URL: account.baseUrl });
    }
    const redact = (text: string): string =>
      account
        ? text.replaceAll(account.apiKey, '[redacted]').replaceAll(account.baseUrl, '[redacted]')
        : text;
    let child: ChildProcess;
    try {
      await session.mcpPlugin?.beforeLaunch();
      child = this.spawnProcess(this.cliPath, args, {
        cwd: session.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      });
    } catch (error) {
      await session.permissionChannel?.close();
      await this.closeSteeringHook(session).catch(() => {});
      await session.mcpPlugin?.close();
      throw error;
    }
    session.child = child;
    session.exited = new Promise<void>((done) => child.once('close', () => done()));
    let stderr: Buffer = Buffer.alloc(0);
    let stderrTruncated = false;
    let delivery = Promise.resolve();
    let ingress = Promise.resolve();
    let sequence = 0;
    const fail = (error: unknown): Promise<void> => {
      session.broken = true;
      if (!session.cancelling) void Promise.resolve(this.stopProcess(child)).catch(() => {});
      return this.loseTurn(session, asAgyError(error));
    };
    const failFrame = (error: Error): void => {
      decoder.stop();
      session.broken = true;
      if (!session.cancelling) void Promise.resolve(this.stopProcess(child)).catch(() => {});
      delivery = delivery.then(() => this.loseTurn(session, error));
    };
    const decoder = new NdjsonFrameDecoder<AgyNativeEvent>({
      reviver: account
        ? (_key, value) => (typeof value === 'string' ? redact(value) : value)
        : undefined,
      onFrame: (event) => {
        const frame = {
          sequence: ++sequence,
          receivedAt: new Date().toISOString(),
          event: event?.event,
          stepIndex: event?.step_update?.step_index,
          stepType: event?.step_update?.step_type,
          state: event?.step_update?.state,
          status: event?.result?.status,
        };
        this.clearErrorResultWatchdog(session.active);
        ingress = ingress
          .then(() => this.audit(session, 'native_frame_received', frame))
          .catch(fail);
        delivery = delivery
          .then(async () => {
            await this.event(session, event);
            await this.audit(session, 'native_frame_delivered', { sequence: frame.sequence });
          })
          .catch(fail);
      },
      onError: failFrame,
    });
    session.drainReceived = () => {
      decoder.stop();
      return Promise.all([ingress, delivery]);
    };
    session.queueInternalAction = (action) => {
      delivery = delivery.then(action).catch(fail);
      return delivery;
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      decoder.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (/auto-denied|soft.denied|permission.*denied/i.test(text) && session.active) {
        session.active.denied = true;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrTruncated ||= stderr.length + bytes.length > 8192;
      const tail = Buffer.concat([stderr, bytes.subarray(Math.max(0, bytes.length - 8192))]);
      stderr = tail.subarray(Math.max(0, tail.length - 8192));
      if (!account) process.stderr.write(chunk);
    });
    child.stdin?.on('error', (error) => {
      if (session.child === child && session.active?.continuationWriter !== child) void fail(error);
    });
    child.on('error', (error) => {
      void fail(error);
    });
    child.once('close', (code, signal) => {
      const lines = stderr.toString('utf8').split(/\r?\n/u);
      if (stderrTruncated) lines.shift();
      const diagnostic = lines
        .map((line) => safeDiagnosticLine(redact(line)))
        .findLast((line) => line !== undefined);
      stderr = Buffer.alloc(0);
      const owned = child;
      const channel = session.permissionChannel;
      if (session.child === owned) session.broken = true;
      session.cleanup = (async () => {
        try {
          await Promise.all([ingress, delivery]);
        } finally {
          if (session.child === owned) {
            if (session.active && !session.cancelling) {
              const message = `AGY exited before terminal result (code: ${code ?? 'none'}, signal: ${signal ?? 'none'})${diagnostic === undefined ? '' : `: ${diagnostic}`}`;
              const error: AgyError = new Error(message);
              error.code = 'AGY_EARLY_EXIT';
              error.details = { exitCode: code ?? null, signal: signal ?? null, diagnostic };
              await this.loseTurn(session, error);
            }
            await channel?.close();
            await this.closeSteeringHook(session).catch(() => {});
            await session.mcpPlugin?.close();
            if (!session.restarting) await session.releaseResume?.();
          }
        }
      })();
      const ended = (): void => {
        if (account && session.child === owned && !session.restarting) this.onAccountExit?.();
      };
      void session.cleanup.then(ended, (error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`AGY owned permission cleanup failed: ${redact(msg)}\n`);
        ended();
      });
    });
    try {
      await session.mcpPlugin?.launched(child.pid);
    } catch (error) {
      await this.stopProcess(child);
      await session.cleanup;
      throw error;
    }
    return this.audit(session, 'launch', {
      cliPath: this.cliPath,
      args,
      effort: session.effort,
      pid: child.pid,
      cwd: session.cwd,
    });
  }

  unresolvedTools(session: AgySession): UnresolvedTool[] {
    return [...session.toolIds]
      .filter(([, status]) => status === 'pending')
      .map(([toolCallId]) => ({ toolCallId, ...session.toolDetails.get(toolCallId) }));
  }

  unknownToolMessage(reason: string, tools: readonly UnresolvedTool[]): string {
    return `${reason}: ${tools.map((tool) => `${tool.toolCallId} (${tool.name ?? 'unknown tool'}, ${tool.state ?? 'unknown state'})`).join(', ')}; execution state is unknown; do not replay these calls or reuse this session until their native state is reconciled`;
  }

  async settlePendingTools(session: AgySession, active: ActiveTurn, message: string): Promise<void> {
    for (const [toolCallId, status] of session.toolIds) {
      if (status !== 'pending') continue;
      session.toolIds.set(toolCallId, 'settled');
      await active.client.notify('session/update', {
        sessionId: session.id,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: message } }],
        },
      });
    }
  }

  async rejectUnconfirmedTurn(
    session: AgySession,
    active: ActiveTurn,
    error: AgyError,
    unresolved: readonly UnresolvedTool[],
    preserveMessage = false,
  ): Promise<void> {
    const message = unresolved.length
      ? this.unknownToolMessage(error.message, unresolved)
      : error.message;
    if (unresolved.length) {
      error.details = { ...error.details, unresolvedTools: unresolved };
      if (!preserveMessage) error.message = message;
      await this.settlePendingTools(session, active, message).catch(() => {});
    }
    session.failure = `${message}; create a fresh session`;
    active.reject(error);
  }

  async loseTurn(session: AgySession, error: AgyError): Promise<void> {
    const active = session.active;
    if (!active || session.cancelling) return;
    this.clearErrorResultWatchdog(active);
    session.active = undefined;
    const unresolved = this.unresolvedTools(session);
    if (unresolved.length) {
      await this.audit(session, 'tool_terminal_missing', {
        reason: 'stream_lost',
        tools: unresolved,
      }).catch((auditError: unknown) => {
        const msg = auditError instanceof Error ? auditError.message : String(auditError);
        error.details = { ...error.details, retirementAuditError: msg };
      });
    }
    await this.rejectUnconfirmedTurn(session, active, error, unresolved);
  }

  clearErrorResultWatchdog(active: ActiveTurn | undefined): void {
    if (!active?.errorWatchdog) return;
    clearTimeout(active.errorWatchdog);
    active.errorWatchdog = undefined;
  }

  armErrorResultWatchdog(session: AgySession, active: ActiveTurn): void {
    this.clearErrorResultWatchdog(active);
    if (
      typeof this.errorResultWatchdogMs !== 'number' ||
      this.errorResultWatchdogMs <= 0 ||
      !Number.isFinite(this.errorResultWatchdogMs)
    ) {
      return;
    }
    if (session.active !== active || session.cancelling || session.restarting) return;
    const child = session.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const token = Symbol('errorWatchdog');
    active.errorWatchdogToken = token;
    const timer = setTimeout(() => {
      if (active.errorWatchdog === timer) active.errorWatchdog = undefined;
      if (
        session.active !== active ||
        active.errorWatchdogToken !== token ||
        session.cancelling ||
        session.restarting ||
        session.child !== child
      ) {
        return;
      }
      void session.queueInternalAction?.(() =>
        this.onErrorResultWatchdog(session, active, child, token),
      );
    }, this.errorResultWatchdogMs);
    timer.unref?.();
    active.errorWatchdog = timer;
  }

  async onErrorResultWatchdog(
    session: AgySession,
    active: ActiveTurn,
    child: ChildProcess,
    token: symbol,
  ): Promise<void> {
    if (
      session.active !== active ||
      active.errorWatchdogToken !== token ||
      session.cancelling ||
      session.restarting ||
      session.child !== child
    ) {
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (active.lastStepType !== 'error_message' || active.lastStepState !== 'DONE') return;
    const conversationId = session.init?.conversation_id ?? session.conversationId;
    const dbState = await inspectNativeErrorWatchdogState({
      nativeHome: this.nativeHome,
      conversationId,
    });
    if (
      session.active !== active ||
      active.errorWatchdogToken !== token ||
      session.cancelling ||
      session.restarting ||
      session.child !== child
    ) {
      return;
    }
    if (dbState.status === 'retrying' && (active.consecutiveErrorSteps ?? 0) < 2) {
      this.armErrorResultWatchdog(session, active);
      return;
    }
    if (dbState.status === 'no_terminal_error') return;
    const unresolved = this.unresolvedTools(session);
    const errorText =
      dbState.status === 'terminal_error'
        ? (dbState.error ?? LEGACY_NETWORK_FAILURE)
        : active.lastErrorStepText || LEGACY_NETWORK_FAILURE;
    await this.audit(session, 'error_result_watchdog_triggered', {
      conversationId,
      stepIndex: active.lastStepIndex,
      consecutiveErrorSteps: active.consecutiveErrorSteps ?? 1,
      dbStatus: dbState.status,
      unresolvedCount: unresolved.length,
    });
    if (session.active !== active || session.cancelling) return;
    if (
      dbState.status === 'incomplete_steps' ||
      dbState.status === 'db_error' ||
      !active.promptConsumed ||
      unresolved.length > 0
    ) {
      session.broken = true;
      await session.permissionChannel?.close();
      await Promise.resolve(this.stopProcess(child)).catch(() => {});
      await session.exited;
      if (session.active !== active || session.cancelling) return;
      const error: AgyError = new Error(
        `AGY stalled after error_message step ${active.lastStepIndex ?? 'unknown'} without emitting a terminal result (${dbState.status})`,
      );
      error.code = 'AGY_ERROR_RESULT_TIMEOUT';
      error.details = { conversationId, stepIndex: active.lastStepIndex, dbStatus: dbState.status };
      await this.loseTurn(session, error);
      return;
    }
    await this.event(session, {
      event: 'result',
      result: {
        conversation_id: conversationId,
        status: 'ERROR',
        error: errorText,
      },
      _watchdogSynthesized: true,
      _watchdogConfirmedFlush:
        dbState.status === 'terminal_error' ||
        (dbState.status === 'missing_db' && NATIVE_ID.test(conversationId ?? '')),
    });
  }

  async event(session: AgySession, event: AgyNativeEvent): Promise<void> {
    if (!event || typeof event !== 'object') throw new Error('Invalid AGY event');
    if (event.event === 'init') {
      if (session.init) throw new Error('AGY sent duplicate init');
      const init = event.init;
      const sameWorkspace =
        typeof init?.cwd === 'string' &&
        (process.platform === 'win32'
          ? resolve(init.cwd).toLowerCase() === resolve(session.cwd).toLowerCase()
          : resolve(init.cwd) === resolve(session.cwd));
      if (!sameWorkspace) {
        throw new Error(
          'AGY init cwd does not match the frozen workspace binding; do not run tools in another project',
        );
      }
      if (session.model !== DEFAULT && init?.model !== session.model) {
        throw new Error('AGY init model does not match the explicit binding');
      }
      if (session.conversationId && event.conversation_id !== session.conversationId) {
        throw new Error('AGY init conversation does not match the exact native resume binding');
      }
      session.init = event;
      await this.audit(session, 'agy_init', {
        conversationId: event.conversation_id,
        model: init?.model,
        agent: init?.agent,
        cwd: init?.cwd,
        projectId: init?.project_id ?? event.project_id,
        permissionMode: init?.permission_mode,
        tools: init?.tools,
      });
      return;
    }
    const active = session.active;
    if (!active && session.broken) return;
    if (!active) throw new Error('AGY event arrived outside an active turn');
    if (event.event === 'step_update') {
      const step = event.step_update;
      if (!step || typeof step.step_type !== 'string') throw new Error('Malformed AGY step');
      if (step.step_type === 'user_input' && step.state === 'DONE') {
        active.promptConsumed = true;
        active.continuationWriter = undefined;
        active.lastStepType = 'user_input';
        active.lastStepState = step.state;
        active.lastStepIndex = step.step_index;
        active.consecutiveErrorSteps = 0;
        active.lastErrorStepText = undefined;
        active.finalResponseDone = false;
        active.finalResponseStepIndex = undefined;
        active.finalResponseText = '';
        if (Number.isSafeInteger(step.step_index)) {
          active.progressFloor = Math.max(active.progressFloor, step.step_index!);
        }
        await this.audit(session, 'prompt_consumed', { stepIndex: step.step_index });
      } else {
        active.lastStepType = step.step_type;
        active.lastStepState = step.state;
        active.lastStepIndex = step.step_index;
        if (step.step_type === 'error_message') {
          active.consecutiveErrorSteps = (active.consecutiveErrorSteps ?? 0) + 1;
          const stepError =
            typeof step.error === 'string' && step.error
              ? step.error
              : typeof step.error === 'object' &&
                  step.error !== null &&
                  typeof step.error.message === 'string' &&
                  step.error.message
                ? step.error.message
                : typeof step.text_delta === 'string' && step.text_delta
                  ? step.text_delta
                  : undefined;
          if (stepError !== undefined) active.lastErrorStepText = stepError;
        } else {
          active.consecutiveErrorSteps = 0;
          active.lastErrorStepText = undefined;
        }
        if (step.step_type !== 'agent_response') {
          active.finalResponseDone = false;
          active.finalResponseStepIndex = undefined;
          active.finalResponseText = '';
        }
      }
      active.usageSteps ??= new Set();
      active.usage ??= emptyUsage();
      if (accumulateStepUsage(active.usageSteps, active.usage, step)) {
        await this.audit(session, 'native_usage', {
          stepIndex: step.step_index,
          usage: { ...active.usage },
        });
      }
      const freshStep =
        Boolean(active.promptConsumed) &&
        Number.isSafeInteger(step.step_index) &&
        step.step_index! > active.progressFloor;
      if (step.step_type === 'agent_response') {
        if (active.finalResponseStepIndex !== step.step_index) {
          active.finalResponseStepIndex = step.step_index;
          active.finalResponseText = '';
          active.finalResponseDone = false;
        }
        if (typeof step.text_delta === 'string' && step.text_delta) {
          active.text += step.text_delta;
          active.finalResponseText += step.text_delta;
          await active.client.notify('session/update', {
            sessionId: session.id,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: step.text_delta },
            },
          });
        }
        active.finalResponseDone = step.state === 'DONE' && active.finalResponseText.length > 0;
        if (freshStep && active.finalResponseDone && active.finalResponseText.trim()) {
          active.progressSinceRecovery = true;
        }
      }
      if (step.step_type === 'tool' || step.step_type === 'subagent') {
        const id = `agy-${event.conversation_id ?? session.init?.conversation_id}-${step.step_index}`;
        const previousName = session.toolDetails.get(id)?.name;
        const detail = {
          name:
            step.tool_name ??
            step.tool_info?.name ??
            previousName ??
            (step.step_type === 'subagent' ? 'invoke_subagent' : undefined),
          state: step.state,
        };
        const parameters = step.tool_info?.parameters ?? step.parameters;
        const structured = subagentPayload(step);
        const rawInput =
          structured === undefined
            ? parameters
            : {
                ...(parameters !== null && typeof parameters === 'object' && !Array.isArray(parameters)
                  ? (parameters as Record<string, unknown>)
                  : {}),
                ...structured,
              };
        const previousInput = session.toolInputs.get(id);
        if (rawInput !== undefined) session.toolInputs.set(id, rawInput);
        session.toolDetails.set(id, detail);
        if (!session.toolIds.has(id)) {
          session.toolIds.set(id, 'pending');
          await active.client.notify('session/update', {
            sessionId: session.id,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: id,
              title: detail.name ?? 'AGY tool',
              name: detail.name,
              kind: 'other',
              status: 'in_progress',
              rawInput,
              ...(structured === undefined ? {} : { _meta: structured }),
            },
          });
        } else if (
          session.active === active &&
          step.state !== 'DONE' &&
          step.state !== 'ERROR' &&
          session.toolIds.get(id) === 'pending' &&
          (detail.name !== previousName ||
            (rawInput !== undefined && JSON.stringify(rawInput) !== JSON.stringify(previousInput)))
        ) {
          await active.client.notify('session/update', {
            sessionId: session.id,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: id,
              title: detail.name,
              name: detail.name,
              status: 'in_progress',
              rawInput: rawInput ?? previousInput,
              ...(structured === undefined ? {} : { _meta: structured }),
            },
          });
        }
        await this.audit(session, 'tool_state', { toolCallId: id, ...detail });
        if (
          session.active === active &&
          (step.state === 'DONE' || step.state === 'ERROR') &&
          session.toolIds.get(id) === 'pending'
        ) {
          const failed = step.state === 'ERROR' || Boolean(step.tool_info?.error);
          if (freshStep && !failed) active.progressSinceRecovery = true;
          const error = step.tool_info?.error ?? step.error;
          session.toolIds.set(id, 'settled');
          const errorText = typeof error === 'string' ? error : error?.message;
          const output =
            step.tool_info?.output ??
            step.tool_info?.result ??
            errorText ??
            (failed ? 'AGY tool reported an error' : undefined);
          const deniedCandidate =
            typeof errorText === 'string'
              ? errorText
              : typeof output === 'string'
                ? output
                : '';
          if (
            failed &&
            /^tool call denied by pre-tool hook:/i.test(deniedCandidate.trimStart())
          ) {
            (active.preToolDenied ??= new Set()).add(id);
            await this.audit(session, 'pre_tool_hook_denied', {
              toolCallId: id,
              error: errorText ?? output,
            });
          }
          const finalInput = rawInput ?? previousInput;
          await active.client.notify('session/update', {
            sessionId: session.id,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: id,
              title: detail.name,
              name: detail.name,
              status: failed ? 'failed' : 'completed',
              rawInput: finalInput,
              ...(structured === undefined ? {} : { _meta: structured }),
              rawOutput: output,
              content:
                typeof output === 'string'
                  ? [{ type: 'content', content: { type: 'text', text: output } }]
                  : undefined,
            },
          });
        }
      }
      if (step.step_type === 'error_message' && step.state === 'DONE') {
        this.armErrorResultWatchdog(session, active);
      }
      return;
    }
    this.clearErrorResultWatchdog(active);
    if (event.event !== 'result' || !event.result) {
      throw new Error(`Unsupported AGY event: ${event.event}`);
    }
    const result = event.result;
    await this.audit(session, 'agy_result', {
      conversationId: result.conversation_id,
      status: result.status,
      numTurns: result.num_turns,
      usage: result.usage,
      deniedActions: result.denied_actions,
      synthesizedByWatchdog: event._watchdogSynthesized === true ? true : undefined,
      responseSha256: createHash('sha256')
        .update(result.response ?? '')
        .digest('hex'),
    });
    const newDenials = takeNewDenials(result.denied_actions, session.denialCounts);
    if (session.active !== active || session.cancelling) return;
    if (result.status === 'SUCCESS' && session.mcpServers.length !== session.mcpReady.size) {
      throw new Error(
        'AGY did not activate and initialize the requested session MCP plugin; preserve native plugin/MCP off settings and review the connection instead of switching agents',
      );
    }
    const unresolved = this.unresolvedTools(session);
    const unresolvedMessage = unresolved.length
      ? this.unknownToolMessage('AGY terminal result arrived before a tool terminal update', unresolved)
      : undefined;
    if (unresolved.length) {
      session.broken = true;
      session.failure = unresolvedMessage;
      await this.audit(session, 'tool_terminal_missing', {
        conversationId: result.conversation_id,
        nativeStatus: result.status,
        tools: unresolved,
      });
    }
    let error: AgyError | undefined;
    let stopReason = 'end_turn';
    let stopAfterResult = false;
    let postResponseTerminalError: string | undefined;
    const nonRecoverableError =
      /\b(?:401|403|429|RESOURCE_EXHAUSTED|UNAUTHENTICATED|PERMISSION_DENIED)\b|quota[\s_-]*(?:reached|exceeded|exhausted)|rate[\s_-]*limit|insufficient[\s_-]*quota|unauthorized|authentication\s+failed/i;
    const lateTransportDisconnect =
      result.status === 'ERROR' &&
      typeof result.error === 'string' &&
      /\b(?:wsarecv|wsasend|connectex|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|EOF|UNAVAILABLE|DEADLINE_EXCEEDED|502|503|504)\b|socket\s+hang\s+up|dial\s+tcp|read\s+tcp|write\s+tcp|actively\s+refused|connection\s+refused|connection\s+attempt\s+failed|connection\s+was\s+forcibly\s+closed|broken\s+pipe|tls\s+handshake\s+timeout|context\s+deadline\s+exceeded|http2:\s+(?:client\s+connection\s+(?:lost|force\s+closed)|server\s+sent\s+GOAWAY)|stream\s+error:\s+stream\s+ID|bad\s+gateway|service\s+unavailable|gateway\s+timeout/i.test(
        result.error,
      ) &&
      !nonRecoverableError.test(result.error);
    const replayedSummaryError =
      result.status === 'ERROR' &&
      typeof result.error === 'string' &&
      (result.error === LEGACY_NETWORK_FAILURE ||
        /^The stream was interrupted\. Please continue the task you were working on\.$/i.test(
          result.error,
        )) &&
      !nonRecoverableError.test(result.error);
    const confirmedFinalResponse = Boolean(
      (lateTransportDisconnect || replayedSummaryError) &&
        active.promptConsumed &&
        !unresolved.length &&
        active.steering.length === 0 &&
        !active.steerDeliveryUnknown &&
        active.lastStepType === 'agent_response' &&
        active.lastStepState === 'DONE' &&
        active.finalResponseDone &&
        active.text.length > active.segmentStart &&
        (lateTransportDisconnect
          ? typeof result.response !== 'string' ||
            result.response.length === 0 ||
            result.response === active.text.slice(active.segmentStart)
          : typeof result.response === 'string' &&
            result.response.length > 0 &&
            result.response === active.text.slice(active.segmentStart)),
    );
    const recoverableNetworkError =
      (lateTransportDisconnect || replayedSummaryError) &&
      !confirmedFinalResponse &&
      Boolean(active.promptConsumed) &&
      unresolved.length === 0 &&
      active.steering.length === 0 &&
      !active.steerDeliveryUnknown &&
      !active.denied &&
      newDenials.length === 0 &&
      !active.preToolDenied?.size;
    if (recoverableNetworkError && active.progressSinceRecovery) {
      active.networkRecoveries = 0;
      active.progressSinceRecovery = false;
    }
    const continuationAllowed =
      recoverableNetworkError && active.networkRecoveries < this.maxConsecutiveNetworkRecoveries;
    if (continuationAllowed) {
      const attempt = active.networkRecoveries + 1;
      const preservedTools = session.toolIds.size;
      await this.audit(session, 'network_recovery_requested', {
        conversationId: result.conversation_id,
        nativeStatus: result.status,
        error: result.error,
        attempt,
        totalAttempts: active.networkRecoveriesTotal + 1,
        preservedTools,
        preservedTextLength: active.text.length,
        liveChild: Boolean(
          session.child && session.child.exitCode === null && session.child.signalCode === null,
        ),
      });
      if (session.active !== active || session.cancelling) return;
      active.networkRecoveries = attempt;
      active.networkRecoveriesTotal += 1;
      try {
        const sent = await this.continueNetworkFailure(session, active, attempt, result, {
          allowForcedExit: event._watchdogConfirmedFlush === true,
        });
        if (sent?.outcome === 'sent') {
          await this.audit(session, 'network_recovery_sent', {
            conversationId: sent.conversationId,
            attempt,
            relaunched: sent.relaunched,
            bytes: sent.bytes,
            frameSha256: sent.frameSha256,
          });
          return;
        }
        active.networkRecoveries -= 1;
        active.networkRecoveriesTotal -= 1;
        if (sent?.outcome === 'unknown') {
          const message =
            `AGY terminal status ${result.status}: ${result.error ?? 'no success result'};` +
            ` delivery of automatic continuation ${attempt} is unconfirmed` +
            '; it is not re-sent and no new conversation is opened; inspect the native outcome before continuing';
          await this.audit(session, 'network_recovery_failed', {
            conversationId: result.conversation_id,
            attempt,
            delivery: 'unknown',
          });
          error = new Error(message);
          error.details = {
            nativeError: result.error,
            attempt,
            recoveries: active.networkRecoveriesTotal,
            preservedTools,
            conversationId: result.conversation_id,
            delivery: 'unknown',
          };
          session.broken = true;
          session.failure = message;
          stopAfterResult = true;
        } else if (sent?.outcome === 'exit_unconfirmed') {
          const message =
            `AGY terminal status ${result.status}: ${result.error ?? 'no success result'};` +
            ` headless CLI did not exit cleanly after the terminal error (${sent.reason}` +
            `; exitCode: ${sent.exitCode ?? 'none'}, signal: ${sent.signal ?? 'none'})` +
            '; native state flush is unconfirmed, so automatic continuation was not sent; inspect the native outcome before continuing';
          await this.audit(session, 'network_recovery_failed', {
            conversationId: result.conversation_id,
            attempt,
            delivery: 'not_sent',
            reason: sent.reason,
            exitCode: sent.exitCode ?? null,
            signal: sent.signal ?? null,
          });
          error = new Error(message);
          error.details = {
            nativeError: result.error,
            attempt,
            recoveries: active.networkRecoveriesTotal,
            preservedTools,
            conversationId: result.conversation_id,
            delivery: 'not_sent',
            reason: sent.reason,
            exitCode: sent.exitCode ?? null,
            signal: sent.signal ?? null,
          };
          session.broken = true;
          session.failure = message;
          stopAfterResult = true;
        } else {
          await this.audit(session, 'network_recovery_skipped', {
            conversationId: result.conversation_id,
            attempt,
            reason: 'conversation_evidence_incomplete',
          });
        }
      } catch (continueError) {
        active.networkRecoveries -= 1;
        active.networkRecoveriesTotal -= 1;
        const continueMsg =
          continueError instanceof Error ? continueError.message : String(continueError);
        const message =
          `AGY terminal status ${result.status}: ${result.error ?? 'no success result'};` +
          ` automatic continuation ${attempt} could not be delivered: ${continueMsg}` +
          '; delivery of the continuation is unknown and it is not retried; inspect the native outcome before continuing';
        await this.audit(session, 'network_recovery_failed', {
          conversationId: result.conversation_id,
          attempt,
          delivery: 'unknown',
          error: continueMsg,
        });
        error = new Error(message);
        error.details = {
          nativeError: result.error,
          attempt,
          recoveries: active.networkRecoveriesTotal,
          preservedTools,
          conversationId: result.conversation_id,
          delivery: 'unknown',
        };
        session.broken = true;
        session.failure = message;
        stopAfterResult = true;
      }
    }
    if (recoverableNetworkError && !continuationAllowed) {
      const preservedTools = session.toolIds.size;
      const consecutiveRecoveries = active.networkRecoveries;
      const message =
        `AGY terminal status ${result.status}: ${result.error ?? 'no success result'}; automatic continuation stopped after` +
        ` ${consecutiveRecoveries} consecutive attempts without progress;` +
        ` every completed tool result (${preservedTools}) and native conversation ${result.conversation_id ?? '(unknown)'} are retained;` +
        ' load that exact native conversation to continue it, instead of replaying the prompt or the finished tool calls';
      await this.audit(session, 'network_recovery_exhausted', {
        conversationId: result.conversation_id,
        error: result.error,
        recoveries: active.networkRecoveriesTotal,
        consecutiveRecoveries,
        preservedTools,
      });
      error = new Error(message);
      error.details = {
        nativeError: result.error,
        recoveries: active.networkRecoveriesTotal,
        consecutiveRecoveries,
        preservedTools,
        conversationId: result.conversation_id,
      };
      session.broken = true;
      session.failure = message;
      stopAfterResult = true;
    }
    if (active.denied || newDenials.length > 0 || active.preToolDenied?.size) {
      active.denied = false;
      const actions = [
        ...new Set(
          newDenials.map((action) =>
            typeof action?.action === 'string' ? action.action : 'unknown',
          ),
        ),
      ];
      const message = `AGY permission denied${actions.length ? ` for ${actions.join(', ')}` : ''}; ${
        active.preToolDenied?.size
          ? 'a PreToolUse hook rejected a tool before execution; retain the denial; terminal SUCCESS is not evidence that the requested work ran'
          : 'the native AGY permission policy did not approve the action'
      }${unresolvedMessage ? `; ${unresolvedMessage}` : ''}`;
      await this.settlePendingTools(session, active, message);
      process.stderr.write(`${message}\n`);
      error = new Error(message);
      error.code = 'AGY_PERMISSION_DENIED';
      error.details = {
        deniedToolCallIds: [...(active.preToolDenied ?? [])],
        unresolvedTools: unresolved,
      };
    } else if (
      result.status === 'CANCELED' ||
      result.status === 'INTERRUPTED' ||
      (result.status === 'ERROR' && result.error === 'interrupted')
    ) {
      const message =
        unresolvedMessage ??
        `AGY turn ${result.status.toLowerCase()}; do not replay interrupted prompts or commands`;
      session.broken = true;
      session.failure = message;
      await this.settlePendingTools(session, active, message);
      stopReason = 'cancelled';
      stopAfterResult = true;
    } else if (result.status !== 'SUCCESS' && confirmedFinalResponse) {
      postResponseTerminalError = `AGY terminal status ${result.status}: ${result.error ?? 'no success result'}`;
      session.broken = true;
      session.failure = postResponseTerminalError;
      stopAfterResult = true;
    } else if (result.status !== 'SUCCESS' && error === undefined) {
      const message = `AGY terminal status ${result.status}: ${result.error ?? 'no success result'}`;
      await this.settlePendingTools(session, active, unresolvedMessage ?? message);
      error = new Error(unresolvedMessage ? `${message}; ${unresolvedMessage}` : message);
      session.broken = true;
      session.failure = error.message;
      stopAfterResult = true;
    } else if (unresolvedMessage) {
      await this.settlePendingTools(session, active, unresolvedMessage);
      error = new Error(unresolvedMessage);
      error.code = 'AGY_TOOL_TERMINAL_MISSING';
      error.details = { conversationId: result.conversation_id, unresolvedTools: unresolved };
    } else if (error === undefined && active.text.length === active.segmentStart && result.response) {
      await active.client.notify('session/update', {
        sessionId: session.id,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: result.response },
        },
      });
    }
    if (session.active !== active || session.cancelling) return;
    if (postResponseTerminalError !== undefined) {
      await this.audit(session, 'post_response_terminal_error', {
        conversationId: result.conversation_id,
        status: result.status,
        error: result.error,
        stepIndex: active.finalResponseStepIndex,
        responseSha256: createHash('sha256').update(active.text).digest('hex'),
      });
    }
    if (stopReason === 'cancelled') {
      await this.audit(session, 'cancel', {
        pid: session.child?.pid,
        processEnded: false,
        resumeSupported: false,
        unresolvedTools: unresolved,
      });
    } else if (
      !unresolved.length &&
      error?.details?.['delivery'] !== 'unknown' &&
      error?.details?.['delivery'] !== 'not_sent'
    ) {
      await this.audit(session, 'native_turn_reconciled', {
        status: result.status,
        preservedCompletedResponse: postResponseTerminalError !== undefined ? true : undefined,
      });
    }
    if (session.active !== active || session.cancelling) return;
    session.active = undefined;
    if (stopAfterResult) {
      await session.permissionChannel?.close();
      await Promise.resolve(this.stopProcess(session.child)).catch(() => {});
      await session.exited;
      await this.closeSteeringHook(session).catch(() => {});
      await session.mcpPlugin?.close();
      if (!session.restarting) await session.releaseResume?.();
    }
    if (error) active.reject(error);
    else active.resolve({ stopReason, ...(active.usageSteps?.size ? { usage: { ...active.usage } } : {}) });
  }

  async prompt(
    params: { sessionId: string; prompt: unknown },
    client: AcpClientProxy,
  ): Promise<{ stopReason: string; usage?: UsageTotals }> {
    const session = this.session(params.sessionId);
    if (session.broken) {
      throw new Error(
        session.failure ?? 'AGY process ended; create a fresh session (no implicit resume/history handoff)',
      );
    }
    if (session.active) throw new Error('AGY session already has an active turn');
    const content = promptText(params.prompt);
    const promise = new Promise<{ stopReason: string; usage?: UsageTotals }>(
      (resolveTurn, rejectTurn) => {
        const active: ActiveTurn = {
          client,
          text: '',
          steering: [],
          networkRecoveries: 0,
          networkRecoveriesTotal: 0,
          segmentStart: 0,
          progressSinceRecovery: false,
          progressFloor: -1,
          recoveryAbort: new AbortController(),
          usageSteps: new Set(),
          usage: emptyUsage(),
          denied: false,
          finalResponseText: '',
          resolve: (value) => {
            this.clearErrorResultWatchdog(active);
            this.releaseSteering(session, active);
            void this.closeSteeringHook(session)
              .catch(() => {})
              .then(() => resolveTurn(value));
          },
          reject: (error) => {
            this.clearErrorResultWatchdog(active);
            this.releaseSteering(session, active);
            void this.closeSteeringHook(session)
              .catch(() => {})
              .then(() => rejectTurn(error));
          },
        };
        session.active = active;
      },
    );
    promise.catch(() => {});
    try {
      session.preparing = (async () => {
        await this.recoverDeadOwnedResources(session);
        await this.syncPermissionHook(session);
        await this.registerSteeringHook(session);
        if (!session.broken && !session.child) await this.start(session);
      })();
      try {
        await session.preparing;
      } finally {
        session.preparing = undefined;
      }
      if (session.broken) return await promise;
      await this.audit(session, 'native_turn_pending');
      if (session.broken) return await promise;
      const frame = JSON.stringify({ event: 'user', message: { content } }) + '\n';
      try {
        await writeNdjsonFrame(session.child!.stdin!, frame);
      } catch (error) {
        if (session.broken) return await promise;
        throw error;
      }
      await this.audit(session, 'prompt_sent', {
        bytes: Buffer.byteLength(frame),
        promptSha256: createHash('sha256').update(content).digest('hex'),
        frameSha256: createHash('sha256').update(frame).digest('hex'),
        delivery: 'unchanged_user_text',
      });
      return await promise;
    } catch (error) {
      if (session.active) {
        this.clearErrorResultWatchdog(session.active);
        this.releaseSteering(session, session.active);
        session.active = undefined;
      }
      await this.closeSteeringHook(session).catch(() => {});
      throw error;
    }
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    const session = this.session(params.sessionId);
    if (session.cancelling) return session.cancelling;
    session.cancelling = this.cancelOwnedSession(session);
    try {
      await session.cancelling;
    } finally {
      session.cancelling = undefined;
    }
  }

  /**
   * Continues the same native conversation after a recoverable network terminal error, using
   * only evidence the adapter already confirmed: the finished terminal result, the native UUID
   * conversation ID it named, settled tool states, and a natural process exit.
   *
   * After emitting a terminal `result: ERROR` frame, headless AGY ends its invocation loop and
   * exits once its native SQLite and transcript flush completes. Close its stdin, wait for that
   * natural exit, relaunch the CLI with the recorded `--conversation`, and send only the
   * continuation frame. If the process must be force-stopped on timeout or exits via a signal,
   * native persistence is unconfirmed and the continuation is not sent.
   */
  async continueNetworkFailure(
    session: AgySession,
    active: ActiveTurn,
    attempt: number,
    result: AgyResultPayload | undefined,
    { allowForcedExit = false }: { allowForcedExit?: boolean } = {},
  ): Promise<
    | { outcome: 'sent'; conversationId: string; relaunched: boolean; bytes: number; frameSha256: string }
    | { outcome: 'unknown'; conversationId: string }
    | {
        outcome: 'exit_unconfirmed';
        conversationId: string;
        reason: string;
        exitCode: number | null;
        signal: NodeJS.Signals | null;
      }
    | undefined
  > {
    if (session.active !== active || session.cancelling || active.denied) return undefined;
    const conversationId =
      typeof result?.conversation_id === 'string' && result.conversation_id
        ? result.conversation_id
        : undefined;
    if (!conversationId || !NATIVE_ID.test(conversationId)) return undefined;
    if (session.init?.conversation_id !== undefined && session.init.conversation_id !== conversationId) {
      return undefined;
    }
    if (session.conversationId !== undefined && session.conversationId !== conversationId) {
      return undefined;
    }
    const owned = session.child;
    if (!owned) return undefined;
    const frame =
      JSON.stringify({
        event: 'user',
        message: { content: `${NETWORK_RECOVERY_INSTRUCTION} (automatic continuation ${attempt}).` },
      }) + '\n';
    session.restarting = true;
    let exitUnconfirmed:
      | {
          outcome: 'exit_unconfirmed';
          conversationId: string;
          reason: string;
          exitCode: number | null;
          signal: NodeJS.Signals | null;
        }
      | undefined;
    try {
      const prepare = async (): Promise<void> => {
        let forceStopped = false;
        if (owned.exitCode === null && owned.signalCode === null) {
          owned.stdin?.end();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stopFallback = new Promise<void>((_, reject) => {
            timer = setTimeout(() => {
              forceStopped = true;
              void Promise.resolve(this.stopProcess(owned)).catch(reject);
            }, this.continuationExitGraceMs);
          });
          try {
            await Promise.race([session.exited, stopFallback]);
          } finally {
            clearTimeout(timer);
          }
        }
        await session.exited;
        if (session.active !== active || session.cancelling) return;
        const exitCode = owned.exitCode ?? null;
        const signal = owned.signalCode ?? null;
        await session.permissionChannel?.close();
        await this.closeSteeringHook(session);
        await session.mcpPlugin?.close();
        session.child = undefined;
        session.init = undefined;
        session.exited = undefined;
        session.cleanup = undefined;
        session.permissionChannel = undefined;
        session.mcpPlugin = undefined;
        session.mcpBound.clear();
        session.mcpReady.clear();
        if (
          !allowForcedExit &&
          (forceStopped || signal !== null || !Number.isSafeInteger(exitCode) || exitCode! < 0)
        ) {
          exitUnconfirmed = {
            outcome: 'exit_unconfirmed',
            conversationId,
            reason: forceStopped
              ? 'exit_timeout_stopped'
              : signal !== null
                ? 'signal_exit'
                : 'missing_exit_code',
            exitCode,
            signal,
          };
          return;
        }
        await this.audit(session, 'close', {
          pid: owned.pid,
          processEnded: true,
          exitCode,
          signal,
          forcedAfterWatchdog: allowForcedExit && forceStopped ? true : undefined,
        });
        const backoff =
          this.networkRecoveryBackoffMs[
            Math.min(attempt - 1, this.networkRecoveryBackoffMs.length - 1)
          ] ?? 0;
        const { signal: recoverySignal } = active.recoveryAbort;
        if (backoff > 0) {
          try {
            await delay(backoff, undefined, { signal: recoverySignal });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ABORT_ERR') throw error;
          }
        }
        if (session.active !== active || session.cancelling || recoverySignal.aborted) return;
        session.conversationId = conversationId;
        session.broken = false;
        await this.syncPermissionHook(session);
        await this.registerSteeringHook(session);
        if (session.active !== active || session.cancelling) return;
        await this.start(session);
      };
      session.preparing = prepare();
      try {
        await session.preparing;
      } finally {
        session.preparing = undefined;
      }
    } finally {
      session.restarting = false;
    }
    if (exitUnconfirmed) return exitUnconfirmed;
    if (session.active !== active || session.broken || session.cancelling) return undefined;
    const relaunched = await this.#writeContinuation(session, active, frame);
    if (relaunched === 'not-written') return undefined;
    if (relaunched === 'unknown') return { outcome: 'unknown', conversationId };
    return {
      outcome: 'sent',
      conversationId,
      relaunched: true,
      bytes: Buffer.byteLength(frame),
      frameSha256: createHash('sha256').update(frame).digest('hex'),
    };
  }

  async #writeContinuation(
    session: AgySession,
    active: ActiveTurn,
    frame: string,
  ): Promise<'not-written' | 'written' | 'unknown'> {
    const child = session.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return 'not-written';
    active.continuationWriter = child;
    active.promptConsumed = false;
    active.consecutiveErrorSteps = 0;
    active.lastErrorStepText = undefined;
    active.segmentStart = active.text.length;
    active.finalResponseDone = false;
    active.finalResponseStepIndex = undefined;
    active.finalResponseText = '';
    active.progressSinceRecovery = false;
    try {
      await writeNdjsonFrame(child.stdin!, frame);
      return 'written';
    } catch {
      return 'unknown';
    }
  }

  async cancelOwnedSession(session: AgySession): Promise<void> {
    const active = session.active;
    this.clearErrorResultWatchdog(active);
    active?.recoveryAbort.abort();
    session.broken = true;
    let requestAuditError: unknown;
    try {
      try {
        await this.audit(session, 'cancel_requested', {
          pid: session.child?.pid,
          resumeSupported: false,
        });
      } catch (error) {
        requestAuditError = error;
      }
      await session.preparing?.catch(() => {});
      await session.permissionChannel?.close();
      await this.stopProcess(session.child);
      await session.exited;
      await session.cleanup;
      await this.closeSteeringHook(session).catch(() => {});
      await session.mcpPlugin?.close();
      if (requestAuditError !== undefined) throw asAgyError(requestAuditError);
      const unresolved = this.unresolvedTools(session);
      if (active && unresolved.length) {
        await this.settlePendingTools(
          session,
          active,
          this.unknownToolMessage('AGY turn cancelled before a tool terminal update', unresolved),
        );
      }
      await this.audit(session, 'cancel', {
        pid: session.child?.pid,
        processEnded: true,
        resumeSupported: false,
        unresolvedTools: unresolved,
      });
      active?.resolve({ stopReason: 'cancelled' });
    } catch (error) {
      await session.drainReceived?.();
      session.active = undefined;
      const unresolved = this.unresolvedTools(session);
      const exitCode = session.child?.exitCode ?? null;
      const signal = session.child?.signalCode ?? null;
      const outcome = { processEnded: exitCode !== null || signal !== null, exitCode, signal };
      const failure = asAgyError(requestAuditError ?? error);
      const errObj = asAgyError(error);
      const cancelError =
        failure === error ? undefined : { code: errObj.code, message: errObj.message };
      failure.details = { ...failure.details, ...outcome, cancelError };
      await this.audit(session, 'cancel_failed', {
        pid: session.child?.pid,
        ...outcome,
        unresolvedTools: unresolved,
        cancelError,
      }).catch((auditError: unknown) => {
        const msg = auditError instanceof Error ? auditError.message : String(auditError);
        failure.details = { ...failure.details, retirementAuditError: msg };
      });
      if (active) {
        await this.rejectUnconfirmedTurn(
          session,
          active,
          failure,
          unresolved,
          failure === requestAuditError,
        );
      }
      throw failure;
    } finally {
      session.active = undefined;
    }
  }

  close(): Promise<void[]> {
    this.closePromise ??= Promise.all(
      [...this.sessions.values()].map(async (session) => {
        if (session.cancelling) await session.cancelling.catch(() => {});
        const active = session.active;
        this.clearErrorResultWatchdog(active);
        session.active = undefined;
        session.broken = true;
        try {
          const unresolved = this.unresolvedTools(session);
          if (active && unresolved.length) {
            await this.audit(session, 'tool_terminal_missing', {
              reason: 'connection_closed',
              tools: unresolved,
            });
            await this.settlePendingTools(
              session,
              active,
              this.unknownToolMessage(
                'ACP connection closed before a tool terminal update',
                unresolved,
              ),
            );
          }
        } finally {
          active?.reject(new Error('ACP connection closed'));
          await session.preparing?.catch(() => {});
          await session.permissionChannel?.close();
          if (session.child && session.child.exitCode === null && session.child.signalCode === null) {
            session.child.stdin?.end();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const stopFailure = new Promise<void>((_, reject) => {
              timer = setTimeout(() => {
                void Promise.resolve(this.stopProcess(session.child)).catch(reject);
              }, 3000);
            });
            try {
              await Promise.race([session.exited, stopFailure]);
            } finally {
              clearTimeout(timer);
            }
          }
          await session.cleanup;
          await this.closeSteeringHook(session).catch(() => {});
          await session.mcpPlugin?.close();
          await session.releaseResume?.();
          await this.audit(session, 'close', { pid: session.child?.pid, processEnded: true });
        }
      }),
    );
    return this.closePromise;
  }
}
