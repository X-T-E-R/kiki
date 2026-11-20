import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const isCliMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename);

if (isCliMain && (process.argv.includes('--help') || process.argv.includes('-h'))) {
  process.stdout.write(
    'Usage: node scripts/perf-real-corpus.mjs [--quick] [--seed <u32>] [--per-stratum <k>] [--browser|--protocol-only] [--enforce] [--out <path>]\n',
  );
  process.exit(0);
}

for (const envKey of [
  'KIKI_DESKTOP_BUNDLED',
  'KIKI_RUNTIME_MANAGED',
  'KIKI_SQLITE_QUERY_WORKER_PATH',
  'KIKI_SQLITE_INDEXER_PATH',
  'KIKI_HISTORY_NAVIGATION_WORKER_ENTRY',
]) {
  delete process.env[envKey];
}
const hasSqliteWorkerAsset =
  fs.existsSync(path.join(REPO_ROOT, 'packages', 'agent-core-v2', 'src', 'persistence', 'backends', 'sqlite', 'entry.ts')) ||
  fs.existsSync(path.join(REPO_ROOT, 'packages', 'agent-core-v2', 'dist', 'query-store-worker.mjs'));
if (isCliMain && process.argv.includes('--enforce')) {
  if (!hasSqliteWorkerAsset || process.env.KIKI_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL === 'false') {
    process.stderr.write(
      '[perf:real-corpus] ENFORCE FAILED: SQLite query-store read-model must remain enabled with an available worker asset\n',
    );
    process.exit(1);
  }
} else if (!hasSqliteWorkerAsset) {
  process.env.KIKI_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL = 'false';
}

if (isCliMain && process.env.KIKI_PERF_TSX_BOOTSTRAPPED !== '1') {
  const rootRequire = createRequire(path.join(REPO_ROOT, 'package.json'));
  const tsxImportUrl = pathToFileURL(rootRequire.resolve('tsx/esm')).href;
  const rawLoaderUrl = pathToFileURL(path.join(REPO_ROOT, 'build', 'register-raw-text-loader.mjs')).href;
  const child = spawnSync(
    process.execPath,
    ['--import', rawLoaderUrl, '--import', tsxImportUrl, import.meta.filename, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        KIKI_PERF_TSX_BOOTSTRAPPED: '1',
      },
    },
  );
  process.exit(child.status ?? 1);
}

const [
  { resolveCorpusHome, scanCorpusSessions, selectStratifiedSamples },
  { assertZeroPrivateLeaks, collectForbiddenTokens, roundMs },
  { parseSeed },
  { stageCorpusSandbox },
  { bootPerfServer, runProtocolSuite },
  { runBrowserSuite },
] = await Promise.all([
  import('./perf/corpus-scanner.mjs'),
  import('./perf/metrics.mjs'),
  import('./perf/prng.mjs'),
  import('./perf/sandbox-stager.mjs'),
  import('./perf/protocol-runner.mjs'),
  import('./perf/browser-runner.mjs'),
]);

export function parsePerfCliArgs(argv) {
  const options = {
    seed: undefined,
    perStratum: 2,
    quick: false,
    browser: true,
    enforce: false,
    outPath: path.join(REPO_ROOT, '.tmp', 'perf-real-corpus-latest.json'),
    corpusHome: undefined,
    minIdleMs: 120_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quick') {
      options.quick = true;
      options.perStratum = 1;
    } else if (arg === '--browser') {
      options.browser = true;
    } else if (arg === '--protocol-only' || arg === '--no-browser') {
      options.browser = false;
    } else if (arg === '--enforce') {
      options.enforce = true;
    } else if (arg === '--seed' && argv[i + 1] !== undefined) {
      options.seed = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--seed=')) {
      options.seed = arg.slice('--seed='.length);
    } else if (arg === '--per-stratum' && argv[i + 1] !== undefined) {
      options.perStratum = Math.max(1, Number.parseInt(argv[i + 1], 10) || 2);
      i += 1;
    } else if (arg.startsWith('--per-stratum=')) {
      options.perStratum = Math.max(1, Number.parseInt(arg.slice('--per-stratum='.length), 10) || 2);
    } else if (arg === '--out' && argv[i + 1] !== undefined) {
      options.outPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--out=')) {
      options.outPath = path.resolve(arg.slice('--out='.length));
    } else if (arg === '--corpus-home' && argv[i + 1] !== undefined) {
      options.corpusHome = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--corpus-home=')) {
      options.corpusHome = path.resolve(arg.slice('--corpus-home='.length));
    } else if (arg === '--min-idle-ms' && argv[i + 1] !== undefined) {
      options.minIdleMs = Math.max(0, Number.parseInt(argv[i + 1], 10) || 0);
      i += 1;
    }
  }
  return options;
}

