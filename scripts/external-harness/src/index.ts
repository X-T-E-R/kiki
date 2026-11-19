import { isAbsolute, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recoverProjectHook } from '../agy-hook-registration.mjs';
import { recoverProjectMcpPlugin } from '../agy-mcp-plugin.mjs';
import { AgyBridge } from './bridge';
import {
  accumulateStepUsage,
  catalogDiagnostic,
  configOptions,
  consumeAccountEnvironment,
  encodedEffort,
  launchArgs,
  promptText,
  readVendorModelCatalog,
  takeNewDenials,
  validateEffort,
  vendorModelIds,
} from './catalog';
import { readLegacyNativeRecovery } from './legacyRecovery';
import { createNdjsonLineTransform, NdjsonFrameDecoder, readNdjsonLines, writeNdjsonFrame } from './ndjson';
import { encodeNativeMessage, nativeBytesAt, nativeStringsAt } from './protobuf';
import { runSessionMcp } from './sessionMcp';
import { DEFAULT, type AgyAccountConfig, type AgyError } from './types';

export {
  accumulateStepUsage,
  AgyBridge,
  catalogDiagnostic,
  configOptions,
  consumeAccountEnvironment,
  createNdjsonLineTransform,
  encodeNativeMessage,
  encodedEffort,
  launchArgs,
  nativeBytesAt,
  nativeStringsAt,
  NdjsonFrameDecoder,
  promptText,
  readLegacyNativeRecovery,
  readNdjsonLines,
  readVendorModelCatalog,
  runSessionMcp,
  takeNewDenials,
  validateEffort,
  vendorModelIds,
  writeNdjsonFrame,
};

export interface RunBridgeOptions {
  sdkPath?: string;
  cliPath?: string;
  cliPrefix?: string[];
  auditDir?: string;
  model?: string;
  account?: AgyAccountConfig;
}

interface AcpRequestContext {
  params: Record<string, unknown>;
  client: { notify(method: string, params: Record<string, unknown>): Promise<void> };
}

interface AcpAgentBuilder {
  onRequest(method: string, handler: (ctx: AcpRequestContext) => unknown): AcpAgentBuilder;
  onRequest(
    method: string,
    parse: (params: unknown) => unknown,
    handler: (ctx: AcpRequestContext) => unknown,
  ): AcpAgentBuilder;
  onNotification(method: string, handler: (ctx: AcpRequestContext) => unknown): AcpAgentBuilder;
  connect(stream: unknown): { closed: Promise<void> };
}

interface AcpSdkModule {
  PROTOCOL_VERSION: unknown;
  RequestError: new (code: number, message: string, data?: unknown) => Error;
  agent(info: { name: string; version: string }): AcpAgentBuilder;
  ndJsonStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>): unknown;
}

export async function runBridge({
  sdkPath,
  cliPath,
  cliPrefix = [],
  auditDir,
  model = DEFAULT,
  account,
}: RunBridgeOptions = {}): Promise<void> {
  if (!isAbsolute(sdkPath ?? '')) throw new Error('Pass an installed ACP SDK absolute path');
  const acp = (await import(pathToFileURL(sdkPath!).href)) as AcpSdkModule;
  const bridge = new AgyBridge({
    cliPath,
    cliPrefix,
    auditDir,
    model,
    account,
    onAccountExit: () => setImmediate(shutdown),
  });
  await bridge.loadVendorModels();
  const sessionRequest =
    (handler: (ctx: AcpRequestContext) => Promise<unknown>) => async (ctx: AcpRequestContext) => {
      try {
        return await handler(ctx);
      } catch (error) {
        if (account) setImmediate(shutdown);
        const agyErr = error as AgyError | undefined;
        throw new acp.RequestError(
          -32603,
          error instanceof Error ? error.message : String(error),
          { adapterCode: agyErr?.code, details: agyErr?.details },
        );
      }
    };
  const connection = acp
    .agent({ name: 'agy-cli-acp', version: '0.2.0' })
    .onRequest('initialize', () => bridge.initialize(acp.PROTOCOL_VERSION))
    .onRequest('session/new', sessionRequest((ctx) => bridge.newSession(ctx.params as never)))
    .onRequest('session/load', sessionRequest((ctx) => bridge.loadSession(ctx.params as never)))
    .onRequest('session/set_config_option', (ctx) => bridge.setConfig(ctx.params as never))
    .onRequest(
      'session/prompt',
      sessionRequest((ctx) => bridge.prompt(ctx.params as never, ctx.client)),
    )
    .onRequest(
      '_session/steering',
      (params) => params,
      sessionRequest((ctx) => bridge.steer(ctx.params as never)),
    )
    .onNotification('session/cancel', (ctx) => bridge.cancel(ctx.params as never))
    .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void bridge.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.stdin.once('end', shutdown);
  try {
    await connection.closed;
  } finally {
    await bridge.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (
    process.argv.includes('--version') ||
    (process.argv.length === 3 && process.argv[2] === '--kiki-harness-account-version')
  ) {
    console.log('agy-cli-acp 0.2.0');
  } else {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === '--mcp-stdio') {
      runSessionMcp(args[1]!).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
    } else if (args.length === 3 && args[0] === '--recover-project-mcp') {
      if (!isAbsolute(args[1]!)) throw new Error('AGY MCP recovery workspace must be absolute');
      recoverProjectMcpPlugin({ cwd: args[1]!, sessionId: args[2]! })
        .then((result) => console.log(JSON.stringify(result)))
        .catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        });
    } else if (args.length === 2 && args[0] === '--recover-project-hook') {
      if (!isAbsolute(args[1]!)) throw new Error('AGY hook recovery workspace must be absolute');
      recoverProjectHook({
        cwd: args[1]!,
        nodePath: process.execPath,
        handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)),
      })
        .then((result) => console.log(JSON.stringify(result)))
        .catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        });
    } else {
      const accountBound = args.at(-1) === '--kiki-harness-account';
      if (accountBound) args.pop();
      if (args.length && (args.length !== 2 || args[0] !== '--model')) {
        throw new Error('Only --model <AGY model ID> or --recover-project-hook <workspace> is supported');
      }
      const account = accountBound ? consumeAccountEnvironment() : undefined;
      runBridge({
        sdkPath: process.env['AGY_ACP_SDK_PATH'],
        cliPath: process.env['AGY_CLI_PATH'],
        auditDir: process.env['AGY_BRIDGE_AUDIT_DIR'],
        model: args[1] ?? DEFAULT,
        account,
      }).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
    }
  }
}
