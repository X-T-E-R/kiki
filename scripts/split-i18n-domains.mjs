import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const i18nDir = join(rootDir, 'packages', 'session-core', 'src', 'i18n');

const DOMAIN_RULES = [
  {
    name: 'usage',
    exportBase: 'usage',
    match: (key) => key.startsWith('usage.'),
  },
  {
    name: 'capabilities',
    exportBase: 'capabilities',
    match: (key) => /^(cap|skill|plugin|plugins|mcp|extension)\./.test(key),
  },
  {
    name: 'memory',
    exportBase: 'memory',
    match: (key) => key.startsWith('memory.'),
  },
  {
    name: 'composer',
    exportBase: 'composer',
    match: (key) => /^(composer|attach|ia|queue|timing|mention|slash|draft)\./.test(key),
  },
  {
    name: 'transcript',
    exportBase: 'transcript',
    match: (key) => /^(transcript|tc|sv|message|msg|find|fork|locate|tool|diff|code|markdown|annotation|branch|undo|compact)\./.test(key),
  },
  {
    name: 'sidebar',
    exportBase: 'sidebar',
    match: (key) => /^(sidebar|switcher|nav|app|space|session|sessions|archived|search|workspace|work|home|newSession|private)\./.test(key),
  },
  {
    name: 'agent-panel',
    exportBase: 'agentPanel',
    match: (key) => /^(agentPanel|inspector|rail|context|subagent|agent|agentRef|activity|cockpit|loop|diagnostics|runtime)\./.test(key),
  },
  {
    name: 'persona-room',
    exportBase: 'personaRoom',
    match: (key) => /^(persona|room|bot|im|channel)\./.test(key),
  },
  {
    name: 'preview-term',
    exportBase: 'previewTerm',
    match: (key) => /^(preview|term|terminal|media|file|image|editor|lightbox)\./.test(key),
  },
  {
    name: 'cron-tasks',
    exportBase: 'cronTasks',
    match: (key) => /^(cron|taskBoard|task|tasks|goal|plan|todo|schedule)\./.test(key),
  },
  {
    name: 'discovery-onboarding',
    exportBase: 'discoveryOnboarding',
    match: (key) => /^(discovery|onboard|onboarding|setup|wizard|firstRun|welcome|import|update|updater)\./.test(key),
  },
  {
    name: 'st-search',
    exportBase: 'stSearch',
    match: (key) => /^st\.(nbSearch|web|webAccess|search)\./.test(key),
  },
  {
    name: 'st-browser-cua',
    exportBase: 'stBrowserCua',
    match: (key) => /^st\.(browser|computer)\./.test(key),
  },
  {
    name: 'st-im-notify',
    exportBase: 'stImNotify',
    match: (key) => /^st\.(im|notify|channels|inbound|sendMessage|notifications)\./.test(key),
  },
  {
    name: 'st-spaces-remote',
    exportBase: 'stSpacesRemote',
    match: (key) => /^st\.(spaces|remote|ssh|xc|workspaces|conn|connections)\./.test(key),
  },
  {
    name: 'st-agents',
    exportBase: 'stAgents',
    match: (key) => /^st\.(profiles|engines|namedAgents|subagentTools|agents|subagent|agent)\./.test(key),
  },
  {
    name: 'st-ext-recipes',
    exportBase: 'stExtRecipes',
    match: (key) => /^st\.(recipe|hooks|mcp|plugins|skills|extensions)\./.test(key),
  },
  {
    name: 'st-governance',
    exportBase: 'stGovernance',
    match: (key) => /^st\.(identity|decision|settingsTransfer|permissions|permission|security|governance|experimental|flags)\./.test(key),
  },
  {
    name: 'st-core',
    exportBase: 'stCore',
    match: (key) => key.startsWith('st.'),
  },
  {
    name: 'common',
    exportBase: 'common',
    match: () => true,
  },
];

function classifyKey(key) {
  for (const rule of DOMAIN_RULES) {
    if (rule.match(key)) return rule.name;
  }
  return 'common';
}

function quoteSingle(str) {
  return `'${str
    .replaceAll('\\', '\\\\')
    .replaceAll('\'', '\\\'')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')}'`;
}

function renderDomainFile(exportName, entries, asConst) {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = [`export const ${exportName} = {`];
  for (const [k, v] of sorted) {
    lines.push(`  ${quoteSingle(k)}: ${quoteSingle(v)},`);
  }
  lines.push(asConst ? '} as const;' : '} satisfies Record<string, string>;');
  lines.push('');
  return lines.join('\n');
}

const { en: rawEn } = await tsImport(pathToFileURL(join(i18nDir, 'en.ts')).href, import.meta.url);
const { zh: rawZh } = await tsImport(pathToFileURL(join(i18nDir, 'zh.ts')).href, import.meta.url);

