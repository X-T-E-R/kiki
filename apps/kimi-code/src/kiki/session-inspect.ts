import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  AgentTranscript,
  TranscriptFactReducer,
  TranscriptWireAdapter,
  isPlainAgentId,
  type AgentTranscriptSnapshot,
  type TranscriptFrame,
  type TranscriptInteraction,
  type TranscriptItem,
  type TranscriptTask,
  type TranscriptTurn,
  type TranscriptWireRecord,
} from '@kiki/transcript';

const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_PATTERN = /^session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const SESSION_LINK_PATTERN = /^\/s\/(session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const SESSION_SCHEMA_VERSION = 1 as const;
const MAX_STATE_BYTES = 16 << 20;
const MAX_WIRE_BYTES = 1 << 30;
const MAX_WIRE_RECORDS = 2_000_000;
const MAX_WIRE_LINE_BYTES = 64 << 20;

export type InspectionStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'idle' | 'unknown';

export interface SessionLocationSummary {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionDir: string;
  readonly title: string | null;
  readonly workDir: string | null;
  readonly updatedAt: string | null;
  readonly damaged: boolean;
}

export type SessionInspectionErrorCode =
  | 'invalid_reference'
  | 'invalid_option'
  | 'not_found'
  | 'ambiguous_session'
  | 'workspace_not_found'
  | 'damaged_session'
  | 'agent_not_found'
  | 'ambiguous_agent';

export class SessionInspectionError extends Error {
  constructor(
    readonly code: SessionInspectionErrorCode,
    message: string,
    readonly matches: readonly SessionLocationSummary[] = [],
    readonly suggestions: readonly SessionLocationSummary[] = [],
  ) {
    super(message);
    this.name = 'SessionInspectionError';
  }
}

export interface SessionInspectionAgent {
  readonly id: string;
  readonly name: string;
  readonly label: string | null;
  readonly type: 'main' | 'sub' | 'independent';
  readonly parentId: string | null;
  readonly model: string | null;
  readonly status: InspectionStatus;
  readonly wireComplete: boolean;
}

interface TimelineBase {
  readonly id: string;
  readonly turnId: string | null;
  readonly timestamp: string | null;
}

export interface MessageTimelineEntry extends TimelineBase {
  readonly type: 'message';
  readonly role: 'user' | 'assistant';
  readonly origin: TranscriptTurn['origin']['kind'];
  readonly text: string;
}

export interface ThinkingTimelineEntry extends TimelineBase {
  readonly type: 'thinking';
  readonly text: string;
}

export interface ToolTimelineEntry extends TimelineBase {
  readonly type: 'tool';
  readonly name: string;
  readonly state: 'running' | 'done' | 'error' | 'interrupted';
  readonly summary: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly error: string | null;
}

export interface NoticeTimelineEntry extends TimelineBase {
  readonly type: 'notice';
  readonly level: 'error' | 'warning' | 'info';
  readonly source: string | null;
  readonly message: string;
}

export interface MarkerTimelineEntry extends TimelineBase {
  readonly type: 'marker';
  readonly marker: string;
}

export interface SubagentTimelineEntry extends TimelineBase {
  readonly type: 'subagent';
  readonly agentId: string | null;
  readonly name: string;
  readonly state: TranscriptTask['state'];
  readonly description: string | null;
  readonly resultSummary: string | null;
  readonly error: string | null;
}

export interface TaskTimelineEntry extends TimelineBase {
  readonly type: 'task';
  readonly taskId: string;
  readonly kind: TranscriptTask['kind'];
  readonly state: TranscriptTask['state'];
  readonly description: string | null;
  readonly outputTail: string;
  readonly error: string | null;
}

export interface InteractionTimelineEntry extends TimelineBase {
  readonly type: 'interaction';
  readonly interactionKind: TranscriptInteraction['interactionKind'];
  readonly state: TranscriptInteraction['state'];
  readonly toolCallId: string | null;
  readonly request: unknown;
  readonly response: unknown;
}

export type SessionTimelineEntry =
  | MessageTimelineEntry
  | ThinkingTimelineEntry
  | ToolTimelineEntry
  | NoticeTimelineEntry
  | MarkerTimelineEntry
  | SubagentTimelineEntry
  | TaskTimelineEntry
  | InteractionTimelineEntry;

export interface SessionInspection {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly session: {
    readonly id: string;
    readonly title: string | null;
    readonly workDir: string | null;
    readonly sessionDir: string;
    readonly workspaceId: string;
    readonly createdAt: string | null;
    readonly updatedAt: string | null;
    readonly archived: boolean;
    readonly model: string | null;
    readonly status: InspectionStatus;
    readonly statusBasis: 'metadata' | 'wire';
    readonly lastTurnReason: 'completed' | 'cancelled' | 'failed' | null;
    readonly agentCount: number;
  };
  readonly selectedAgent: {
    readonly id: string;
    readonly name: string;
  };
  readonly agents: readonly SessionInspectionAgent[];
  readonly timeline: readonly SessionTimelineEntry[];
  readonly warnings: readonly string[];
}

export interface InspectSessionOptions {
  readonly homeDir: string;
  readonly reference: string;
  readonly agent?: string;
  readonly workspace?: string;
}

export interface ListOfflineSessionsOptions {
  readonly homeDir: string;
}

interface SessionLocation {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionDir: string;
  readonly canonicalSessionDir: string;
}

interface RawSessionMeta {
  readonly id: string;
  readonly title: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly archived: boolean;
  readonly cwd: string | null;
  readonly lastTurnReason: 'completed' | 'cancelled' | 'failed' | null;
  readonly agents: Readonly<Record<string, RawAgentMeta>>;
}

interface RawAgentMeta {
  readonly type?: 'main' | 'sub' | 'independent';
  readonly parentAgentId?: string | null;
  readonly delegator?: { readonly kind?: unknown; readonly agentId?: unknown };
  readonly labels?: Readonly<Record<string, string>>;
  readonly swarmItem?: string;
  readonly displayName?: string;
  readonly userLabel?: string;
  readonly model?: string;
}

interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly label: string | null;
  readonly aliases: readonly string[];
  readonly type: 'main' | 'sub' | 'independent';
  readonly parentId: string | null;
  readonly model: string | null;
  readonly canonicalSessionDir: string;
  readonly wirePath: string;
}