const ENFORCED_SLOS = {
  coldOpenP95Ms: 4_500,
  olderPageP95Ms: 8_000,
  coldSubagentP95Ms: 3_500,
  maxServerEldP99Ms: 1_250,
  protocolColdRouteMaxMs: 1_500,
  browserPageErrors: 0,
  browserReactErrors: 0,
  browserFailedApiResponses: 0,
  browserColdRpcMaxMs: 1_500,
  browserContextMeterFailures: 0,
  browserAddMenuScrollFailures: 0,
  browserMergedBranchesFoldedFailures: 0,
  browserScrollUpSnapBackFailures: 0,
  browserCapabilitiesToggleFailures: 0,
  browserFooterDrainFailures: 0,
  browserHiddenUserTurns: 0,
  browserLayoutViolations: 0,
  browserTranscriptMountFailures: 0,
};

function evaluateSlos(report) {
  const breaches = [];
  const p = report.protocol.aggregates;
  if (p.coldOpenTtfcMs.p95 > ENFORCED_SLOS.coldOpenP95Ms) {
    breaches.push(`protocol.coldOpenTtfcMs.p95=${p.coldOpenTtfcMs.p95}ms > ${ENFORCED_SLOS.coldOpenP95Ms}ms`);
  }
  if (p.olderPageMs.p95 > ENFORCED_SLOS.olderPageP95Ms) {
    breaches.push(`protocol.olderPageMs.p95=${p.olderPageMs.p95}ms > ${ENFORCED_SLOS.olderPageP95Ms}ms`);
  }
  if (p.coldSubagentTtfcMs.count > 0 && p.coldSubagentTtfcMs.p95 > ENFORCED_SLOS.coldSubagentP95Ms) {
    breaches.push(`protocol.coldSubagentTtfcMs.p95=${p.coldSubagentTtfcMs.p95}ms > ${ENFORCED_SLOS.coldSubagentP95Ms}ms`);
  }
  if (p.maxServerEldP99Ms > ENFORCED_SLOS.maxServerEldP99Ms) {
    breaches.push(`protocol.maxServerEldP99Ms=${p.maxServerEldP99Ms}ms > ${ENFORCED_SLOS.maxServerEldP99Ms}ms`);
  }
  if ((p.maxColdRouteMs ?? 0) > ENFORCED_SLOS.protocolColdRouteMaxMs) {
    breaches.push(`protocol.maxColdRouteMs=${p.maxColdRouteMs}ms > ${ENFORCED_SLOS.protocolColdRouteMaxMs}ms`);
  }
  if (report.browser) {
    const b = report.browser.aggregates;
    if ((b.totalPageErrors ?? 0) > ENFORCED_SLOS.browserPageErrors) {
      breaches.push(`browser.totalPageErrors=${b.totalPageErrors} > 0`);
    }
    if ((b.totalReactErrors ?? 0) > ENFORCED_SLOS.browserReactErrors) {
      breaches.push(`browser.totalReactErrors=${b.totalReactErrors} > 0`);
    }
    if ((b.totalFailedApiResponses ?? 0) > ENFORCED_SLOS.browserFailedApiResponses) {
      breaches.push(`browser.totalFailedApiResponses=${b.totalFailedApiResponses} > 0`);
    }
    if ((b.maxColdRpcMs ?? 0) > ENFORCED_SLOS.browserColdRpcMaxMs) {
      breaches.push(`browser.maxColdRpcMs=${b.maxColdRpcMs}ms > ${ENFORCED_SLOS.browserColdRpcMaxMs}ms`);
    }
    if ((b.contextMeterFailures ?? 0) > ENFORCED_SLOS.browserContextMeterFailures) {
      breaches.push(`browser.contextMeterFailures=${b.contextMeterFailures} > 0`);
    }
    if ((b.addMenuScrollFailures ?? 0) > ENFORCED_SLOS.browserAddMenuScrollFailures) {
      breaches.push(`browser.addMenuScrollFailures=${b.addMenuScrollFailures} > 0`);
    }
    if ((b.mergedBranchesFoldedFailures ?? 0) > ENFORCED_SLOS.browserMergedBranchesFoldedFailures) {
      breaches.push(`browser.mergedBranchesFoldedFailures=${b.mergedBranchesFoldedFailures} > 0`);
    }
    if ((b.scrollUpSnapBackFailures ?? 0) > ENFORCED_SLOS.browserScrollUpSnapBackFailures) {
      breaches.push(`browser.scrollUpSnapBackFailures=${b.scrollUpSnapBackFailures} > 0`);
    }
    if ((b.capabilitiesToggleFailures ?? 0) > ENFORCED_SLOS.browserCapabilitiesToggleFailures) {
      breaches.push(`browser.capabilitiesToggleFailures=${b.capabilitiesToggleFailures} > 0`);
    }
    if ((b.footerDrainFailures ?? 0) > ENFORCED_SLOS.browserFooterDrainFailures) {
      breaches.push(`browser.footerDrainFailures=${b.footerDrainFailures} > 0`);
    }
    if ((b.hiddenUserTurns ?? 0) > ENFORCED_SLOS.browserHiddenUserTurns) {
      breaches.push(`browser.hiddenUserTurns=${b.hiddenUserTurns} > 0`);
    }
    if ((b.totalLayoutViolations ?? 0) > ENFORCED_SLOS.browserLayoutViolations) {
      breaches.push(`browser.totalLayoutViolations=${b.totalLayoutViolations} > 0`);
    }
    if ((b.transcriptMountFailures ?? 0) > ENFORCED_SLOS.browserTranscriptMountFailures) {
      breaches.push(`browser.transcriptMountFailures=${b.transcriptMountFailures} > 0`);
    }
  }
  if (report.samples.length === 0) {
    breaches.push('samples.length=0 (empty benchmark sample set)');
  }
  if (report.immutability && report.immutability.mutations > 0) {
    breaches.push(`immutability.mutations=${report.immutability.mutations} > 0`);
  }
  return { passed: breaches.length === 0, thresholds: ENFORCED_SLOS, breaches };
}

