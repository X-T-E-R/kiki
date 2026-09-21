import type {
  SessionInspection,
  SessionInspectionAgent,
  SessionLocationSummary,
  SessionTimelineEntry,
} from './session-inspect';

export function renderSessionInspection(inspection: SessionInspection): string {
  const session = inspection.session;
  const lines = [
    sanitizeTerminalText(session.title ?? `Session ${session.id}`),
    `ID: ${sanitizeInline(session.id)}`,
    `Status: ${session.status} (${session.statusBasis})`,
    `Last turn: ${session.lastTurnReason ?? 'unknown'}`,
    `Model: ${sanitizeInline(session.model ?? 'unknown')}`,
    `Work dir: ${sanitizeInline(session.workDir ?? 'unknown')}`,
    `Workspace: ${sanitizeInline(session.workspaceId)}`,
    `Session dir: ${sanitizeInline(session.sessionDir)}`,
    `Created: ${session.createdAt ?? 'unknown'}`,
    `Updated: ${session.updatedAt ?? 'unknown'}`,
    `Archived: ${session.archived ? 'yes' : 'no'}`,
    `Agents: ${session.agentCount}`,
    `Selected agent: ${inspection.selectedAgent.status} · last activity ${inspection.selectedAgent.lastActivityAt ?? 'unknown'}`,
    '',
    'Agent tree:',
    ...renderAgentTree(inspection.agents, inspection.selectedAgent.id),
    '',
    `Timeline — ${sanitizeInline(inspection.selectedAgent.name)} (${sanitizeInline(inspection.selectedAgent.id)}):`,
  ];

  if (inspection.timeline.length === 0) lines.push('  (no timeline events)');
  else {
    for (const entry of inspection.timeline) lines.push(...renderTimelineEntry(entry));
  }
  if (inspection.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of inspection.warnings) lines.push(`- ${sanitizeTerminalText(warning)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderSessionFollowUpdate(
  previous: SessionInspection,
  current: SessionInspection,
): string {
  const previousTimeline = new Map(
    previous.timeline.map((entry) => [timelineEntryKey(entry), JSON.stringify(entry)]),
  );
  const changedEntries = current.timeline.filter((entry) =>
    previousTimeline.get(timelineEntryKey(entry)) !== JSON.stringify(entry),
  );
  const lines = [
    '',
    `Update — ${sanitizeInline(current.selectedAgent.name)} (${sanitizeInline(current.selectedAgent.id)})`,
    `Status: ${current.session.status} (${current.session.statusBasis})`,
    `Agent: ${current.selectedAgent.status} · last activity ${current.selectedAgent.lastActivityAt ?? 'unknown'}`,
  ];
  for (const entry of changedEntries) lines.push(...renderTimelineEntry(entry));
  const priorWarnings = new Set(previous.warnings);
  for (const warning of current.warnings) {
    if (!priorWarnings.has(warning)) lines.push(`Warning: ${sanitizeTerminalText(warning)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderSessionList(
  sessions: readonly SessionLocationSummary[],
  homeDir: string,
): string {
  if (sessions.length === 0) return `No local sessions found under ${sanitizeInline(homeDir)}.\n`;
  const lines = [`Local sessions (${sessions.length}):`];
  for (const session of sessions) {
    const title = session.title ?? '(untitled)';
    const updated = session.updatedAt ?? 'unknown time';
    const location = session.workDir ?? session.sessionDir;
    const damaged = session.damaged ? ' [damaged]' : '';
    lines.push(`${sanitizeInline(session.sessionId)}  [${sanitizeInline(session.workspaceId)}]  ${updated}${damaged}`);
    lines.push(`  ${sanitizeTerminalText(title)}`);
    lines.push(`  ${sanitizeInline(location)}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderAgentTree(
  agents: readonly SessionInspectionAgent[],
  selectedId: string,
): string[] {
  if (agents.length === 0) return ['  (none)'];
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const children = new Map<string, SessionInspectionAgent[]>();
  const roots: SessionInspectionAgent[] = [];
  for (const agent of agents) {
    if (agent.parentId === null || !byId.has(agent.parentId) || agent.parentId === agent.id) {
      roots.push(agent);
      continue;
    }
    const siblings = children.get(agent.parentId);
    if (siblings === undefined) children.set(agent.parentId, [agent]);
    else siblings.push(agent);
  }
  sortAgents(roots);
  for (const siblings of children.values()) sortAgents(siblings);

  const lines: string[] = [];
  const visited = new Set<string>();
  const visit = (agent: SessionInspectionAgent, prefix: string, branch: string): void => {
    if (visited.has(agent.id)) return;
    visited.add(agent.id);
    lines.push(`${prefix}${branch}${agentLine(agent, agent.id === selectedId)}`);
    const nested = children.get(agent.id) ?? [];
    for (const [index, child] of nested.entries()) {
      const last = index === nested.length - 1;
      visit(child, `${prefix}${branch === '' ? '' : branch === '└─ ' ? '   ' : '│  '}`, last ? '└─ ' : '├─ ');
    }
  };
  for (const [index, root] of roots.entries()) {
    visit(root, '', index === 0 && roots.length === 1 ? '' : index === roots.length - 1 ? '└─ ' : '├─ ');
  }
  for (const agent of agents) {
    if (!visited.has(agent.id)) visit(agent, '', '└─ ');
  }
  return lines.map((line) => `  ${line}`);
}

function sortAgents(agents: SessionInspectionAgent[]): void {
  agents.sort((left, right) => {
    if (left.id === 'main') return -1;
    if (right.id === 'main') return 1;
    return compareStrings(left.name, right.name) || compareStrings(left.id, right.id);
  });
}

function agentLine(agent: SessionInspectionAgent, selected: boolean): string {
  const name = agent.name === agent.id
    ? sanitizeInline(agent.id)
    : `${sanitizeInline(agent.name)} (${sanitizeInline(agent.id)})`;
  const model = agent.model === null ? '' : ` · ${sanitizeInline(agent.model)}`;
  const lastActivity = agent.lastActivityAt === null ? '' : ` · last ${agent.lastActivityAt}`;
  const marker = selected ? ' *' : '';
  return `${name} [${agent.type}] · ${agent.status}${model}${lastActivity}${marker}`;
}

function timelineEntryKey(entry: SessionTimelineEntry): string {
  return `${entry.type}\u0000${entry.id}`;
}

function renderTimelineEntry(entry: SessionTimelineEntry): string[] {
  const at = entry.timestamp === null ? '' : `[${entry.timestamp}] `;
  switch (entry.type) {
    case 'message': {
      const origin = entry.role === 'user' && entry.origin !== 'user' ? ` (${entry.origin})` : '';
      return renderTextBlock(`${at}${entry.role.toUpperCase()}${origin}`, entry.text);
    }
    case 'thinking':
      return renderTextBlock(`${at}THINKING`, entry.text);
    case 'tool':
      return [`${at}TOOL ${sanitizeInline(entry.name)} [${entry.state}]`, `  ${sanitizeInline(entry.summary)}`];
    case 'notice':
      return renderTextBlock(
        `${at}${entry.level.toUpperCase()}${entry.source === null ? '' : ` ${entry.source}`}`,
        entry.message,
      );
    case 'marker':
      return [`${at}— ${sanitizeInline(entry.marker)} —`];
    case 'subagent': {
      const label = entry.agentId === null
        ? sanitizeInline(entry.name)
        : `${sanitizeInline(entry.name)} (${sanitizeInline(entry.agentId)})`;
      const detail = entry.error ?? entry.resultSummary ?? entry.description;
      return detail === null
        ? [`${at}SUBAGENT ${label} [${entry.state}]`]
        : renderTextBlock(`${at}SUBAGENT ${label} [${entry.state}]`, detail);
    }
    case 'task': {
      const detail = entry.error ?? entry.description ?? entry.outputTail;
      const label = `${at}TASK ${entry.kind} ${sanitizeInline(entry.taskId)} [${entry.state}]`;
      return detail === '' || detail === null ? [label] : renderTextBlock(label, detail);
    }
    case 'interaction': {
      const detail = entry.response === null ? entry.request : entry.response;
      const label = `${at}${entry.interactionKind.toUpperCase()} [${entry.state}]`;
      return detail === null ? [label] : renderTextBlock(label, compactValue(detail));
    }
  }
}

function renderTextBlock(label: string, text: string): string[] {
  const safe = sanitizeTerminalText(text);
  const content = safe === '' ? ['(empty)'] : safe.split('\n');
  return [sanitizeInline(label), ...content.map((line) => `  ${line}`)];
}

function compactValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function sanitizeTerminalText(value: string): string {
  return stripAnsi(value)
    .replaceAll(/\r\n?/g, '\n')
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (char) =>
      `\\x${char.codePointAt(0)!.toString(16).padStart(2, '0')}`,
    );
}

function sanitizeInline(value: string): string {
  return sanitizeTerminalText(value).replaceAll('\n', '\\n');
}

function stripAnsi(value: string): string {
  return value
    .replaceAll(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replaceAll(/\u001B[@-_]/g, '');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