interface ProjectedAgent {
  readonly snapshot: AgentTranscriptSnapshot;
  readonly complete: boolean;
}

interface WireReadResult {
  readonly complete: boolean;
  readonly recordCount: number;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export function normalizeSessionReference(reference: string): string {
  const value = reference.trim();
  const link = SESSION_LINK_PATTERN.exec(value);
  if (link?.[1] !== undefined) return link[1].toLowerCase();
  const session = SESSION_ID_PATTERN.exec(value);
  if (session?.[1] !== undefined) return `session_${session[1].toLowerCase()}`;
  if (SESSION_UUID_PATTERN.test(value)) return `session_${value.toLowerCase()}`;
  throw new SessionInspectionError(
    'invalid_reference',
    `Invalid session reference "${reference}". Expected /s/session_<uuid>, session_<uuid>, or a bare UUID.`,
  );
}

export async function inspectOfflineSession(options: InspectSessionOptions): Promise<SessionInspection> {
  const sessionId = normalizeSessionReference(options.reference);
  const allLocations = await scanSessionLocations(options.homeDir);
  const locations = allLocations.filter((candidate) => candidate.sessionId === sessionId);
  if (locations.length === 0) {
    const suggestions = await nearbySessions(allLocations, sessionId);
    throw new SessionInspectionError(
      'not_found',
      notFoundMessage(sessionId, options.homeDir, suggestions),
      [],
      suggestions,
    );
  }

  const workspace = options.workspace?.trim();
  const filtered = workspace === undefined || workspace === ''
    ? locations
    : locations.filter((candidate) => candidate.workspaceId === workspace);
  if (filtered.length === 0) {
    const matches = await summarizeLocations(locations);
    throw new SessionInspectionError(
      'workspace_not_found',
      workspaceNotFoundMessage(sessionId, workspace ?? '', matches),
      matches,
    );
  }
  if (filtered.length > 1) {
    const matches = await summarizeLocations(filtered);
    throw new SessionInspectionError(
      'ambiguous_session',
      ambiguousSessionMessage(sessionId, matches),
      matches,
    );
  }

  const location = filtered[0]!;
  const metadata = await readSessionMetadata(location);
  const warnings: string[] = [];
  const definitions = await discoverAgents(location, metadata, warnings);
  const selected = selectAgent(options.agent, definitions, sessionId);
  const agentResults = new Map<string, ProjectedAgent>();
  const summaries: SessionInspectionAgent[] = [];

  for (const definition of definitions) {
    let projected: ProjectedAgent | undefined;
    try {
      projected = await projectAgentWire(definition);
    } catch (error) {
      if (definition.id === selected.id) throw error;
      warnings.push(`Agent ${definition.id} wire could not be read: ${errorMessage(error)}`);
      summaries.push(toAgentSummary(definition, undefined));
      continue;
    }
    if (projected === undefined) {
      warnings.push(`Agent ${definition.id} has no readable wire at ${definition.wirePath}.`);
      if (definition.id !== 'main') {
        summaries.push(toAgentSummary(definition, undefined));
        continue;
      }
      projected = {
        snapshot: new AgentTranscript(definition.id).snapshot(),
        complete: true,
      };
    }
    agentResults.set(definition.id, projected);
    if (!projected.complete) {
      warnings.push(`Agent ${definition.id} wire ended with a partial record; the incomplete tail was ignored.`);
    }
    summaries.push(toAgentSummary(definition, projected.snapshot, projected.complete));
  }

  const selectedProjection = agentResults.get(selected.id);
  if (selectedProjection === undefined) {
    throw damagedError(
      location,
      `the selected agent ${selected.id} has no readable agents/${selected.id}/wire.jsonl`,
    );
  }

  const main = summaries.find((agent) => agent.id === 'main') ?? summaries.find((agent) => agent.type === 'main');
  const sessionStatus = metadata.lastTurnReason ?? main?.status ?? 'unknown';
  const statusBasis = metadata.lastTurnReason === null ? 'wire' : 'metadata';
  if (statusBasis === 'wire' && sessionStatus === 'running') {
    warnings.push('Running status comes from the persisted wire snapshot; process liveness was not checked.');
  }

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    session: {
      id: sessionId,
      title: metadata.title,
      workDir: metadata.cwd,
      sessionDir: location.sessionDir,
      workspaceId: location.workspaceId,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      archived: metadata.archived,
      model: main?.model ?? null,
      status: sessionStatus,
      statusBasis,
      lastTurnReason: metadata.lastTurnReason,
      agentCount: summaries.length,
    },
    selectedAgent: { id: selected.id, name: selected.name },
    agents: summaries,
    timeline: timelineFromSnapshot(selectedProjection.snapshot),
    warnings,
  };
}

