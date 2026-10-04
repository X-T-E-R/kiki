/**
 * One tool, read through one selected object.
 *
 * The subagent tool surface has two objects with different powers: the
 * server-wide default rule (`[subagent].allowed_tools`, which carries the tools
 * subagents do not get by default) and one agent profile's own `tools` /
 * `disallowedTools` lists. The same tool therefore reads differently in each,
 * so state is derived here as (tool, object) instead of being flattened into one
 * catalog of names.
 *
 * A profile's opt-in for one of those tools is a *concrete name*, and the
 * engine reads it as an OR: `isSubagentToolAllowed` opens a tool when the
 * server rule names it or when the profile's own `tools` list names it. A
 * profile's finite allowlist and `disallowedTools` still restrict on top, so
 * this module reads the same three inputs in that order and never claims a
 * profile edit can shut what the server rule already opened.
 *
 * Pure: every input is loaded data, so each row's status, the reason behind it
 * and the edit action it can actually offer are testable without rendering.
 */

import { subagentToolDefault, type SubagentToolDefault } from '@kiki/agent-profiles/subagentToolPolicy';
import { canonicalToolName, legacyToolNames } from '@kiki/agent-profiles/toolAliases';
import { isToolActive, isToolExplicitlyNamed, type ToolSource } from '@kiki/agent-profiles/toolPolicy';
import type { ToolDescriptor } from '@kiki/protocol';

/** The object value for the server-wide rule; profile names are the other values. */
export const DEFAULT_TOOL_OBJECT = '__default__';

/** The wire adds `skill`; the policy layer knows builtin / user / mcp / plugin. */
export function policyToolSource(source: ToolDescriptor['source']): ToolSource {
  return source === 'builtin' || source === 'mcp' ? source : 'plugin';
}

/**
 * The policy table names the main-agent-only tools by their legacy action names
 * while the registry also exposes the merged ones (`Cron`, `Goal`). Reading the
 * shared alias table keeps the row consistent with the real gate without
 * copying the mapping.
 */
export function subagentToolAccess(tool: Pick<ToolDescriptor, 'name' | 'source'>): SubagentToolDefault {
  const source = policyToolSource(tool.source);
  const direct = subagentToolDefault(tool.name, source);
  if (direct === 'main-only' || source !== 'builtin') return direct;
  const legacy = legacyToolNames(tool.name);
  return legacy.length > 0 && legacy.every((name) => subagentToolDefault(name, 'builtin') === 'main-only')
    ? 'main-only'
    : direct;
}

/** The profile's two tool lists as the policy reads them: null means the field is not written. */
export interface ProfileToolLists {
  readonly tools: readonly string[] | null;
  readonly disallowedTools: readonly string[] | null;
}

/** 允许 / 禁用 / 继承 / 不可编辑. */
export type ToolStatus = 'allowed' | 'blocked' | 'inherit' | 'fixed';
/** Why this object reads that way; the detail pane turns it into one sentence. */
export type ToolReason =
  | 'default-allowed'
  | 'server-opt-in'
  | 'opt-in-off'
  | 'profile-explicit'
  | 'profile-pattern'
  | 'profile-denied'
  | 'profile-allowlist'
  | 'inherit'
  | 'main-only'
  | 'executor';

/**
 * The edit action a row can offer. `null` means this object has nothing to
 * change for this tool — the row is not given a control just to have one.
 */
export type ToolAction =
  | 'opt-in'
  | 'allow'
  | 'deny'
  | 'editor'
  | null;

/** A tool row whose status comes from the profile naming it, not from a list that excludes it. */
export const TOOL_NAME_WILDCARD = '*';

/**
 * What one profile's `tools` list does to selection. A lone `*` writes no
 * allowlist, so it is read as none; `['*', name]` keeps that same "nothing is
 * excluded" reading while the named entry stays available as the concrete
 * opt-in the subagent policy looks for. `*` never counts as naming a tool.
 */
export interface ProfileToolSelection {
  /** The engine's own matcher input: undefined means no added allowlist. */
  readonly allowlist: readonly string[] | undefined;
  /** The written list without the wildcard: what this profile names. */
  readonly names: readonly string[];
  /**
   * Whether this list restricts nothing, so a name added to it must not turn
   * into an allowlist. True for an unwritten field and for a written wildcard.
   */
  readonly unrestricted: boolean;
  /** Whether the wildcard is written, so a later edit keeps writing it. */
  readonly wildcard: boolean;
}

export function readProfileToolSelection(tools: readonly string[] | null): ProfileToolSelection {
  const names = tools === null ? [] : tools.filter((entry) => entry !== TOOL_NAME_WILDCARD);
  const wildcard = tools !== null && tools.includes(TOOL_NAME_WILDCARD);
  return {
    allowlist: tools === null || wildcard ? undefined : names,
    names,
    unrestricted: tools === null || wildcard,
    wildcard,
  };
}