const en = { ...rawEn };
const zh = { ...rawZh };

// Ensure missing symmetric key agentRef.runs.one is populated in zh (matching agentRef.runs.other)
if (Object.hasOwn(en, 'agentRef.runs.one') && !Object.hasOwn(zh, 'agentRef.runs.one') && Object.hasOwn(zh, 'agentRef.runs.other')) {
  zh['agentRef.runs.one'] = zh['agentRef.runs.other'];
}

const enBuckets = new Map(DOMAIN_RULES.map((r) => [r.name, []]));
const zhBuckets = new Map(DOMAIN_RULES.map((r) => [r.name, []]));

for (const [k, v] of Object.entries(en)) {
  enBuckets.get(classifyKey(k)).push([k, v]);
}
for (const [k, v] of Object.entries(zh)) {
  zhBuckets.get(classifyKey(k)).push([k, v]);
}

const enDir = join(i18nDir, 'domains', 'en');
const zhDir = join(i18nDir, 'domains', 'zh');
mkdirSync(enDir, { recursive: true });
mkdirSync(zhDir, { recursive: true });

for (const rule of DOMAIN_RULES) {
  const enEntries = enBuckets.get(rule.name);
  const zhEntries = zhBuckets.get(rule.name);
  console.log(`${rule.name.padEnd(22)} en=${String(enEntries.length).padStart(4)}  zh=${String(zhEntries.length).padStart(4)}`);
  writeFileSync(join(enDir, `${rule.name}.ts`), renderDomainFile(`${rule.exportBase}En`, enEntries, true), 'utf8');
  writeFileSync(join(zhDir, `${rule.name}.ts`), renderDomainFile(`${rule.exportBase}Zh`, zhEntries, false), 'utf8');
}

const sortedRules = [...DOMAIN_RULES].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const enEntryLines = [
  '/**',
  ' * English dictionary — aggregated from domain modules under `./domains/en/`.',
  ' * Add new keys to the matching domain file in lexicographical order.',
  ' */',
  ...sortedRules.map((r) => `import { ${r.exportBase}En } from './domains/en/${r.name}';`),
  '',
  'export const enDomains = {',
  ...sortedRules.map((r) => `  '${r.name}': ${r.exportBase}En,`),
  '} as const;',
  '',
  'export const en = {',
  ...sortedRules.map((r) => `  ...${r.exportBase}En,`),
  '} as const;',
  '',
];
writeFileSync(join(i18nDir, 'en.ts'), enEntryLines.join('\n'), 'utf8');

const zhEntryLines = [
  '/**',
  ' * 简体中文词典 — 由 `./domains/zh/` 下的分域模块聚合导出。',
  ' * 新增键请按字典序写入对应域模块，并与 `./domains/en/` 保持键集一致。',
  ' */',
  ...sortedRules.map((r) => `import { ${r.exportBase}Zh } from './domains/zh/${r.name}';`),
  '',
  'export const zhDomains = {',
  ...sortedRules.map((r) => `  '${r.name}': ${r.exportBase}Zh,`),
  '} as const;',
  '',
  'export const zh = {',
  ...sortedRules.map((r) => `  ...${r.exportBase}Zh,`),
  '};',
  '',
];
writeFileSync(join(i18nDir, 'zh.ts'), zhEntryLines.join('\n'), 'utf8');

// Verify lossless round-trip
const { en: checkEn } = await tsImport(`${pathToFileURL(join(i18nDir, 'en.ts')).href}?t=${Date.now()}`, import.meta.url);
const { zh: checkZh } = await tsImport(`${pathToFileURL(join(i18nDir, 'zh.ts')).href}?t=${Date.now()}`, import.meta.url);

let diffs = 0;
for (const [k, v] of Object.entries(en)) {
  if (checkEn[k] !== v) {
    console.error('EN MISMATCH:', k);
    diffs++;
  }
}
for (const [k, v] of Object.entries(zh)) {
  if (checkZh[k] !== v) {
    console.error('ZH MISMATCH:', k);
    diffs++;
  }
}
if (Object.keys(checkEn).length !== Object.keys(en).length || Object.keys(checkZh).length !== Object.keys(zh).length) {
  throw new Error(`Key count mismatch: en=${Object.keys(checkEn).length}/${Object.keys(en).length}, zh=${Object.keys(checkZh).length}/${Object.keys(zh).length}`);
}
if (diffs > 0) throw new Error(`Found ${diffs} value mismatches!`);
console.log(`SUCCESS: split ${Object.keys(checkEn).length} en keys and ${Object.keys(checkZh).length} zh keys across ${DOMAIN_RULES.length} domains with 0 mismatches.`);