function formatSummaryText(report) {
  const cat = report.protocol.catalogSummary;
  const lines = [
    `[perf:real-corpus] seed=${report.seed} (replay: pnpm perf:real-corpus -- --seed ${report.seed}) mode=${report.mode} scanned=${report.corpus.totalScanned} eligible=${report.corpus.eligibleCount} sampled=${report.samples.length}`,
    `[perf:sandbox] stageMs=${report.sandbox.stageMs} hardlinks=${report.sandbox.hardlinkedFiles} copies=${report.sandbox.copiedFiles} junctions=${report.sandbox.junctionCount} serverBootMs=${report.serverBootMs} sourceMutations=${report.immutability.mutations}`,
    `[perf:catalog] coldCatalogMs=${cat.coldCatalogMs} http=${cat.httpRequests} payload=${cat.payloadMb}MB listed=${cat.sessionsListed} eldP99=${cat.eldP99Ms}ms`,
  ];
  for (const row of report.protocol.sampleResults) {
    const subTxt = row.coldSubagent ? `${row.coldSubagent.ttfcMs}ms(${row.coldSubagent.httpRequests}req)` : 'n/a';
    const hydTxt = row.scrollOlder.canonicalHydration
      ? `${row.scrollOlder.canonicalHydration.elapsedMs}ms`
      : 'n/a';
    lines.push(
      `  ${row.descriptor} -> coldOpen=${row.coldOpen.ttfcMs}ms(total=${row.coldOpen.totalMs}ms,maxRoute=${row.coldOpen.maxColdRouteMs ?? 0}ms,${row.coldOpen.httpRequests}req,eldP99=${row.coldOpen.eldP99Ms}ms) scrollPages=${row.scrollOlder.pagesFetched}(p50=${row.scrollOlder.pageMsQuantiles.p50}ms,p95=${row.scrollOlder.pageMsQuantiles.p95}ms,hydrate=${hydTxt}) coldSub=${subTxt}`,
    );
  }
  const agg = report.protocol.aggregates;
  lines.push(
    `[perf:protocol:agg] coldOpen(p50=${agg.coldOpenTtfcMs.p50}ms,p95=${agg.coldOpenTtfcMs.p95}ms) maxColdRoute=${agg.maxColdRouteMs ?? 0}ms olderPage(p50=${agg.olderPageMs.p50}ms,p95=${agg.olderPageMs.p95}ms) coldSubagent(p50=${agg.coldSubagentTtfcMs.p50}ms,p95=${agg.coldSubagentTtfcMs.p95}ms) maxEldP99=${agg.maxServerEldP99Ms}ms`,
  );
  if (report.browser) {
    const bagg = report.browser.aggregates;
    lines.push(
      `[perf:browser:agg] guiBuild=${report.browser.guiBuild.buildMs}ms(cached=${report.browser.guiBuild.reusedCache}) coldOpen(p50=${bagg.coldOpenTtfcMs.p50}ms,p95=${bagg.coldOpenTtfcMs.p95}ms) scrollMaxLongTask(p50=${bagg.scrollMaxLongTaskMs.p50}ms,p95=${bagg.scrollMaxLongTaskMs.p95}ms) subSwitch(p50=${bagg.subagentSwitchMs.p50}ms,p95=${bagg.subagentSwitchMs.p95}ms) layoutViolations=${bagg.totalLayoutViolations}`,
    );
    lines.push(
      `[perf:browser:invariants] pageErr=${bagg.totalPageErrors ?? 0} reactErr=${bagg.totalReactErrors ?? 0} apiFail=${bagg.totalFailedApiResponses ?? 0} coldRpcMax=${bagg.maxColdRpcMs ?? 0}ms ctxMeterFail=${bagg.contextMeterFailures ?? 0} addMenuFail=${bagg.addMenuScrollFailures ?? 0} branchFoldFail=${bagg.mergedBranchesFoldedFailures ?? 0} scrollSnapFail=${bagg.scrollUpSnapBackFailures ?? 0} capToggleFail=${bagg.capabilitiesToggleFailures ?? 0} footerFail=${bagg.footerDrainFailures ?? 0} hiddenUserTurns=${bagg.hiddenUserTurns ?? 0} mountFail=${bagg.transcriptMountFailures ?? 0}`,
    );
    for (const brow of report.browser.sampleResults) {
      const swTxt = brow.subagentSwitch
        ? `${brow.subagentSwitch.switchMs}ms(longTaskMax=${brow.subagentSwitch.maxLongTaskMs}ms)`
        : 'n/a';
      const inv = brow.invariants ?? {};
      const ctxTxt = inv.contextMeter?.applicable ? (inv.contextMeter.ok ? 'ok' : inv.contextMeter.reason) : 'n/a';
      const footTxt = inv.footerDrain?.ok ? 'ok' : 'stuck';
      lines.push(
        `  [browser] ${brow.label}[${brow.stratum}] coldOpen=${brow.coldOpen.ttfcMs}ms(maxRpc=${brow.coldOpen.maxColdRpcMs ?? 0}ms,http=${brow.coldOpen.httpRequests},maxLT=${brow.coldOpen.maxLongTaskMs}ms) scroll=${brow.scrollOlder.scrollWindowMs}ms(layout=${brow.scrollOlder.layoutViolations}) subSwitch=${swTxt} ctx=${ctxTxt} footer=${footTxt} hiddenTurns=${inv.hiddenUserTurnCount ?? 0} apiFail=${inv.failedApiResponses?.length ?? 0}`,
      );
    }
  }
  if (!report.slo.passed) {
    lines.push(`[perf:slo] BREACHES: ${report.slo.breaches.join(' | ')}`);
  } else {
    lines.push('[perf:slo] OK');
  }
  return lines.join('\n');
}

