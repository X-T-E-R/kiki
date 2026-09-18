import { describe, expect, it } from 'vitest';

import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { BUILTIN_SKILLS, visibleBuiltinSkills } from '#/app/skillCatalog/builtin/builtin';
import { BuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import { BUILTIN_PRODUCT_SKILLS_SECTION } from '#/app/skillCatalog/configSection';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';

import { stubFlag } from '../flag/stubs';
import { StubConfigService } from '../../kosong/stubs';

const PRODUCT_SKILLS = ['kiki-ops', 'kiki-profile'];
const KIKI_OPS_TRIGGERS = [
  'first-run',
  'provider',
  'default-model',
  'config.toml',
  'tui.toml',
  'websearch',
  'fetchurl',
  'sessions',
  'subagents',
  'background tasks',
  'requirements board',
  'mcp',
  'themes',
  'imports',
];
const NEUTRAL_SKILLS = BUILTIN_SKILLS.map((s) => s.name).filter(
  (name) => !PRODUCT_SKILLS.includes(name),
);

async function loadNames(configured?: boolean): Promise<readonly string[]> {
  const ix = new TestInstantiationService();
  ix.set(
    IConfigService,
    new StubConfigService(
      configured === undefined ? {} : { [BUILTIN_PRODUCT_SKILLS_SECTION]: configured },
    ),
  );
  ix.set(IFlagService, stubFlag(true));
  const source = ix.createInstance(BuiltinSkillSource);
  return (await source.load()).skills.map((s) => s.name);
}

describe('BuiltinSkillSource product-skill switch', () => {
  it('ships exactly the two product-facing builtin skills', () => {
    expect(BUILTIN_SKILLS.map((skill) => skill.name)).toEqual(PRODUCT_SKILLS);
    expect(BUILTIN_SKILLS.every((skill) => skill.productSpecific === true)).toBe(true);
    expect(NEUTRAL_SKILLS).toEqual([]);
  });

  it('keeps kiki-ops broad but narrowly limited to Kiki product operations', () => {
    const ops = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-ops');
    expect(ops?.metadata.disableModelInvocation).not.toBe(true);
    expect(ops?.metadata.isSubSkill).not.toBe(true);
    expect(ops?.description.toLowerCase()).toContain('do not use for ordinary');
    const description = ops?.description.toLowerCase() ?? '';
    for (const trigger of KIKI_OPS_TRIGGERS) {
      expect(description).toContain(trigger);
    }
    expect(BUILTIN_SKILLS.some((skill) => skill.name.startsWith('kiki-ops.'))).toBe(false);
  });

  it('keeps kiki-profile independent and narrow', () => {
    const profile = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-profile');
    expect(profile?.metadata.disableModelInvocation).not.toBe(true);
    expect(profile?.metadata.isSubSkill).not.toBe(true);
    expect(profile?.description.toLowerCase()).toContain('create, modify, or repair');
    expect(profile?.description.toLowerCase()).toContain('do not use merely to select');
    expect(profile?.content).toContain('by default the body is the complete system prompt');
  });

  it('keeps the primary kiki-ops triggers visible in the rendered model listing', () => {
    const catalog = new InMemorySkillCatalog();
    const ops = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-ops');
    expect(ops).toBeDefined();
    catalog.registerBuiltinSkill(ops!);
    const listing = catalog.getModelSkillListing().toLowerCase();
    for (const trigger of KIKI_OPS_TRIGGERS.slice(0, 10)) {
      expect(listing).toContain(trigger);
    }
  });

  it('offers every builtin skill when the section is unset', async () => {
    const names = await loadNames();
    expect(names).toEqual(BUILTIN_SKILLS.map((s) => s.name));
  });

  it('offers every builtin skill when explicitly enabled', async () => {
    const names = await loadNames(true);
    expect(names).toEqual(BUILTIN_SKILLS.map((s) => s.name));
  });

  it('drops product-documentation skills when explicitly disabled', async () => {
    const names = await loadNames(false);
    expect(names).toEqual(NEUTRAL_SKILLS);
    for (const name of PRODUCT_SKILLS) expect(names).not.toContain(name);
  });

  it('exposes the same filter the session-less listings compose with', () => {
    expect(visibleBuiltinSkills(true).map((s) => s.name)).toEqual(
      BUILTIN_SKILLS.map((s) => s.name),
    );
    expect(visibleBuiltinSkills(false).map((s) => s.name)).toEqual(NEUTRAL_SKILLS);
  });

  it('signals a change when the switch is toggled', async () => {
    const config = new StubConfigService({ [BUILTIN_PRODUCT_SKILLS_SECTION]: true });
    const ix = new TestInstantiationService();
    ix.set(IConfigService, config);
    ix.set(IFlagService, stubFlag(true));
    const source = ix.createInstance(BuiltinSkillSource);

    let fired = 0;
    source.onDidChange?.(() => {
      fired += 1;
    });

    await config.replace(BUILTIN_PRODUCT_SKILLS_SECTION, false);
    expect(fired).toBe(1);
    expect((await source.load()).skills.map((s) => s.name)).toEqual(NEUTRAL_SKILLS);

    await config.replace('unrelatedSection', 'x');
    expect(fired).toBe(1);
  });

  it('waits for config readiness before reading the switch', async () => {
    let release = (): void => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loaded = false;
    const config = {
      _serviceBrand: undefined,
      ready,
      get: () => (loaded ? false : undefined),
      onDidSectionChange: () => ({ dispose: () => {} }),
    } as unknown as IConfigService;

    const ix = new TestInstantiationService();
    ix.set(IConfigService, config);
    ix.set(IFlagService, stubFlag(true));
    const source = ix.createInstance(BuiltinSkillSource);

    const loading = source.load();
    loaded = true;
    release();

    const names = (await loading).skills.map((s) => s.name);
    expect(names).toEqual(NEUTRAL_SKILLS);
  });
});