export async function listOfflineSessions(
  options: ListOfflineSessionsOptions,
): Promise<readonly SessionLocationSummary[]> {
  const summaries = await summarizeLocations(await scanSessionLocations(options.homeDir));
  return summaries.toSorted((left, right) => {
    const byUpdated = (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0);
    if (byUpdated !== 0) return byUpdated;
    const byId = compareStrings(left.sessionId, right.sessionId);
    return byId !== 0 ? byId : compareStrings(left.workspaceId, right.workspaceId);
  });
}

async function scanSessionLocations(homeDir: string): Promise<SessionLocation[]> {
  const sessionsRoot = join(resolve(homeDir), 'sessions');
  let canonicalSessionsRoot: string;
  try {
    canonicalSessionsRoot = await realpath(sessionsRoot);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
  const workspaces = (await readDirectories(sessionsRoot)).filter((entry) => entry.name.startsWith('wd_'));
  const locations: SessionLocation[] = [];
  for (const workspace of workspaces) {
    const workspaceDir = join(sessionsRoot, workspace.name);
    for (const session of await readDirectories(workspaceDir)) {
      if (!SESSION_ID_PATTERN.test(session.name)) continue;
      const sessionDir = join(workspaceDir, session.name);
      let canonicalSessionDir: string;
      try {
        canonicalSessionDir = await realpath(sessionDir);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) continue;
        throw error;
      }
      if (!pathIsWithin(canonicalSessionsRoot, canonicalSessionDir)) continue;
      locations.push({
        sessionId: session.name.toLowerCase(),
        workspaceId: workspace.name,
        sessionDir,
        canonicalSessionDir,
      });
    }
  }
  return locations;
}

async function readDirectories(path: string): Promise<Dirent[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .toSorted((left, right) => compareStrings(left.name, right.name));
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
}

async function summarizeLocations(
  locations: readonly SessionLocation[],
): Promise<SessionLocationSummary[]> {
  return mapBounded(locations, 16, summarizeLocation);
}