export async function runRealCorpusBenchmark(rawOptions = {}) {
  const startedWall = performance.now();
  const seed = parseSeed(rawOptions.seed);
  const perStratum = rawOptions.perStratum ?? (rawOptions.quick ? 1 : 2);
  const corpusHome = resolveCorpusHome(rawOptions.corpusHome);
  const scan = scanCorpusSessions(corpusHome, { minIdleMs: rawOptions.minIdleMs ?? 120_000 });

  if (!scan.available) {
    return {
      skipped: true,
      seed,
      reason: 'No eligible local session corpus found',
    };
  }

  const { samples, backgroundRecords, stratumCensus } = selectStratifiedSamples(scan.records, {
    seed,
    perStratum,
    backgroundCatalogCount: rawOptions.quick ? 20 : 35,
  });

  const forbiddenTokens = collectForbiddenTokens(
    corpusHome,
    [...samples.map((s) => s.sourceSessionId), ...backgroundRecords.map((b) => b.sourceSessionId)],
  );

  const sandbox = stageCorpusSandbox({
    corpusHome,
    samples,
    backgroundRecords,
  });

  let serverHandle = null;
  let protocolReport = null;
  let browserReport = null;
  let immutability = null;

  try {
    serverHandle = await bootPerfServer(sandbox.homeDir);
    protocolReport = await runProtocolSuite({
      endpoint: serverHandle.endpoint,
      token: serverHandle.token,
      samples,
      warmupSessionId: backgroundRecords[0]?.sandboxId ?? null,
      maxScrollPages: rawOptions.quick ? 3 : 5,
    });
    if (rawOptions.browser !== false) {
      browserReport = await runBrowserSuite({
        endpoint: serverHandle.endpoint,
        token: serverHandle.token,
        samples,
        maxPerStratum: 1,
      });
    }
  } finally {
    if (serverHandle?.server) {
      await serverHandle.server.close().catch(() => undefined);
    }
    immutability = sandbox.cleanup();
  }

  const report = {
    skipped: false,
    timestamp: new Date().toISOString(),
    seed,
    mode: rawOptions.quick ? 'quick' : 'standard',
    perStratum,
    totalWallMs: roundMs(performance.now() - startedWall),
    corpus: {
      totalScanned: scan.totalScanned,
      eligibleCount: scan.eligibleCount,
      skippedActiveCount: scan.skippedActiveCount,
      stratumCensus,
    },
    sandbox: {
      stageMs: sandbox.stageMs,
      hardlinkedFiles: sandbox.hardlinkedFiles,
      copiedFiles: sandbox.copiedFiles,
      junctionCount: sandbox.junctionCount,
    },
    immutability,
    serverBootMs: serverHandle.bootMs,
    samples: samples.map((s) => ({
      label: s.label,
      stratum: s.stratum,
      descriptor: s.descriptor,
      mainWireBytes: s.mainWireBytes,
      subagentCount: s.subagentCount,
      maxChildWireBytes: s.maxChildWireBytes,
      totalAttachmentCount: s.totalAttachmentCount,
    })),
    protocol: protocolReport,
    browser: browserReport,
  };
  report.slo = evaluateSlos(report);

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const summaryText = formatSummaryText(report);
  assertZeroPrivateLeaks(serialized, forbiddenTokens);
  assertZeroPrivateLeaks(summaryText, forbiddenTokens);

  if (rawOptions.outPath) {
    fs.mkdirSync(path.dirname(rawOptions.outPath), { recursive: true });
    fs.writeFileSync(rawOptions.outPath, serialized, 'utf8');
  }

  return { report, summaryText };
}

if (isCliMain) {
  const cliOptions = parsePerfCliArgs(process.argv.slice(2));
  const outcome = await runRealCorpusBenchmark(cliOptions);
  if (outcome.skipped) {
    if (cliOptions.enforce) {
      process.stderr.write(`[perf:real-corpus] ENFORCE FAILED: ${outcome.reason}\n`);
      process.exit(1);
    }
    process.stdout.write(`[perf:real-corpus] SKIPPED: ${outcome.reason}\n`);
    process.exit(0);
  }
  process.stdout.write(`${outcome.summaryText}\n`);
  if (cliOptions.outPath) {
    process.stdout.write(`[perf:report] wrote anonymized JSON report to ${path.relative(REPO_ROOT, cliOptions.outPath)}\n`);
  }
  if (cliOptions.enforce && !outcome.report.slo.passed) {
    process.exit(1);
  }
}
