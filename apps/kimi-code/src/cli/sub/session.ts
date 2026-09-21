import type { Command } from 'commander';

import { resolveKikiHome } from '#/kiki/home';
import {
  followOfflineSession,
  inspectOfflineSession,
  listOfflineSessions,
  SessionInspectionError,
  type FollowSessionOptions,
  type InspectSessionOptions,
  type SessionInspection,
  type SessionLocationSummary,
} from '#/kiki/session-inspect';
import {
  renderSessionFollowUpdate,
  renderSessionInspection,
  renderSessionList,
  sanitizeTerminalText,
} from '#/kiki/session-inspect-render';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface SessionCommandDeps {
  readonly homeDir: () => string;
  readonly inspectSession: (options: InspectSessionOptions) => Promise<SessionInspection>;
  readonly followSession: (options: FollowSessionOptions) => AsyncIterable<SessionInspection>;
  readonly listSessions: (homeDir: string) => Promise<readonly SessionLocationSummary[]>;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => void;
}

export interface SessionShowOptions {
  readonly json: boolean;
  readonly agent?: string;
  readonly workspace?: string;
  readonly follow?: boolean;
  readonly signal?: AbortSignal;
}

export interface SessionListOptions {
  readonly json: boolean;
}

export async function handleSessionShow(
  deps: SessionCommandDeps,
  reference: string,
  options: SessionShowOptions,
): Promise<void> {
  try {
    const input: InspectSessionOptions = {
      homeDir: deps.homeDir(),
      reference,
      agent: options.agent,
      workspace: options.workspace,
    };
    if (options.follow !== true) {
      const inspection = await deps.inspectSession(input);
      deps.stdout.write(
        options.json
          ? `${JSON.stringify(inspection, null, 2)}\n`
          : renderSessionInspection(inspection),
      );
      return;
    }

    let previous: SessionInspection | undefined;
    for await (const inspection of deps.followSession({ ...input, signal: options.signal })) {
      if (previous === undefined) {
        if (!options.json) {
          deps.stdout.write(
            'Following persisted session files only; no live session state will be opened or modified. Press Ctrl+C to stop.\n\n',
          );
        }
        deps.stdout.write(
          options.json
            ? `${JSON.stringify(inspection)}\n`
            : renderSessionInspection(inspection),
        );
      } else {
        deps.stdout.write(
          options.json
            ? `${JSON.stringify(inspection)}\n`
            : renderSessionFollowUpdate(previous, inspection),
        );
      }
      previous = inspection;
    }
  } catch (error) {
    writeError(deps, error, options.json);
  }
}

export async function handleSessionList(
  deps: SessionCommandDeps,
  options: SessionListOptions,
): Promise<void> {
  try {
    const homeDir = deps.homeDir();
    const sessions = await deps.listSessions(homeDir);
    deps.stdout.write(
      options.json
        ? `${JSON.stringify({ schemaVersion: 1, sessions }, null, 2)}\n`
        : renderSessionList(sessions, homeDir),
    );
  } catch (error) {
    writeError(deps, error, options.json);
  }
}

export function registerSessionCommand(parent: Command, overrides: Partial<SessionCommandDeps> = {}): void {
  const deps = createDefaultDeps(overrides);
  const session = parent
    .command('session')
    .description('Inspect local sessions without resuming them.');

  session
    .command('show')
    .description('Show a persisted session timeline and agent tree.')
    .argument('<session>', 'Session link, session_<uuid>, or bare UUID.')
    .option('--json', 'Print stable machine-readable JSON. With --follow, emit one snapshot per NDJSON line.')
    .option('--agent <id|name>', 'Show only one agent timeline, status, and last activity.')
    .option('--follow', 'Follow on-disk changes observationally without attaching to or modifying the session.')
    .option('--workspace <workspace-id>', 'Select one copy when the session exists in multiple workspaces.')
    .action(
      async (
        reference: string,
        options: { json?: boolean; agent?: string; follow?: boolean; workspace?: string },
      ) => {
        const rawArgs = commandRawArgs(parent);
        const trailingAgent = trailingOptionValue(rawArgs, 'show', '--agent');
        if (optionBeforeCommand(rawArgs, 'show', '--agent')) {
          writeError(
            deps,
            new SessionInspectionError(
              'invalid_option',
              'For session inspection, place --agent after `session show <session>`.',
            ),
            options.json === true,
          );
          return;
        }
        const controller = options.follow === true ? new AbortController() : undefined;
        const onSigint = (): void => controller?.abort();
        if (controller !== undefined) process.once('SIGINT', onSigint);
        try {
          await handleSessionShow(deps, reference, {
            json: options.json === true,
            agent: trailingAgent,
            workspace: options.workspace,
            follow: options.follow === true,
            signal: controller?.signal,
          });
        } finally {
          if (controller !== undefined) process.off('SIGINT', onSigint);
        }
      },
    );

  session
    .command('list')
    .alias('ls')
    .description('List persisted sessions across all local workspaces.')
    .option('--json', 'Print stable machine-readable JSON.')
    .action(async (options: { json?: boolean }) => {
      await handleSessionList(deps, { json: options.json === true });
    });
}

function commandRawArgs(command: Command): readonly string[] {
  return (command as Command & { readonly rawArgs?: readonly string[] }).rawArgs ?? process.argv;
}

function optionBeforeCommand(args: readonly string[], command: string, option: string): boolean {
  const commandIndex = args.indexOf(command);
  if (commandIndex < 0) return false;
  return args.slice(0, commandIndex).some((value) => value === option || value.startsWith(`${option}=`));
}

function trailingOptionValue(
  args: readonly string[],
  command: string,
  option: string,
): string | undefined {
  const commandIndex = args.indexOf(command);
  if (commandIndex < 0) return undefined;
  const commandArgs = args.slice(commandIndex + 1);
  for (let index = 0; index < commandArgs.length; index += 1) {
    const value = commandArgs[index];
    if (value === option) return commandArgs[index + 1];
    if (value?.startsWith(`${option}=`)) return value.slice(option.length + 1);
  }
  return undefined;
}

function createDefaultDeps(overrides: Partial<SessionCommandDeps>): SessionCommandDeps {
  return {
    homeDir: overrides.homeDir ?? (() => resolveKikiHome()),
    inspectSession: overrides.inspectSession ?? inspectOfflineSession,
    followSession: overrides.followSession ?? followOfflineSession,
    listSessions: overrides.listSessions ?? ((homeDir) => listOfflineSessions({ homeDir })),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => {
      process.exitCode = code;
    }),
  };
}

function writeError(deps: SessionCommandDeps, error: unknown, json: boolean): void {
  const inspectionError = error instanceof SessionInspectionError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    deps.stderr.write(`${JSON.stringify({
      schemaVersion: 1,
      error: {
        code: inspectionError?.code ?? 'internal_error',
        message,
        matches: inspectionError?.matches ?? [],
        suggestions: inspectionError?.suggestions ?? [],
      },
    }, null, 2)}\n`);
  } else {
    deps.stderr.write(`${sanitizeTerminalText(message)}\n`);
  }
  deps.exit(1);
}
