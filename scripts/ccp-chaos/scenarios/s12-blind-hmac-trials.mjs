import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { evaluateP04BlindMutationControl } from '../verify/verdict.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AST_BUILD_SCRIPT = path.resolve(__dirname, '..', 'workloads', 'ast-build.mjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeToolPlan(plan) {
  return `[V23_TOOL_PLAN:${Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url')}]`;
}

async function apiJson(endpoint, token, method, urlPath, body, timeoutMs = 25_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}${urlPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForSessionIdle(endpoint, token, sessionId, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const st = await apiJson(endpoint, token, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/status`, undefined, 10_000);
    const data = st.json?.data ?? null;
    if (st.status === 200 && data) {
      const busy =
        data.busy === true ||
        data.executing === true ||
        data.main_turn_active === true ||
        data.state === 'running' ||
        data.loop?.status === 'running';
      if (!busy) return true;
    }
    await sleep(100);
  }
  return false;
}

/**
 * Executes Astra v2.3 §10.4 Blind Same-Path HMAC-SHA256 Mutation Control
 * through REAL kap-server twin-backed producer & validator sessions running real Bash tools:
 *  - Producer session executes real Bash running `ast-build.mjs` and signs the canonical record.
 *  - Isolated transit proxy mutates ONLY the consumed payload on tampered trials without leaking trial kind/flags.
 *  - Validator session executes real Bash running a pure verification-only HMAC script that writes
 *    `downstream_accepted.json` ONLY when HMAC verifies (or writes structured rejection diagnostic JSON).
 *  - Hidden trial labels remain sealed until all 4 sessions finish.
 */
export async function runScenarioS12BlindHmacTrials({ server, corpus, workRoot, progress = () => {} }) {
  const runId = `s12_${randomUUID().slice(0, 8)}`;
  const trialDir = path.join(workRoot || corpus?.rootDir || os.tmpdir(), `kiki-s12-hmac-${runId}`);
  fs.mkdirSync(trialDir, { recursive: true });
  const scopedKey = randomBytes(32).toString('hex');
  const keyFile = path.join(trialDir, 'scoped.key');
  fs.writeFileSync(keyFile, scopedKey, 'utf8');

  // Producer helper script invoked inside real Kiki Bash tool
  const producerScript = path.join(trialDir, 'run-producer.mjs');
  fs.writeFileSync(
    producerScript,
    [
      'import { execFileSync } from "node:child_process";',
      'import { createHmac } from "node:crypto";',
      'import fs from "node:fs";',
      'const args = process.argv.slice(2);',
      'const get = (k) => args[args.indexOf(k) + 1];',
      'const astScript = get("--ast");',
      'const inputAbs = get("--input");',
      'const outDir = get("--out-dir");',
      'const key = fs.readFileSync(get("--key-file"), "utf8").trim();',
      'const meta = JSON.parse(fs.readFileSync(get("--meta"), "utf8"));',
      'const rawOut = execFileSync(process.execPath, [astScript, "--files", inputAbs, "--out", outDir, "--partitions", "1", "--min-cpu-ms", "40"], { encoding: "utf8", timeout: 30000 });',
      'const footerLine = rawOut.trim().split("\\n").reverse().find((l) => l.startsWith("AST_BUILD_FOOTER "));',
      'const footer = footerLine ? JSON.parse(footerLine.slice("AST_BUILD_FOOTER ".length)) : null;',
      'if (!footer?.footerDigest) throw new Error("missing AST_BUILD_FOOTER");',
      'const record = {',
      '  version: "v2.3",',
      '  run: meta.run,',
      '  epoch: 1,',
      '  source: meta.source,',
      '  destination: meta.destination,',
      '  edgeKind: meta.edgeKind,',
      '  stage: meta.stage,',
      '  inputIdentity: meta.inputIdentity,',
      '  resultValue: String(footer.checksum ?? footer.filesProcessed ?? meta.seedOffset),',
      '  artifactDigest: String(footer.footerDigest),',
      '};',
      'const payload = JSON.stringify([record.version, record.run, Number(record.epoch), record.source, record.destination, record.edgeKind, record.stage, record.inputIdentity, record.resultValue, record.artifactDigest]);',
      'const tag = createHmac("sha256", Buffer.from(key, "utf8")).update(payload, "utf8").digest("hex");',
      'fs.writeFileSync(get("--produced-out"), JSON.stringify({ record, tag }, null, 2), "utf8");',
      'process.stdout.write(JSON.stringify({ ok: true, artifactDigest: record.artifactDigest }) + "\\n");',
    ].join('\n'),
    'utf8',
  );

  // Pure verification-only blind validator script invoked inside real Kiki Bash tool
  const validatorScript = path.join(trialDir, 'run-validator.mjs');
  fs.writeFileSync(
    validatorScript,
    [
      'import { createHmac, timingSafeEqual } from "node:crypto";',
      'import fs from "node:fs";',
      'const args = process.argv.slice(2);',
      'const get = (k) => args[args.indexOf(k) + 1];',
      'const key = fs.readFileSync(get("--key-file"), "utf8").trim();',
      'const envelope = JSON.parse(fs.readFileSync(get("--envelope"), "utf8"));',
      'const downstreamPath = get("--downstream-out");',
      'const reportPath = get("--report-out");',
      'const r = envelope.consumedRecord;',
      'const payload = JSON.stringify([String(r.version), String(r.run), Number(r.epoch), String(r.source), String(r.destination), String(r.edgeKind), String(r.stage), String(r.inputIdentity), String(r.resultValue), String(r.artifactDigest)]);',
      'const expected = createHmac("sha256", Buffer.from(key, "utf8")).update(payload, "utf8").digest("hex");',
      'const a = Buffer.from(expected, "hex");',
      'const b = Buffer.from(String(envelope.tag ?? ""), "hex");',
      'const ok = a.length === b.length && timingSafeEqual(a, b);',
      'let semanticDownstreamArg = null;',
      'let rejectionDiagnostic = null;',
      'if (ok) {',
      '  semanticDownstreamArg = `verified_${r.resultValue}_${r.artifactDigest.slice(0, 12)}`;',
      '  fs.writeFileSync(downstreamPath, JSON.stringify({ semanticDownstreamArg, artifactDigest: r.artifactDigest }), "utf8");',
      '} else {',
      '  rejectionDiagnostic = {',
      '    epoch: r.epoch,',
      '    source: r.source,',
      '    destination: r.destination,',
      '    stage: r.stage,',
      '    inputIdentity: r.inputIdentity,',
      '    failedBinding: "hmac_mismatch",',
      '  };',
      '}',
      'fs.writeFileSync(reportPath, JSON.stringify({ validatorAccepted: ok, semanticDownstreamArg, rejectionDiagnostic }, null, 2), "utf8");',
      'process.stdout.write(JSON.stringify({ validatorAccepted: ok }) + "\\n");',
    ].join('\n'),
    'utf8',
  );

  const sealedSpecs = [
    { hiddenKind: 'valid_baseline', edgeKind: 'tool', stage: 'build', seedOffset: 101, tamper: false },
    { hiddenKind: 'valid_changed_challenge', edgeKind: 'tool', stage: 'build', seedOffset: 709, tamper: false },
    { hiddenKind: 'tampered_tool_return', edgeKind: 'tool', stage: 'build', seedOffset: 307, tamper: true },
    { hiddenKind: 'tampered_peer_input', edgeKind: 'peer', stage: 'recover', seedOffset: 503, tamper: true },
  ];

  // CSPRNG Fisher-Yates shuffle
  for (let i = sealedSpecs.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    const tmp = sealedSpecs[i];
    sealedSpecs[i] = sealedSpecs[j];
    sealedSpecs[j] = tmp;
  }

  progress(`S12 Blind HMAC-SHA256 Control (${runId}): executing 4 shuffled trials through real kap-server producer & validator Bash turns...`);

  const rawOutcomes = [];
  try {
    for (let idx = 0; idx < sealedSpecs.length; idx += 1) {
      const spec = sealedSpecs[idx];
      const subDir = path.join(trialDir, `trial_${idx}`);
      const srcDir = path.join(subDir, 'src');
      const outDir = path.join(subDir, 'out');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(outDir, { recursive: true });

      const inputFile = `unit_${String(spec.seedOffset).padStart(4, '0')}.ts`;
      const inputAbsPath = path.join(srcDir, inputFile);
      fs.writeFileSync(
        inputAbsPath,
        [
          `export const TRIAL_SEED = ${spec.seedOffset};`,
          `export function compute(x: number): number { return ((x ^ ${spec.seedOffset}) * 2654435761) >>> 0; }`,
          '',
        ].join('\n'),
        'utf8',
      );

      const metaPath = path.join(subDir, 'meta.json');
      const producedPath = path.join(subDir, 'produced.json');
      const transitEnvelopePath = path.join(subDir, 'transit_envelope.json');
      const downstreamArtifactPath = path.join(subDir, 'downstream_accepted.json');
      const validatorReportPath = path.join(subDir, 'validator_report.json');
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          run: `${runId}_t${idx}`,
          source: `producer_${idx}`,
          destination: `validator_${idx}`,
          edgeKind: spec.edgeKind,
          stage: spec.stage,
          inputIdentity: inputFile,
          seedOffset: spec.seedOffset,
        }),
        'utf8',
      );

      // Create real producer & validator sessions on kap-server
      const [prodSess, valSess] = await Promise.all([
        apiJson(server.endpoint, server.token, 'POST', '/api/sessions', { work_dir: subDir, title: `S12 Producer ${runId} #${idx}` }),
        apiJson(server.endpoint, server.token, 'POST', '/api/sessions', { work_dir: subDir, title: `S12 Validator ${runId} #${idx}` }),
      ]);
      const prodSid = prodSess.json?.data?.id;
      const valSid = valSess.json?.data?.id;
      if (!prodSid || !valSid) {
        throw new Error(`S12 failed to create real sessions for trial ${idx}`);
      }

      // Producer turn via real Bash tool
      const q = (p) => JSON.stringify(p.replaceAll('\\', '/'));
      const prodCmd = `${q(process.execPath)} ${q(producerScript)} --ast ${q(AST_BUILD_SCRIPT)} --input ${q(inputAbsPath)} --out-dir ${q(outDir)} --key-file ${q(keyFile)} --meta ${q(metaPath)} --produced-out ${q(producedPath)}`;
      const prodPlan = {
        steps: [{ calls: [{ name: 'Bash', input: { command: prodCmd, description: `S12 producer #${idx}` } }] }],
        finalText: `S12 producer #${idx} complete.`,
      };
      await apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(prodSid)}/prompts`, {
        prompt_id: `p_s12_prod_${runId}_${idx}`,
        content: [{ type: 'text', text: `${encodeToolPlan(prodPlan)} Produce HMAC artifact #${idx}.` }],
      });
      await waitForSessionIdle(server.endpoint, server.token, prodSid, 30_000);
      if (!fs.existsSync(producedPath)) {
        throw new Error(`S12 producer Bash turn did not emit ${producedPath}`);
      }
      const produced = JSON.parse(fs.readFileSync(producedPath, 'utf8'));

      // Isolated transit tamper proxy: mutates ONLY consumedRecord payload without leaking trial kind/flags
      const consumedRecord = spec.tamper
        ? { ...produced.record, resultValue: `${produced.record.resultValue}_mutated` }
        : { ...produced.record };
      fs.writeFileSync(
        transitEnvelopePath,
        JSON.stringify({ consumedRecord, tag: produced.tag }, null, 2),
        'utf8',
      );

      // Validator turn via real Bash tool (sees ONLY keyFile, transitEnvelopePath, downstreamArtifactPath)
      const valCmd = `${q(process.execPath)} ${q(validatorScript)} --key-file ${q(keyFile)} --envelope ${q(transitEnvelopePath)} --downstream-out ${q(downstreamArtifactPath)} --report-out ${q(validatorReportPath)}`;
      const valPlan = {
        steps: [{ calls: [{ name: 'Bash', input: { command: valCmd, description: `S12 validator #${idx}` } }] }],
        finalText: `S12 validator #${idx} complete.`,
      };
      await apiJson(server.endpoint, server.token, 'POST', `/api/sessions/${encodeURIComponent(valSid)}/prompts`, {
        prompt_id: `p_s12_val_${runId}_${idx}`,
        content: [{ type: 'text', text: `${encodeToolPlan(valPlan)} Validate HMAC artifact #${idx}.` }],
      });
      await waitForSessionIdle(server.endpoint, server.token, valSid, 30_000);
      if (!fs.existsSync(validatorReportPath)) {
        throw new Error(`S12 validator Bash turn did not emit ${validatorReportPath}`);
      }
      const valReport = JSON.parse(fs.readFileSync(validatorReportPath, 'utf8'));
      rawOutcomes.push({
        idx,
        producerSessionId: prodSid,
        validatorSessionId: valSid,
        record: produced.record,
        consumedRecord,
        tag: produced.tag,
        validatorAccepted: Boolean(valReport.validatorAccepted),
        semanticDownstreamArg: valReport.semanticDownstreamArg ?? null,
        dependentWriteOrForwardOccurred: fs.existsSync(downstreamArtifactPath),
        usedFaultFlagOrTrialName: false,
        rejectionDiagnostic: valReport.rejectionDiagnostic ?? null,
      });
    }
  } finally {
    fs.rmSync(trialDir, { recursive: true, force: true });
  }

  // Unseal trial assignments ONLY after all 4 live sessions have settled
  const trials = rawOutcomes.map((outcome, idx) => ({
    hiddenKind: sealedSpecs[idx].hiddenKind,
    ...outcome,
  }));

  const blindControl = { scopedKey, trials };
  const verdict = evaluateP04BlindMutationControl(blindControl);
  progress(`S12 Blind HMAC Result: passed=${verdict.passed} exitCode=${verdict.exitCode} trials=${trials.length}`);
  return {
    ...verdict,
    blindControl,
  };
}