/** One tool's name is a concrete entry of the list, matched the way the engine matches it. */
export function profileNamesTool(selection: ProfileToolSelection, name: string): boolean {
  return isToolExplicitlyNamed(selection.names, name);
}

/**
 * Whether the server rule names this tool, read through the shared matcher so
 * that a name of an older action counts the merged registration the way
 * `isSubagentToolAllowed` counts it. A plain membership test would report a
 * merged tool as closed while the engine has it open.
 */
export function serverNamesTool(serverAllowed: ReadonlySet<string>, name: string): boolean {
  return isToolExplicitlyNamed([...serverAllowed], name);
}

/**
 * The server rule after this tool's opt-in flips. Turning it off removes this
 * tool's own name and the older action names under it, because the row reads as
 * on while any of them is still stored: dropping only the tool's own name would
 * leave the row on and change nothing.
 */
export function serverToolsWithOptIn(
  allowedTools: readonly string[],
  name: string,
  allowed: boolean,
): readonly string[] {
  if (allowed) {
    if (isToolExplicitlyNamed(allowedTools, name)) return allowedTools;
    return [...new Set([...allowedTools, name])];
  }
  return allowedTools.filter((entry) => !entryIsOwnedByTool(entry, name));
}

/**
 * Whether one written entry is this tool's own name, and so may be removed when
 * this tool's opt-in is taken back.
 *
 * The shared matcher answers "does this list grant the tool" and treats the
 * canonical and older names of one tool as equivalent in both directions. That
 * is the right question for reading a row, and the wrong one for writing: the
 * merged registration `Cron` also carries the older actions, so removing it
 * would take away grants this row never spoke for. An entry belongs to this row
 * only when it is the tool's own name or one of the older action names under
 * that name; the merged name above a single action is left alone.
 */
function entryIsOwnedByTool(entry: string, name: string): boolean {
  if (entry === name) return true;
  if (!legacyToolNames(name).includes(entry)) return false;
  return canonicalToolName(entry) === name;
}

/**
 * The list to write after a child opt-in flips. A profile that restricts
 * nothing — an unwritten field or a written `*` — gets the name alongside the
 * wildcard, so ordinary tools stay available; a profile that does restrict
 * already selects by name, so the name simply joins its list and the list stays
 * finite. Entries keep their written order.
 *
 * Turning the opt-in on for a tool this profile already names writes nothing:
 * the list already grants it, and rewriting would drop the existing grant.
 * Turning it off removes this tool's own name and the older action names under
 * it, so the switch actually takes effect whichever of those names was written.
 */
export function profileToolsWithOptIn(
  tools: readonly string[] | null,
  name: string,
  allow: boolean,
): readonly string[] {
  const selection = readProfileToolSelection(tools);
  if (allow) {
    if (profileNamesTool(selection, name)) return tools ?? [];
    return selection.unrestricted
      ? [TOOL_NAME_WILDCARD, ...selection.names, name]
      : [...selection.names, name];
  }
  if (!profileNamesTool(selection, name)) return tools ?? [];
  const kept = selection.names.filter((entry) => !entryIsOwnedByTool(entry, name));
  // A profile that wrote no list never had a grant to take back, so it returns
  // to writing none instead of keeping a list that now says less than it did.
  if (selection.unrestricted && tools === null) return [];
  return selection.wildcard ? [TOOL_NAME_WILDCARD, ...kept] : kept;
}

/**
 * The list to write when a deny is lifted rather than an opt-in flipped. A
 * tool the profile already names stays as written, and a profile that wrote no
 * list keeps writing none: its selection was never the reason the tool was
 * blocked.
 */
export function profileToolsAllowingTool(
  tools: readonly string[] | null,
  name: string,
): readonly string[] | null {
  const selection = readProfileToolSelection(tools);
  if (tools === null || profileNamesTool(selection, name)) return tools;
  return profileToolsWithOptIn(tools, name, true);
}

export interface ToolRowState {
  readonly status: ToolStatus;
  /** Set with `status: 'inherit'`: whether the default rule allows the tool. */
  readonly inheritAllows?: boolean;
  readonly reason: ToolReason;
  readonly action: ToolAction;
}

/**
 * The server-wide rule: only the opt-in tools are configured by it.
 *
 * Its value is a list of names, read through the same matcher the engine uses,
 * so naming an action of a merged tool (`CronList`) counts the merged tool
 * (`Cron`) exactly as `isSubagentToolAllowed` counts it.
 */
export function defaultRuleToolState(
  tool: Pick<ToolDescriptor, 'name' | 'source'>,
  serverAllowed: ReadonlySet<string>,
): ToolRowState {
  const access = subagentToolAccess(tool);
  if (access === 'main-only') return { status: 'fixed', reason: 'main-only', action: null };
  if (access !== 'opt-in') return { status: 'allowed', reason: 'default-allowed', action: null };
  return serverNamesTool(serverAllowed, tool.name)
    ? { status: 'allowed', reason: 'server-opt-in', action: 'opt-in' }
    : { status: 'blocked', reason: 'opt-in-off', action: 'opt-in' };
}

