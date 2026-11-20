import { execFileSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeScopedHmac,
  evaluateP04BlindMutationControl,
  verifyScopedHmac,
} from '../verify/verdict.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AST_BUILD_SCRIPT = path.resolve(__dirname, '..', 'workloads', 'ast-build.mjs');

/**
 * Executes Astra v2.3 §10.4 Blind Same-Path HMAC-SHA256 Mutation Control:
 * 4 randomized blind trials per seed (`valid_baseline`, `valid_changed_challenge`,
 * `tampered_tool_return`, `tampered_peer_input`).
 *
 * Producer runs real CPU-bound `ast-build.mjs` over seeded files and signs its output
 * with an isolated per-trial HMAC key. On tampered trials, an isolated tamper injector
 * alters only the consumed payload without ever exposing trial kind or fault flags to
 * the verification-only downstream validator.
 */
export async function runScenarioS12BlindHmacTrials({ workRoot, progress = () => {} }) {
  const runId = `s12_${randomUUID().slice(0, 8)}`;
  const trialDir = path.join(workRoot || os.tmpdir(), `kiki-s12-hmac-${runId}`);
  fs.mkdirSync(trialDir, { recursive: true });
  const scopedKey = randomBytes(32).toString('hex');

  const specs = [
    { hiddenKind: 'valid_baseline', edgeKind: 'tool', stage: 'build', seedOffset: 101, tamper: false },
    { hiddenKind: 'valid_changed_challenge', edgeKind: 'tool', stage: 'build', seedOffset: 709, tamper: false },
    { hiddenKind: 'tampered_tool_return', edgeKind: 'tool', stage: 'build', seedOffset: 307, tamper: true },
    { hiddenKind: 'tampered_peer_input', edgeKind: 'peer', stage: 'recover', seedOffset: 503, tamper: true },
  ];

  // Fisher-Yates shuffle using CSPRNG so validator order is truly blind
  for (let i = specs.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    const tmp = specs[i];
    specs[i] = specs[j];
    specs[j] = tmp;
  }

  progress(`S12 Blind HMAC-SHA256 Control (${runId}): running 4 randomized real ast-build producer/validator trials...`);

  const trials = [];
  try {
    for (let idx = 0; idx < specs.length; idx += 1) {
      const spec = specs[idx];
      const subDir = path.join(trialDir, `trial_${idx}`);
      const srcDir = path.join(subDir, 'src');
      const outDir = path.join(subDir, 'out');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(outDir, { recursive: true });

      const inputFile = `unit_${String(spec.seedOffset).padStart(4, '0')}.ts`;
      fs.writeFileSync(
        path.join(srcDir, inputFile),
        [
          `export const TRIAL_SEED = ${spec.seedOffset};`,
          `export function compute(x: number): number { return ((x ^ ${spec.seedOffset}) * 2654435761) >>> 0; }`,
          '',
        ].join('\n'),
        'utf8',
      );

      const inputAbsPath = path.join(srcDir, inputFile);
      // Real CPU-bound producer via ast-build.mjs
      const rawOut = execFileSync(
        process.execPath,
        [AST_BUILD_SCRIPT, '--files', inputAbsPath, '--out', outDir, '--partitions', '1', '--min-cpu-ms', '40'],
        { encoding: 'utf8', timeout: 30_000 },
      );
      const footerLine = rawOut
        .trim()
        .split('\n')
        .reverse()
        .find((l) => l.startsWith('AST_BUILD_FOOTER '));
      const footer = footerLine ? JSON.parse(footerLine.slice('AST_BUILD_FOOTER '.length)) : null;
      if (!footer?.footerDigest) {
        throw new Error(`ast-build.mjs failed to emit AST_BUILD_FOOTER for trial ${idx}`);
      }

      const producedRecord = {
        version: 'v2.3',
        run: `${runId}_t${idx}`,
        epoch: 1,
        source: `producer_${idx}`,
        destination: `validator_${idx}`,
        edgeKind: spec.edgeKind,
        stage: spec.stage,
        inputIdentity: inputFile,
        resultValue: String(footer.checksum ?? footer.filesProcessed ?? spec.seedOffset),
        artifactDigest: String(footer.footerDigest),
      };
      const tag = computeScopedHmac(scopedKey, producedRecord);

      // Isolated tamper injector: mutates ONLY consumedRecord payload without revealing trial kind
      const consumedRecord = spec.tamper
        ? { ...producedRecord, resultValue: `${producedRecord.resultValue}_mutated` }
        : { ...producedRecord };

      // Verification-only blind downstream validator (sees ONLY scopedKey, consumedRecord, tag)
      const downstreamArtifactPath = path.join(subDir, 'downstream_accepted.json');
      const hmacOk = verifyScopedHmac(scopedKey, consumedRecord, tag);
      let dependentWriteOrForwardOccurred = false;
      let rejectionDiagnostic = null;
      let semanticDownstreamArg = null;

      if (hmacOk) {
        semanticDownstreamArg = `verified_${consumedRecord.resultValue}_${consumedRecord.artifactDigest.slice(0, 12)}`;
        fs.writeFileSync(
          downstreamArtifactPath,
          JSON.stringify({ semanticDownstreamArg, artifactDigest: consumedRecord.artifactDigest }),
          'utf8',
        );
        dependentWriteOrForwardOccurred = fs.existsSync(downstreamArtifactPath);
      } else {
        rejectionDiagnostic = {
          epoch: consumedRecord.epoch,
          source: consumedRecord.source,
          destination: consumedRecord.destination,
          stage: consumedRecord.stage,
          inputIdentity: consumedRecord.inputIdentity,
          failedBinding: 'hmac_mismatch',
        };
      }

      trials.push({
        hiddenKind: spec.hiddenKind,
        record: producedRecord,
        consumedRecord,
        tag,
        validatorAccepted: hmacOk,
        semanticDownstreamArg,
        dependentWriteOrForwardOccurred,
        usedFaultFlagOrTrialName: false,
        rejectionDiagnostic,
      });
    }
  } finally {
    fs.rmSync(trialDir, { recursive: true, force: true });
  }

  const blindControl = { scopedKey, trials };
  const verdict = evaluateP04BlindMutationControl(blindControl);
  progress(
    `S12 Blind HMAC Result: passed=${verdict.passed} exitCode=${verdict.exitCode} trials=${trials.length}`,
  );
  return {
    ...verdict,
    blindControl,
  };
}
