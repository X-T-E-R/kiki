import fs from 'node:fs';
import path from 'node:path';

const MATRIX_DIR = import.meta.dirname;
const BUILTIN_MATRICES = Object.freeze({
  smoke: path.join(MATRIX_DIR, 'smoke.json'),
  ccp: path.join(MATRIX_DIR, 'ccp.json'),
  full: path.join(MATRIX_DIR, 'ccp.json'),
  'workstation-cliff': path.join(MATRIX_DIR, 'workstation-cliff.json'),
});

const MiB = 1024 * 1024;

export function resolveMatrixFilePath(nameOrPath) {
  if (!nameOrPath || typeof nameOrPath !== 'string') {
    return BUILTIN_MATRICES.smoke;
  }
  const key = nameOrPath.trim().toLowerCase();
  if (Object.hasOwn(BUILTIN_MATRICES, key)) {
    return BUILTIN_MATRICES[key];
  }
  const resolved = path.resolve(nameOrPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Chaos matrix file not found: ${resolved}`);
  }
  return resolved;
}

export function loadChaosMatrix(nameOrPath = 'smoke') {
  const filePath = resolveMatrixFilePath(nameOrPath);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!raw || typeof raw !== 'object' || !raw.tiers || typeof raw.tiers !== 'object') {
    throw new Error(`Invalid chaos matrix at ${filePath}: missing "tiers" object`);
  }
  if (raw.tier !== 'smoke' && raw.tier !== 'full') {
    throw new Error(`Invalid chaos matrix at ${filePath}: tier must be "smoke" or "full", got ${JSON.stringify(raw.tier)}`);
  }
  for (const requiredSection of ['s10', 'p01ColdChild', 'idleCpu', 's17WorkstationCliff']) {
    if (!raw.tiers[requiredSection] || typeof raw.tiers[requiredSection] !== 'object') {
      throw new Error(`Invalid chaos matrix at ${filePath}: missing required tiers.${requiredSection} section`);
    }
  }
  return {
    filePath,
    name: String(raw.name ?? path.basename(filePath, '.json')),
    tier: raw.tier,
    seed: Number.isInteger(raw.seed) ? raw.seed : 20261120,
    censusDate: raw.censusDate ?? null,
    tiers: raw.tiers,
  };
}

export function resolveS10MatrixConfig(matrixOrTier = 'smoke') {
  const matrix = typeof matrixOrTier === 'string' ? loadChaosMatrix(matrixOrTier) : matrixOrTier;
  const s10 = matrix?.tiers?.s10;
  if (!s10 || typeof s10 !== 'object') {
    throw new Error(`Chaos matrix "${matrix?.name ?? 'unknown'}" is missing tiers.s10`);
  }
  const activeChildren = Number(s10.activeChildren);
  const waves = Array.isArray(s10.waves) && s10.waves.length > 0
    ? s10.waves.map(Number)
    : Array.isArray(s10.scaleUpTiers) && s10.scaleUpTiers.length > 0
      ? s10.scaleUpTiers.map(Number)
      : [activeChildren];
  return {
    matrixName: matrix.name,
    tier: matrix.tier,
    turns: Number(s10.turns),
    seededSubagents: Number(s10.seededSubagents),
    activeChildren,
    waves,
    stepsPerChild: Number(s10.stepsPerChild),
    deltasPerStep: Number(s10.deltasPerStep),
    cadenceMs: Number(s10.cadenceMs),
    workspaceFiles: Number(s10.workspaceFiles),
    promptRounds: Number(s10.promptRounds),
  };
}

export function resolveP01MatrixSizes(matrixOrTier = 'smoke') {
  const matrix = typeof matrixOrTier === 'string' ? loadChaosMatrix(matrixOrTier) : matrixOrTier;
  const p01 = matrix?.tiers?.p01ColdChild;
  if (!p01 || !Array.isArray(p01.sizesMiB) || p01.sizesMiB.length === 0) {
    throw new Error(`Chaos matrix "${matrix?.name ?? 'unknown'}" is missing tiers.p01ColdChild.sizesMiB`);
  }
  const sizesMiB = p01.sizesMiB.map(Number);
  const baseSteps = Number(p01.stepCount ?? 200);
  return sizesMiB.map((mib) => ({
    label: `${mib}MB`,
    sizeMiB: mib,
    targetBytes: Math.round(mib * MiB),
    stepCount: mib >= 400 ? Math.max(baseSteps, 360) : mib >= 100 ? Math.max(baseSteps, 300) : mib >= 60 ? Math.max(baseSteps, 200) : Math.min(baseSteps, 120),
  }));
}

export function resolveS17MatrixConfig(matrixOrTier = 'smoke') {
  const matrix = typeof matrixOrTier === 'string' ? loadChaosMatrix(matrixOrTier) : matrixOrTier;
  const cfg = matrix?.tiers?.s17WorkstationCliff;
  if (!cfg || typeof cfg !== 'object') {
    throw new Error(`Chaos matrix "${matrix?.name ?? 'unknown'}" is missing tiers.s17WorkstationCliff`);
  }
  return cfg;
}

export function listBuiltinMatrixNames() {
  return ['smoke', 'ccp', 'workstation-cliff'];
}
