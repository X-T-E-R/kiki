import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUIRED_SKILL_FILES = [
  '.agents/skills/kiki-docs-catchup/SKILL.md',
  '.agents/skills/kiki-docs-catchup/agents/openai.yaml',
  '.agents/skills/kiki-docs-catchup/references/trigger-matrix.md',
  '.agents/skills/kiki-docs-catchup/references/semantic-packet.md',
  '.agents/skills/kiki-docs-catchup/references/mechanical-packet.md',
];

const REQUIRED_SKILL_REFERENCES = REQUIRED_SKILL_FILES.slice(2).map((path) =>
  path.replace('.agents/skills/kiki-docs-catchup/', ''),
);

function slash(path) {
  return path.split(sep).join('/');
}

function walkFiles(dir, predicate) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path, predicate));
    else if (entry.isFile() && predicate(path)) files.push(path);
  }
  return files;
}

function markdownFiles(localeRoot) {
  return walkFiles(localeRoot, (path) => path.endsWith('.md'))
    .map((path) => slash(relative(localeRoot, path)))
    .sort();
}

function outsideFences(markdown) {
  const lines = markdown.split(/\r?\n/);
  let fence;
  return lines.map((line) => {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (match) {
      const marker = match[1][0];
      const width = match[1].length;
      if (fence === undefined) fence = { marker, width };
      else if (marker === fence.marker && width >= fence.width) fence = undefined;
      return '';
    }
    return fence === undefined ? line : '';
  });
}