/**
 * One profile's own lists. An untouched tool is not claimed as available: it is
 * `inherit`, and the row says what the default rule decides underneath.
 *
 * A child opt-in is one concrete name. On a profile that writes no allowlist
 * that name rides alongside the wildcard, so it opts this one tool in without
 * restricting anything else; a profile that does restrict keeps its own list.
 */
export function profileToolState(
  tool: Pick<ToolDescriptor, 'name' | 'source'>,
  lists: ProfileToolLists,
  options: { readonly editable: boolean; readonly native: boolean; readonly serverAllowed: ReadonlySet<string> },
): ToolRowState {
  if (!options.native) return { status: 'fixed', reason: 'executor', action: null };
  const access = subagentToolAccess(tool);
  if (access === 'main-only') return { status: 'fixed', reason: 'main-only', action: null };
  const source = policyToolSource(tool.source);
  const selection = readProfileToolSelection(lists.tools);
  const allowlist = selection.allowlist;
  // Membership goes through the shared matcher, so an MCP pattern
  // (`mcp__server__*`) counts exactly as the engine counts it.
  const listed = allowlist !== undefined && isToolActive({ tools: allowlist }, tool.name, source);
  const named = profileNamesTool(selection, tool.name);
  const denyList = lists.disallowedTools;
  const denied = denyList !== null && !isToolActive({ disallowedTools: denyList }, tool.name, source);
  if (denied) {
    // Inline "allow" only when dropping the exact entry really lifts the denial:
    // an MCP pattern or a legacy-equivalent entry that still blocks the tool
    // sends the person to the existing list editor instead.
    const exact = denyList.includes(tool.name);
    const removable = exact && isToolActive(
      { tools: allowlist, disallowedTools: denyList.filter((entry) => entry !== tool.name) },
      tool.name,
      source,
    );
    return {
      status: 'blocked',
      reason: 'profile-denied',
      action: options.editable ? (removable ? 'allow' : 'editor') : null,
    };
  }
  if (allowlist !== undefined && !listed) {
    // The engine reads the profile's own list as a filter over everything else
    // (`isToolActiveComposed` requires both), so a tool this list leaves out is
    // blocked here even when an opt-in named it. That is the finite-list case.
    return { status: 'blocked', reason: 'profile-allowlist', action: options.editable ? 'allow' : null };
  }
  if (access === 'opt-in' && !denied) {
    // Past the list, one opt-in has two grants: this profile naming the tool,
    // or the server rule naming it. The engine takes either, so a profile that
    // leaves the tool out is still open when the server allows it — and this
    // object can only speak for its own name, so it never claims to close the
    // server's grant.
    if (named) {
      return {
        status: 'allowed',
        reason: 'profile-explicit',
        inheritAllows: true,
        action: options.editable ? 'opt-in' : null,
      };
    }
    if (serverNamesTool(options.serverAllowed, tool.name)) {
      return {
        status: 'allowed',
        reason: 'server-opt-in',
        inheritAllows: true,
        // The switch is not offered: it would add a name the server grant
        // already made unnecessary, and unchecking it would change nothing.
        action: null,
      };
    }
    return {
      status: 'blocked',
      reason: 'opt-in-off',
      inheritAllows: false,
      action: options.editable ? 'opt-in' : null,
    };
  }
  if (listed) {
    return {
      status: 'allowed',
      // A named entry is exact; a pattern entry also covers other tools.
      reason: named ? 'profile-explicit' : 'profile-pattern',
      action: options.editable ? 'deny' : null,
    };
  }
  const inheritAllows = access === 'opt-in' ? serverNamesTool(options.serverAllowed, tool.name) : true;
  return {
    status: 'inherit',
    inheritAllows,
    reason: 'inherit',
    action: options.editable ? 'deny' : null,
  };
}

/** Display order: built-in first (the tools a subagent is actually built from), then by source and name. */
const SOURCE_ORDER: readonly ToolDescriptor['source'][] = ['builtin', 'plugin', 'mcp', 'skill'];

export function orderSubagentTools(tools: readonly ToolDescriptor[]): ToolDescriptor[] {
  return [...tools].toSorted((left, right) =>
    SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source)
    || left.name.localeCompare(right.name));
}

/** Order-sensitive list comparison for the two tool lists (order is the written value). */
export function sameToolLists(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** First line of the engine's own description; the detail pane can show the rest. */
export function toolPurpose(tool: Pick<ToolDescriptor, 'description'>): string {
  return tool.description.split('\n', 1)[0]?.trim() ?? '';
}