async function summarizeLocation(location: SessionLocation): Promise<SessionLocationSummary> {
  try {
    const metadata = await readSessionMetadata(location);
    return {
      sessionId: location.sessionId,
      workspaceId: location.workspaceId,
      sessionDir: location.sessionDir,
      title: metadata.title,
      workDir: metadata.cwd,
      updatedAt: metadata.updatedAt,
      damaged: false,
    };
  } catch {
    return {
      sessionId: location.sessionId,
      workspaceId: location.workspaceId,
      sessionDir: location.sessionDir,
      title: null,
      workDir: null,
      updatedAt: null,
      damaged: true,
    };
  }
}

async function nearbySessions(
  locations: readonly SessionLocation[],
  sessionId: string,
): Promise<SessionLocationSummary[]> {
  const unique = new Map<string, SessionLocationSummary>();
  for (const candidate of await summarizeLocations(locations)) {
    const key = `${candidate.sessionId}\u0000${candidate.workspaceId}`;
    unique.set(key, candidate);
  }
  return [...unique.values()]
    .toSorted((left, right) => {
      const leftDistance = levenshtein(sessionId, left.sessionId);
      const rightDistance = levenshtein(sessionId, right.sessionId);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0);
    })
    .slice(0, 5);
}

async function readSessionMetadata(location: SessionLocation): Promise<RawSessionMeta> {
  const direct = join(location.sessionDir, 'state.json');
  const legacy = join(location.sessionDir, 'session-meta', 'state.json');
  let sourcePath = direct;
  let contents: string;
  try {
    contents = await readRegularTextFile(direct, location.canonicalSessionDir);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) {
      throw damagedError(location, `state.json could not be read: ${errorMessage(error)}`);
    }
    sourcePath = legacy;
    try {
      contents = await readRegularTextFile(legacy, location.canonicalSessionDir);
    } catch (legacyError) {
      if (isNodeError(legacyError, 'ENOENT')) {
        throw damagedError(location, 'state.json is missing');
      }
      throw damagedError(location, `state.json could not be read: ${errorMessage(legacyError)}`);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw damagedError(location, `${sourcePath} is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) throw damagedError(location, `${sourcePath} must contain a JSON object`);
  const storedId = stringValue(parsed['id']);
  if (storedId !== undefined && storedId.toLowerCase() !== location.sessionId) {
    throw damagedError(location, `${sourcePath} belongs to ${storedId}, not ${location.sessionId}`);
  }
  return {
    id: storedId ?? location.sessionId,
    title: stringValue(parsed['title']) ?? null,
    createdAt: timeValue(parsed['createdAt']),
    updatedAt: timeValue(parsed['updatedAt']),
    archived: parsed['archived'] === true,
    cwd: recoverWorkDir(parsed),
    lastTurnReason: turnReason(parsed['lastTurnReason']),
    agents: agentMetadata(parsed['agents']),
  };
}

async function discoverAgents(
  location: SessionLocation,
  metadata: RawSessionMeta,
  warnings: string[],
): Promise<AgentDefinition[]> {
  const agentsDir = join(location.sessionDir, 'agents');
  const entries = await readDirectories(agentsDir);
  const ids = new Set<string>();
  for (const id of Object.keys(metadata.agents)) {
    if (isPlainAgentId(id)) ids.add(id);
    else warnings.push(`Ignored path-hostile agent id in state.json: ${JSON.stringify(id)}.`);
  }
  for (const entry of entries) {
    if (isPlainAgentId(entry.name)) ids.add(entry.name);
    else warnings.push(`Ignored path-hostile agent directory: ${JSON.stringify(entry.name)}.`);
  }
  if (ids.size === 0) {
    ids.add('main');
    warnings.push('The persisted agent roster is empty; showing an empty main-agent timeline.');
  }
  const definitions = [...ids].map((id): AgentDefinition => {
    const meta = metadata.agents[id];
    const type = meta?.type ?? (id === 'main' ? 'main' : 'sub');
    const parentId = meta?.delegator === undefined
      ? firstNonEmpty(meta?.labels?.['parentAgentId'], meta?.parentAgentId ?? undefined)
      : meta.delegator.kind === 'agent'
        ? stringValue(meta.delegator.agentId)
        : undefined;
    const displayName = stringValue(meta?.displayName);
    const userLabel = firstNonEmpty(
      meta?.userLabel,
      meta?.labels?.['swarmItem'],
      meta?.swarmItem,
      meta?.labels?.['collaborationTaskName'],
    );
    const name = userLabel ?? displayName ?? id;
    return {
      id,
      name,
      label: userLabel ?? null,
      aliases: [...new Set([
        displayName,
        userLabel,
        meta?.labels?.['profileName'],
        meta?.labels?.['collaborationAgentType'],
      ].filter((value): value is string => value !== undefined))],
      type,
      parentId: parentId ?? null,
      model: stringValue(meta?.model) ?? null,
      canonicalSessionDir: location.canonicalSessionDir,
      wirePath: join(agentsDir, id, 'wire.jsonl'),
    };
  });
  return definitions.toSorted((left, right) => {
    if (left.id === 'main') return -1;
    if (right.id === 'main') return 1;
    return compareStrings(left.name, right.name) || compareStrings(left.id, right.id);
  });
}

function selectAgent(
  requested: string | undefined,
  definitions: readonly AgentDefinition[],
  sessionId: string,
): AgentDefinition {
  const defaultAgent = definitions.find((agent) => agent.id === 'main')
    ?? definitions.find((agent) => agent.type === 'main')
    ?? definitions[0];
  const value = requested?.trim();
  if (value === undefined || value === '') {
    if (defaultAgent !== undefined) return defaultAgent;
    throw new SessionInspectionError('agent_not_found', `Session ${sessionId} has no agents to inspect.`);
  }
  const exactId = definitions.find((agent) => agent.id === value);
  if (exactId !== undefined) return exactId;
  const folded = value.toLowerCase();
  const named = definitions.filter((agent) =>
    agent.name.toLowerCase() === folded
    || agent.aliases.some((alias) => alias.toLowerCase() === folded),
  );
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw new SessionInspectionError(
      'ambiguous_agent',
      `Agent name "${value}" matches multiple agents in ${sessionId}:\n${named
        .map((agent) => `- ${agent.id} (${agent.name})`)
        .join('\n')}\nRe-run with --agent <exact-id>.`,
    );
  }
  throw new SessionInspectionError(
    'agent_not_found',
    `Agent "${value}" was not found in ${sessionId}. Available agents:\n${definitions
      .map((agent) => `- ${agent.id} (${agent.name})`)
      .join('\n')}\nUse --agent <id|name>.`,
  );
}

async function projectAgentWire(
  definition: AgentDefinition,
): Promise<ProjectedAgent | undefined> {
  const transcript = new AgentTranscript(definition.id);
  const reducer = new TranscriptFactReducer(transcript);
  const adapter = new TranscriptWireAdapter(definition.id, {
    turn: (turnId) => transcript.getTurn(turnId),
    tool: (toolCallId) => transcript.getToolCall(toolCallId),
    task: (taskId) => transcript.getTask(taskId),
  });
  try {
    const result = await readWireRecords(definition.wirePath, definition.canonicalSessionDir, (record, lineNumber) => {
      try {
        reducer.apply(adapter.add(record));
      } catch (error) {
        throw new Error(`could not project line ${lineNumber}: ${errorMessage(error)}`, { cause: error });
      }
    });
    return { snapshot: transcript.snapshot(), complete: result.complete };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw new SessionInspectionError(
      'damaged_session',
      `Session data is damaged: ${definition.wirePath} could not be read. ${errorMessage(error)}\nInspect the file or restore the session from backup.`,
    );
  }
}

async function readWireRecords(
  wirePath: string,
  canonicalSessionDir: string,
  onRecord: (record: TranscriptWireRecord, lineNumber: number) => void,
): Promise<WireReadResult> {
  const expectedIdentity = await assertRegularFile(wirePath, canonicalSessionDir);
  const handle = await openReadOnlyNoFollow(wirePath);
  let lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let lineNumber = 0;
  let recordCount = 0;
  let complete = true;

  const consume = (line: Buffer, terminated: boolean): void => {
    const normalized = line.length > 0 && line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
    if (normalized.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(normalized.toString('utf8'));
    } catch (error) {
      if (!terminated) {
        complete = false;
        return;
      }
      throw new Error(`corrupted JSON at line ${lineNumber}: ${errorMessage(error)}`, { cause: error });
    }
    if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
      throw new Error(`line ${lineNumber} is not a wire record with a string type`);
    }
    recordCount += 1;
    if (recordCount > MAX_WIRE_RECORDS) {
      throw new Error(`wire exceeds the ${MAX_WIRE_RECORDS}-record safety limit`);
    }
    onRecord(parsed as TranscriptWireRecord, lineNumber);
  };

  const flushLine = (terminated: boolean): void => {
    lineNumber += 1;
    const line = lineChunks.length === 1 ? lineChunks[0]! : Buffer.concat(lineChunks, lineBytes);
    lineChunks = [];
    lineBytes = 0;
    consume(line, terminated);
  };

  try {
    const info = await handle.stat();
    assertSameFile(expectedIdentity, info, wirePath);
    if (!info.isFile()) throw new Error(`${wirePath} is not a regular file`);
    if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error(`invalid file size ${info.size}`);
    if (info.size > MAX_WIRE_BYTES) throw new Error(`wire exceeds the ${MAX_WIRE_BYTES}-byte safety limit`);
    const chunk = Buffer.allocUnsafe(1 << 20);
    let position = 0;
    while (position < info.size) {
      const length = Math.min(chunk.length, info.size - position);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) throw new Error('wire changed during the read');
      position += bytesRead;
      let rest = chunk.subarray(0, bytesRead);
      for (;;) {
        const newline = rest.indexOf(0x0a);
        const part = newline < 0 ? rest : rest.subarray(0, newline);
        if (part.length > 0) {
          if (lineBytes + part.length > MAX_WIRE_LINE_BYTES) {
            throw new Error(`line ${lineNumber + 1} exceeds the ${MAX_WIRE_LINE_BYTES}-byte safety limit`);
          }
          lineChunks.push(Buffer.from(part));
          lineBytes += part.length;
        }
        if (newline < 0) break;
        flushLine(true);
        rest = rest.subarray(newline + 1);
      }
    }
    if (lineBytes > 0) flushLine(false);
    return { complete, recordCount };
  } finally {
    await handle.close();
  }
}

function toAgentSummary(
  definition: AgentDefinition,
  snapshot: AgentTranscriptSnapshot | undefined,
  complete = false,
): SessionInspectionAgent {
  return {
    id: definition.id,
    name: definition.name,
    label: definition.label,
    type: definition.type,
    parentId: definition.parentId,
    model: definition.model,
    status: snapshot === undefined ? 'unknown' : statusFromSnapshot(snapshot),
    wireComplete: complete,
  };
}

function statusFromSnapshot(snapshot: AgentTranscriptSnapshot): InspectionStatus {
  const turns = snapshot.items.filter((item): item is TranscriptTurn => item.kind === 'turn');
  if (
    turns.some((turn) => turn.state === 'running' || turn.state === 'queued')
    || snapshot.tasks.some((task) => task.state === 'running')
  ) {
    return 'running';
  }
  const last = turns.at(-1);
  if (last === undefined) return 'idle';
  return last.state === 'queued' ? 'running' : last.state;
}

function timelineFromSnapshot(snapshot: AgentTranscriptSnapshot): SessionTimelineEntry[] {
  const tasks = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
  const timeline: SessionTimelineEntry[] = [];
  const referencedTasks = new Set<string>();
  for (const item of snapshot.items) {
    if (item.kind === 'taskref') referencedTasks.add(item.taskId);
    appendTimelineItem(timeline, item, tasks);
  }
  for (const task of snapshot.tasks) {
    if (referencedTasks.has(task.taskId)) continue;
    timeline.push(taskTimelineEntry(task, `task:${task.taskId}`));
  }
  for (const interaction of snapshot.interactions) {
    timeline.push({
      type: 'interaction',
      id: interaction.interactionId,
      turnId: originTurnId(interaction.origin),
      timestamp: null,
      interactionKind: interaction.interactionKind,
      state: interaction.state,
      toolCallId: interaction.toolCallId ?? null,
      request: interaction.request ?? null,
      response: interaction.response ?? null,
    });
  }
  return timeline;
}

function appendTimelineItem(
  timeline: SessionTimelineEntry[],
  item: TranscriptItem,
  tasks: ReadonlyMap<string, TranscriptTask>,
): void {
  if (item.kind === 'marker') {
    timeline.push({
      type: 'marker',
      id: item.markerId,
      turnId: null,
      timestamp: item.at ?? null,
      marker: item.marker,
    });
    return;
  }
  if (item.kind === 'taskref') {
    const task = tasks.get(item.taskId);
    if (task === undefined) return;
    if (task.kind === 'subagent') {
      timeline.push({
        type: 'subagent',
        id: item.refId,
        turnId: task.ownerTurnId === undefined ? null : `t${task.ownerTurnId}`,
        timestamp: item.at ?? task.startedAt ?? null,
        agentId: task.agentId ?? null,
        name: task.name ?? task.subagentName ?? task.agentId ?? task.taskId,
        state: task.state,
        description: task.description ?? null,
        resultSummary: task.resultSummary ?? null,
        error: task.error ?? null,
      });
      return;
    }
    timeline.push(taskTimelineEntry(task, item.refId, item.at ?? task.startedAt ?? null));
    return;
  }

  if (item.prompt !== undefined && item.prompt !== '') {
    timeline.push({
      type: 'message',
      id: item.message?.messageId ?? `${item.turnId}:prompt`,
      turnId: item.turnId,
      timestamp: item.startedAt ?? null,
      role: 'user',
      origin: item.origin.kind,
      text: item.prompt,
    });
  }
  for (const step of item.steps) {
    for (const frame of step.frames) appendFrame(timeline, item, frame, step.startedAt ?? item.startedAt ?? null);
  }
}

function appendFrame(
  timeline: SessionTimelineEntry[],
  turn: TranscriptTurn,
  frame: TranscriptFrame,
  fallbackTimestamp: string | null,
): void {
  if (frame.kind === 'text') {
    timeline.push({
      type: 'message',
      id: frame.frameId,
      turnId: turn.turnId,
      timestamp: fallbackTimestamp,
      role: frame.role,
      origin: frame.role === 'user' ? turn.origin.kind : 'other',
      text: frame.text,
    });
    return;
  }
  if (frame.kind === 'thinking') {
    timeline.push({
      type: 'thinking',
      id: frame.frameId,
      turnId: turn.turnId,
      timestamp: fallbackTimestamp,
      text: frame.text,
    });
    return;
  }
  if (frame.kind === 'notice') {
    timeline.push({
      type: 'notice',
      id: frame.frameId,
      turnId: turn.turnId,
      timestamp: fallbackTimestamp,
      level: frame.level,
      source: frame.source ?? null,
      message: frame.message,
    });
    return;
  }
  const input = frame.input === undefined ? null : frame.input;
  const output = frame.output === undefined ? null : frame.output;
  timeline.push({
    type: 'tool',
    id: frame.toolCallId,
    turnId: turn.turnId,
    timestamp: frame.startedAt ?? fallbackTimestamp,
    name: frame.name,
    state: frame.state,
    summary: toolSummary(frame.name, input, output, frame.error),
    input,
    output,
    error: frame.error ?? null,
  });
}

function taskTimelineEntry(
  task: TranscriptTask,
  id: string,
  timestamp: string | null = task.startedAt ?? null,
): TaskTimelineEntry | SubagentTimelineEntry {
  const turnId = task.ownerTurnId === undefined ? null : `t${task.ownerTurnId}`;
  if (task.kind === 'subagent') {
    return {
      type: 'subagent',
      id,
      turnId,
      timestamp,
      agentId: task.agentId ?? null,
      name: task.name ?? task.subagentName ?? task.agentId ?? task.taskId,
      state: task.state,
      description: task.description ?? null,
      resultSummary: task.resultSummary ?? null,
      error: task.error ?? null,
    };
  }
  return {
    type: 'task',
    id,
    turnId,
    timestamp,
    taskId: task.taskId,
    kind: task.kind,
    state: task.state,
    description: task.description ?? null,
    outputTail: task.outputTail,
    error: task.error ?? null,
  };
}

function originTurnId(origin: unknown): string | null {
  if (!isRecord(origin)) return null;
  const turnId = origin['turnId'];
  return typeof turnId === 'number' && Number.isFinite(turnId) ? `t${turnId}` : null;
}

function toolSummary(name: string, input: unknown, output: unknown, error: string | undefined): string {
  const parts = [name];
  if (input !== null) parts.push(compactValue(input));
  if (error !== undefined) parts.push(`error: ${error}`);
  else if (output !== null) parts.push(`→ ${compactValue(output)}`);
  return truncate(parts.join(' '), 240);
}

function compactValue(value: unknown): string {
  if (typeof value === 'string') return value.replaceAll(/\s+/g, ' ').trim();
  try {
    return JSON.stringify(value).replaceAll(/\s+/g, ' ').trim();
  } catch {
    return String(value);
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function notFoundMessage(
  sessionId: string,
  homeDir: string,
  suggestions: readonly SessionLocationSummary[],
): string {
  const nearby = suggestions.length === 0
    ? ''
    : `\nNearby sessions:\n${suggestions.map(formatLocationLine).join('\n')}`;
  return `Session ${sessionId} was not found under ${join(resolve(homeDir), 'sessions')}.${nearby}\nRun \`kiki session list\` to see all local sessions.`;
}

function workspaceNotFoundMessage(
  sessionId: string,
  workspace: string,
  matches: readonly SessionLocationSummary[],
): string {
  return `Session ${sessionId} does not exist in workspace ${workspace}. Matching copies:\n${matches
    .map(formatLocationLine)
    .join('\n')}\nRe-run with --workspace <workspace-id>.`;
}

function ambiguousSessionMessage(
  sessionId: string,
  matches: readonly SessionLocationSummary[],
): string {
  return `Session ${sessionId} exists in multiple workspace directories:\n${matches
    .map(formatLocationLine)
    .join('\n')}\nRe-run with --workspace <workspace-id>.`;
}

function formatLocationLine(location: SessionLocationSummary): string {
  const title = location.title === null ? '' : ` — ${location.title}`;
  const workDir = location.workDir ?? location.sessionDir;
  const damaged = location.damaged ? ' [damaged]' : '';
  return `- ${location.sessionId} [${location.workspaceId}] ${workDir}${title}${damaged}`;
}

function damagedError(location: SessionLocation, detail: string): SessionInspectionError {
  return new SessionInspectionError(
    'damaged_session',
    `Session directory is damaged: ${location.sessionDir}; ${detail}.\nInspect that directory or restore the session from backup.`,
  );
}

function recoverWorkDir(record: Record<string, unknown>): string | null {
  const direct = stringValue(record['cwd']) ?? stringValue(record['workDir']);
  if (direct !== undefined) return direct;
  const custom = record['custom'];
  return isRecord(custom) ? (stringValue(custom['cwd']) ?? null) : null;
}

function agentMetadata(value: unknown): Readonly<Record<string, RawAgentMeta>> {
  if (!isRecord(value)) return {};
  const result: Record<string, RawAgentMeta> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const rawType = raw['type'];
    const type = rawType === 'main' || rawType === 'sub' || rawType === 'independent'
      ? rawType
      : undefined;
    const delegator = isRecord(raw['delegator'])
      ? { kind: raw['delegator']['kind'], agentId: raw['delegator']['agentId'] }
      : undefined;
    const labels = stringRecord(raw['labels']);
    result[id] = {
      type,
      parentAgentId: typeof raw['parentAgentId'] === 'string' || raw['parentAgentId'] === null
        ? raw['parentAgentId']
        : undefined,
      delegator,
      labels,
      swarmItem: stringValue(raw['swarmItem']),
      displayName: stringValue(raw['displayName']),
      userLabel: stringValue(raw['userLabel']),
      model: stringValue(raw['model']),
    };
  }
  return result;
}

function turnReason(value: unknown): RawSessionMeta['lastTurnReason'] {
  return value === 'completed' || value === 'cancelled' || value === 'failed' ? value : null;
}

function timeValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : new Date(time).toISOString();
  }
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry !== '') result[key] = entry;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readRegularTextFile(path: string, canonicalSessionDir: string): Promise<string> {
  const expectedIdentity = await assertRegularFile(path, canonicalSessionDir);
  const handle = await openReadOnlyNoFollow(path);
  try {
    const info = await handle.stat();
    assertSameFile(expectedIdentity, info, path);
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    if (info.size > MAX_STATE_BYTES) {
      throw new Error(`state.json exceeds the ${MAX_STATE_BYTES}-byte safety limit`);
    }
    const bytes = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('state.json changed during the read');
      offset += bytesRead;
    }
    return bytes.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function assertRegularFile(
  path: string,
  canonicalSessionDir: string,
): Promise<FileIdentity> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${path} is not a regular file`);
  const canonicalPath = await realpath(path);
  if (!pathIsWithin(canonicalSessionDir, canonicalPath)) {
    throw new Error(`${path} resolves outside the session directory`);
  }
  return { dev: info.dev, ino: info.ino };
}

function assertSameFile(expected: FileIdentity, actual: FileIdentity, path: string): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`${path} changed before it could be read`);
  }
}

function pathIsWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function openReadOnlyNoFollow(path: string): Promise<FileHandle> {
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  return open(path, constants.O_RDONLY | noFollow);
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = Array.from<R>({ length: values.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      result[index] = await fn(values[index]!);
    }
  });
  await Promise.all(workers);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function levenshtein(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