function headingLevels(markdown) {
  const levels = [];
  for (const line of outsideFences(markdown)) {
    const heading = line.match(/^\s{0,3}(#{1,6})(?:\s+|$)/);
    if (heading) levels.push(heading[1].length);
  }
  return levels;
}

function frontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const values = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (field) values.set(field[1], field[2].replace(/^['"]|['"]$/g, ''));
  }
  return values;
}

function resolveLinkTarget(repoRoot, sourcePath, rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  if (
    target === '' ||
    target.startsWith('#') ||
    target.startsWith('/') ||
    target.startsWith('//') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)
  ) {
    return undefined;
  }

  target = target.split('#', 1)[0].split('?', 1)[0];
  try {
    target = decodeURIComponent(target);
  } catch {
    return { candidates: [], invalidEncoding: true };
  }

  const base = resolve(dirname(sourcePath), target);
  const repo = resolve(repoRoot);
  const withinRepo = base === repo || base.startsWith(`${repo}${sep}`);
  if (!withinRepo) return { candidates: [base], outsideRepo: true };

  const candidates = [base];
  if (!target.endsWith('.md')) candidates.push(`${base}.md`);
  candidates.push(join(base, 'index.md'));
  return { candidates };
}

function markdownLinkTargets(markdown) {
  const text = outsideFences(markdown)
    .map((line) => line.replace(/`[^`\r\n]*`/g, ''))
    .join('\n');
  const targets = [];
  const inline = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  for (const match of text.matchAll(inline)) targets.push(match[1]);
  const definitions = /^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm;
  for (const match of text.matchAll(definitions)) targets.push(match[1]);
  return targets;
}

function pageCandidates(docsRoot, sitePath) {
  const clean = sitePath.split('#', 1)[0].split('?', 1)[0].replace(/^\//, '');
  const base = resolve(docsRoot, clean);
  return [base, `${base}.md`, join(base, 'index.md')];
}

function localeRelativeNavTarget(sitePath) {
  const clean = sitePath.split('#', 1)[0].split('?', 1)[0];
  const match = clean.match(/^\/(en|zh)(?:\/(.*))?$/);
  if (!match) return undefined;
  let target = (match[2] ?? '').replace(/\/$/, '').replace(/\.(?:md|html)$/, '');
  if (target === 'index') target = '';
  else if (target.endsWith('/index')) target = target.slice(0, -'/index'.length);
  return { locale: match[1], target };
}

function addError(errors, code, path, message) {
  errors.push({ code, path: slash(path), message });
}

export function checkDocsGovernance(repoRoot) {
  const root = resolve(repoRoot);
  const docsRoot = join(root, 'docs');
  const enRoot = join(docsRoot, 'en');
  const zhRoot = join(docsRoot, 'zh');
  const errors = [];

  if (!existsSync(enRoot)) addError(errors, 'mirror-missing', 'docs/en', 'English locale root is missing');
  if (!existsSync(zhRoot)) addError(errors, 'mirror-missing', 'docs/zh', 'Chinese locale root is missing');

  const enFiles = markdownFiles(enRoot);
  const zhFiles = markdownFiles(zhRoot);
  const enSet = new Set(enFiles);
  const zhSet = new Set(zhFiles);
  for (const path of enFiles) {
    if (!zhSet.has(path)) addError(errors, 'mirror-missing', `docs/zh/${path}`, 'missing mirror for English page');
  }
  for (const path of zhFiles) {
    if (!enSet.has(path)) addError(errors, 'mirror-missing', `docs/en/${path}`, 'missing mirror for Chinese page');
  }

  for (const path of enFiles.filter((item) => zhSet.has(item))) {
    const enHeadings = headingLevels(readFileSync(join(enRoot, path), 'utf8'));
    const zhHeadings = headingLevels(readFileSync(join(zhRoot, path), 'utf8'));
    if (enHeadings.join(',') !== zhHeadings.join(',')) {
      addError(
        errors,
        'heading-structure',
        `docs/${path}`,
        `heading levels differ: en=[${enHeadings.join(',')}] zh=[${zhHeadings.join(',')}]`,
      );
    }
  }

  for (const sourcePath of [enRoot, zhRoot].flatMap((localeRoot) =>
    walkFiles(localeRoot, (path) => path.endsWith('.md'))
  )) {
    const markdown = readFileSync(sourcePath, 'utf8');
    for (const target of markdownLinkTargets(markdown)) {
      const resolution = resolveLinkTarget(root, sourcePath, target);
      if (resolution === undefined) continue;
      if (resolution.invalidEncoding) {
        addError(errors, 'relative-link', relative(root, sourcePath), `invalid URL encoding in ${target}`);
      } else if (resolution.outsideRepo) {
        addError(errors, 'relative-link', relative(root, sourcePath), `relative link escapes the repository: ${target}`);
      } else if (!resolution.candidates.some((path) => existsSync(path) && statSync(path).isFile())) {
        addError(errors, 'relative-link', relative(root, sourcePath), `unresolved relative link: ${target}`);
      }
    }
  }

  const configPath = join(docsRoot, '.vitepress', 'config.ts');
  if (!existsSync(configPath)) {
    addError(errors, 'nav-target', 'docs/.vitepress/config.ts', 'missing VitePress locale navigation config');
  } else {
    const config = readFileSync(configPath, 'utf8');
    const localeLink = /\blink\s*:\s*['"](\/(?:en|zh)(?:\/[^'"]*)?)['"]/g;
    const linkedLocales = new Set();
    const localeTargets = { en: new Set(), zh: new Set() };
    for (const match of config.matchAll(localeLink)) {
      const normalized = localeRelativeNavTarget(match[1]);
      linkedLocales.add(normalized.locale);
      localeTargets[normalized.locale].add(normalized.target);
      if (!pageCandidates(docsRoot, match[1]).some((path) => existsSync(path) && statSync(path).isFile())) {
        addError(errors, 'nav-target', 'docs/.vitepress/config.ts', `unresolved locale navigation target: ${match[1]}`);
      }
    }
    for (const locale of ['en', 'zh']) {
      if (!linkedLocales.has(locale)) {
        addError(errors, 'nav-target', 'docs/.vitepress/config.ts', `no ${locale} locale navigation target was found`);
      }
    }
    for (const target of localeTargets.en) {
      if (!localeTargets.zh.has(target)) {
        addError(errors, 'nav-mirror', 'docs/.vitepress/config.ts', `English navigation target has no Chinese mirror: /${String(target)}`);
      }
    }
    for (const target of localeTargets.zh) {
      if (!localeTargets.en.has(target)) {
        addError(errors, 'nav-mirror', 'docs/.vitepress/config.ts', `Chinese navigation target has no English mirror: /${String(target)}`);
      }
    }
  }

  for (const path of REQUIRED_SKILL_FILES) {
    if (!existsSync(join(root, path))) addError(errors, 'required-resource', path, 'required docs catch-up skill resource is missing');
  }

  const skillPath = join(root, REQUIRED_SKILL_FILES[0]);
  if (existsSync(skillPath)) {
    const skill = readFileSync(skillPath, 'utf8');
    const metadata = frontmatter(skill);
    if (metadata === undefined) {
      addError(errors, 'skill-frontmatter', REQUIRED_SKILL_FILES[0], 'SKILL.md frontmatter is missing');
    } else {
      if (metadata.get('name') !== 'kiki-docs-catchup') {
        addError(errors, 'skill-frontmatter', REQUIRED_SKILL_FILES[0], 'frontmatter name must be kiki-docs-catchup');
      }
      if (!metadata.get('description')) {
        addError(errors, 'skill-frontmatter', REQUIRED_SKILL_FILES[0], 'frontmatter description is missing');
      }
    }
    for (const resource of REQUIRED_SKILL_REFERENCES) {
      if (!skill.includes(resource)) {
        addError(errors, 'required-resource', REQUIRED_SKILL_FILES[0], `SKILL.md does not route ${resource}`);
      }
    }
  }

  return errors;
}

export function formatDocsGovernanceResult(errors) {
  if (errors.length === 0) {
    return 'Docs governance structural check passed. Semantic correctness was not assessed.';
  }
  return [
    'Docs governance structural check failed. Semantic correctness was not assessed.',
    ...errors.map((error) => `- [${error.code}] ${error.path}: ${error.message}`),
  ].join('\n');
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const repoRoot = process.argv[2] === undefined
    ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
    : resolve(process.argv[2]);
  const errors = checkDocsGovernance(repoRoot);
  console.log(formatDocsGovernanceResult(errors));
  if (errors.length > 0) process.exitCode = 1;
}
