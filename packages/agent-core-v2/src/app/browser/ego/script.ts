import { analyzeEgoScriptBindings, type EgoScriptBindingAnalysis } from './scriptBindings';

export { analyzeEgoScriptBindings, type EgoScriptBindingAnalysis };

export interface EgoBound {
  readonly spaceId?: number | string;
  readonly name: string;
  readonly label?: string;
  readonly profileId?: string;
  readonly connectionId: string;
  readonly url?: string;
}

export const PRELUDE = 'KIKI_EGO_PRELUDE ';
export const FINISH = 'KIKI_EGO_FINISH ';
export const TABS = 'KIKI_EGO_TABS ';
export const PAGE = 'KIKI_EGO_PAGE ';
export const OWNED = 'KIKI_EGO_OWNED ';
export const REFUSED = 'KIKI_EGO_REFUSED';

export function egoNumericSpaceId(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function serializeBound(bound: EgoBound): string {
  const spaceId = egoNumericSpaceId(bound.spaceId);
  return JSON.stringify(JSON.stringify({
    spaceId,
    name: bound.name,
    label: bound.label,
    profileId: bound.profileId,
    connectionId: bound.connectionId,
    url: bound.url,
  }));
}

function egoRuntimeHooksLines(): string[] {
  return [
    'const __kikiCreatedSpaceIds = new Set();',
    'let __kikiOwnedPrinted = false;',
    'let __kikiExitHooked = false;',
    `const __kikiEmitOwned = () => { if (__kikiExitHooked && typeof process === "object" && process !== null && typeof process.removeListener === "function") { __kikiExitHooked = false; process.removeListener("exit", __kikiEmitOwned); } if (__kikiOwnedPrinted || __kikiCreatedSpaceIds.size === 0) return; __kikiOwnedPrinted = true; console.log(${JSON.stringify(OWNED)} + JSON.stringify({ spaceIds: [...__kikiCreatedSpaceIds] })); };`,
    'const __kikiIsBlankTabUrl = (url) => typeof url !== "string" || url.trim() === "" || /^(?:about:blank|chrome:\\/\\/newtab\\/?|chrome:\\/\\/new-tab-page\\/?)$/i.test(url.trim());',
    'const __kikiCloseBlankUnknownTabs = async (space) => {',
    '  if (!space || typeof space.tabs !== "function" || typeof space.cdp !== "function") return;',
    '  const tabs = await space.tabs().catch(() => undefined);',
    '  if (!Array.isArray(tabs) || tabs.length === 0) return;',
    '  if (tabs.some((tab) => tab && tab.openedBy !== "agent" && !__kikiIsBlankTabUrl(tab.url))) return;',
    '  for (const tab of tabs) {',
    '    if (tab && tab.openedBy !== "agent" && __kikiIsBlankTabUrl(tab.url) && typeof tab.targetId === "string" && tab.targetId !== "") {',
    '      await space.cdp("Target.closeTarget", { targetId: tab.targetId }).catch(() => undefined);',
    '    }',
    '  }',
    '};',
    'const __kikiWrapSpace = (space) => {',
    '  if (!space || typeof space !== "object" || space.__kikiWrapped === true) return space;',
    '  Object.defineProperty(space, "__kikiWrapped", { value: true, configurable: true });',
    '  if (typeof space.finish === "function") {',
    '    const origFinish = space.finish.bind(space);',
    '    space.finish = async (options) => {',
    '      const closeAll = options !== null && typeof options === "object" && Array.isArray(options.keep) && options.keep.length === 0;',
    '      if (closeAll) await __kikiCloseBlankUnknownTabs(space);',
    '      try {',
    '        const out = await origFinish(options);',
    '        if (closeAll) __kikiCreatedSpaceIds.delete(Number(space.spaceId ?? space.id));',
    '        return out;',
    '      } catch (error) {',
    '        if (!closeAll) throw error;',
    '        const sid = Number(space.spaceId ?? space.id);',
    '        const alive = typeof listTaskSpaces === "function" && Number.isSafeInteger(sid)',
    '          ? (await listTaskSpaces().catch(() => [])).some((item) => item && item.closed !== true && Number(item.spaceId ?? item.id) === sid)',
    '          : true;',
    '        if (alive) throw error;',
    '        __kikiCreatedSpaceIds.delete(sid);',
    '        try { Object.defineProperty(space, "closed", { value: true, configurable: true }); } catch {}',
    '        return { closed: true };',
    '      }',
    '    };',
    '  }',
    '  return space;',
    '};',
    'const __kikiWrapTaskSpaceFn = (orig) => async (target, ...rest) => {',
    '  const targetName = typeof target === "string" ? target : (target !== null && typeof target === "object" && typeof target.name === "string" ? target.name : undefined);',
    '  let existed = true;',
    '  if (targetName !== undefined && targetName !== __kikiBound.name && typeof listTaskSpaces === "function") {',
    '    const before = await listTaskSpaces().catch(() => undefined);',
    '    if (Array.isArray(before)) existed = before.some((item) => item && item.closed !== true && item.name === targetName);',
    '  }',
    '  const opened = __kikiWrapSpace(await orig(target, ...rest));',
    '  if (!existed) {',
    '    const sid = Number(opened && (opened.spaceId ?? opened.id));',
    '    if (Number.isSafeInteger(sid) && sid >= 0) {',
    '      __kikiCreatedSpaceIds.add(sid);',
    '      if (!__kikiExitHooked && typeof process === "object" && process !== null && typeof process.once === "function") { __kikiExitHooked = true; process.once("exit", __kikiEmitOwned); }',
    '    }',
    '  }',
    '  return opened;',
    '};',
    'if (typeof globalThis.taskSpace === "function") globalThis.taskSpace = __kikiWrapTaskSpaceFn(globalThis.taskSpace);',
    'if (typeof globalThis.ego === "object" && globalThis.ego !== null && typeof globalThis.ego.taskSpace === "function") {',
    '  globalThis.ego.taskSpace = __kikiWrapTaskSpaceFn(globalThis.ego.taskSpace.bind(globalThis.ego));',
    '}',
  ];
}

function egoOpenTaskLines(): string[] {
  return [
    'const __kikiOpenTask = async () => {',
    '  const spaces = typeof listTaskSpaces === "function" ? await listTaskSpaces() : undefined;',
    '  const id = typeof __kikiBound.spaceId === "number" && Number.isSafeInteger(__kikiBound.spaceId) && __kikiBound.spaceId >= 0',
    '    ? __kikiBound.spaceId',
    '    : typeof __kikiBound.spaceId === "string" && /^\\d+$/.test(__kikiBound.spaceId) ? Number(__kikiBound.spaceId) : undefined;',
    '  if (id !== undefined) {',
    '    if (!Array.isArray(spaces)) return await taskSpace(id);',
    '    const live = spaces.find((item) => item !== null && typeof item === "object" && item.closed !== true && Number(item.spaceId ?? item.id) === id);',
    '    if (live) return await taskSpace(id);',
    '  }',
    '  const byName = Array.isArray(spaces)',
    '    ? spaces.find((item) => item !== null && typeof item === "object" && item.closed !== true && item.name === __kikiBound.name)',
    '    : undefined;',
    '  const existingId = byName && byName.ownership === "agent" ? Number(byName.spaceId ?? byName.id) : NaN;',
    '  if (Number.isSafeInteger(existingId) && existingId >= 0) return await taskSpace(existingId);',
    '  if (!byName && typeof __kikiBound.profileId === "string" && __kikiBound.profileId !== "") {',
    '    return await taskSpace(__kikiBound.name, { profileId: __kikiBound.profileId });',
    '  }',
    '  return await taskSpace(__kikiBound.name);',
    '};',
    'const task = await __kikiOpenTask();',
  ];
}

export function egoPrelude(bound: EgoBound, includePage = true): string {
  const lines = [
    `const __kikiBound = JSON.parse(${serializeBound(bound)});`,
    ...egoRuntimeHooksLines(),
    ...egoOpenTaskLines(),
  ];
  if (includePage && bound.label !== undefined && bound.label !== '') lines.push('const page = task.page(__kikiBound.label);');
  lines.push(`console.log(${JSON.stringify(PRELUDE)} + JSON.stringify({ spaceId: task.spaceId ?? task.id, name: task.name, closed: task.closed === true }));`);
  return lines.join('\n');
}

export function egoProgram(bound: EgoBound, body: string, shotDir?: string): string {
  const analysis = analyzeEgoScriptBindings(body);
  const hasLabel = bound.label !== undefined && bound.label !== '';
  const needsPage = hasLabel && !analysis.declaresTopLevelPage && (analysis.usesFreePage || analysis.usesFreeEval);
  const needsTask = !analysis.declaresTopLevelTask && (analysis.usesFreeTask || needsPage || analysis.usesFreeEval);
  const shot = shotDir === undefined || shotDir === '' ? '' : `const shotDir = ${JSON.stringify(shotDir)};\n`;
  if (!needsTask) {
    const header = [
      `const __kikiBound = JSON.parse(${serializeBound(bound)});`,
      ...egoRuntimeHooksLines(),
    ].join('\n');
    return `${header}\n${shot}${body}\n__kikiEmitOwned();\n`;
  }
  return `${egoPrelude(bound, needsPage)}\n${shot}${body}\n__kikiEmitOwned();\nconsole.log(${JSON.stringify(FINISH)} + JSON.stringify({ spaceId: task.spaceId ?? task.id, closed: task.closed === true }));\n`;
}

export function egoCleanupScript(input: { readonly name: string; readonly spaceIds: readonly number[] }): string {
  const payload = JSON.stringify(JSON.stringify({ name: input.name, spaceIds: input.spaceIds }));
  return [
    `const __kikiBound = JSON.parse(${payload});`,
    ...egoRuntimeHooksLines(),
    'const __kikiSpaces = typeof listTaskSpaces === "function" ? await listTaskSpaces() : [];',
    'const __kikiWantedIds = new Set(Array.isArray(__kikiBound.spaceIds) ? __kikiBound.spaceIds : []);',
    'for (const __kikiEntry of Array.isArray(__kikiSpaces) ? __kikiSpaces : []) {',
    '  if (!__kikiEntry || typeof __kikiEntry !== "object" || __kikiEntry.closed === true) continue;',
    '  if (__kikiEntry.ownership !== "agent") continue;',
    '  const __kikiSid = Number(__kikiEntry.spaceId ?? __kikiEntry.id);',
    '  if (!Number.isSafeInteger(__kikiSid) || __kikiSid < 0) continue;',
    '  if (!__kikiWantedIds.has(__kikiSid) && __kikiEntry.name !== __kikiBound.name) continue;',
    '  const __kikiSpace = await taskSpace(__kikiSid);',
    '  await __kikiCloseBlankUnknownTabs(__kikiSpace);',
    '  await __kikiSpace.finish({ keep: [] }).catch(() => undefined);',
    '}',
    'const __kikiAfter = typeof listTaskSpaces === "function" ? await listTaskSpaces().catch(() => []) : [];',
    'const __kikiStillAlive = (Array.isArray(__kikiAfter) ? __kikiAfter : [])',
    '  .filter((item) => item && typeof item === "object" && item.closed !== true)',
    '  .map((item) => ({ id: Number(item.spaceId ?? item.id), name: item.name }))',
    '  .filter((item) => Number.isSafeInteger(item.id) && item.id >= 0 && (__kikiWantedIds.has(item.id) || item.name === __kikiBound.name))',
    '  .map((item) => item.id);',
    `console.log(${JSON.stringify(OWNED)} + JSON.stringify({ spaceIds: __kikiStillAlive }));`,
    `console.log(${JSON.stringify(FINISH)} + JSON.stringify({ closed: __kikiStillAlive.length === 0 }));`,
    '',
  ].join('\n');
}
