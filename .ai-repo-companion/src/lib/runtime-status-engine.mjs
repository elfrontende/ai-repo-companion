import fs from "node:fs/promises";
import path from "node:path";
import { inspectReviewQueue } from "./review-worker.mjs";
import { getWorkerState } from "./review-runner.mjs";
import { summarizeReviewMetrics } from "./review-metrics-engine.mjs";
import { readLatestTaskRunSummary, readLatestTaskRunSurface } from "./run-engine.mjs";
import { readJson } from "./store.mjs";
import { readLatestMultiAgentEvaluation } from "./multi-agent-eval-engine.mjs";

// Status/doctor commands are operator-facing helpers.
// They intentionally summarize local runtime state instead of exposing raw
// internals that a repo owner would have to mentally reconstruct.

export async function getRuntimeStatus(rootDir, config = {}) {
  // Status is the structured fact layer. Other commands can safely build more
  // opinionated summaries on top without re-reading raw state files.
  const queue = await inspectReviewQueue(rootDir);
  const metrics = await summarizeReviewMetrics(rootDir);
  const benchmarkSummary = await readBenchmarkSummary(rootDir, config, metrics);
  const benchmarkCycleSummary = await readBenchmarkCycleSummary(rootDir, config);
  const tuningSummary = await readTuningSummary(rootDir, config);
  const latestTaskRun = await readLatestTaskRunSummary(rootDir);
  const latestRunSurface = await readLatestTaskRunSurface(rootDir);
  const evaluationSummary = await readLatestMultiAgentEvaluation(rootDir);
  const costSummary = buildCostSummary(queue, metrics);
  return {
    queue,
    worker: await getWorkerState(rootDir),
    metrics,
    costSummary,
    latestTaskRun,
    latestRunSurface,
    evaluationSummary,
    benchmarkSummary,
    benchmarkCycleSummary,
    tuningSummary,
    nextActions: buildRuntimeNextActions(queue, costSummary, benchmarkSummary, benchmarkCycleSummary, tuningSummary),
    compactSummary: buildRuntimeCompactSummary(queue, metrics, costSummary, benchmarkSummary, benchmarkCycleSummary, tuningSummary),
    recovery: await readJson(path.join(rootDir, "state/reviews/recovery-state.json"), null)
  };
}

export async function runRuntimeDoctor(rootDir, config = {}) {
  // Doctor is the opinionated layer over status. It converts raw runtime facts
  // into findings and concrete next actions for a repo owner.
  const queue = await inspectReviewQueue(rootDir);
  const worker = await getWorkerState(rootDir);
  const recovery = await readJson(path.join(rootDir, "state/reviews/recovery-state.json"), null);
  const lock = await readJson(path.join(rootDir, "state/reviews/worker-lock.json"), null);
  const metrics = await summarizeReviewMetrics(rootDir);
  const benchmarkSummary = await readBenchmarkSummary(rootDir, config, metrics);
  const benchmarkCycleSummary = await readBenchmarkCycleSummary(rootDir, config);
  const tuningSummary = await readTuningSummary(rootDir, config);
  const latestRunSurface = await readLatestTaskRunSurface(rootDir);
  const findings = [];

  if (worker.status === "running" && queue.running === 0) {
    findings.push({
      severity: "warning",
      code: "worker-state-mismatch",
      message: "Worker state says running, but the queue has no running jobs."
    });
  }

  if (latestRunSurface.available && latestRunSurface.agentRuns.failed > 0) {
    findings.push({
      severity: "warning",
      code: "agent-run-failed",
      message: `The latest task run has ${latestRunSurface.agentRuns.failed} failed agent run(s).`
    });
  }

  if (latestRunSurface.available && latestRunSurface.handoffs.pending > 0 && latestRunSurface.run.multiAgentStatus !== "running") {
    findings.push({
      severity: "warning",
      code: "handoff-stalled",
      message: `The latest task run still has ${latestRunSurface.handoffs.pending} unconsumed handoff(s).`
    });
  }

  if (latestRunSurface.available && latestRunSurface.verdicts.blocking > 0 && latestRunSurface.retries.open === 0 && latestRunSurface.run.multiAgentStatus !== "blocked") {
    findings.push({
      severity: "warning",
      code: "needs-rework-without-retry",
      message: "The latest task run has blocking verifier feedback but no open retry request."
    });
  }

  if (latestRunSurface.available && latestRunSurface.retries.exhausted > 0) {
    findings.push({
      severity: "warning",
      code: "retry-exhausted",
      message: `The latest task run exhausted ${latestRunSurface.retries.exhausted} bounded retry path(s).`
    });
  }

  if (latestRunSurface.available && latestRunSurface.run.multiAgentStatus === "blocked") {
    findings.push({
      severity: "warning",
      code: "run-stage-stalled",
      message: `The latest task run is blocked in phase ${latestRunSurface.run.currentPhase ?? "unknown"}.`
    });
  }

  if (recovery?.active) {
    findings.push({
      severity: "warning",
      code: "recovery-pending",
      message: "A recovery session is still active. The next worker run should restore or finish it."
    });
  }

  if (lock?.ownerId && lock?.startedAt) {
    const ageMinutes = diffMinutes(lock.startedAt, new Date().toISOString());
    const maxAgeMinutes = config.reviewExecution?.runtimeLock?.maxAgeMinutes ?? 15;
    findings.push({
      severity: ageMinutes >= maxAgeMinutes ? "warning" : "info",
      code: ageMinutes >= maxAgeMinutes ? "stale-lock" : "active-lock",
      message: ageMinutes >= maxAgeMinutes
        ? "A stale worker lock exists and should be recoverable on the next run."
        : "A worker lock is active right now."
    });
  }

  for (const job of queue.jobs.filter((item) => item.status === "awaiting-approval")) {
    const approvalPath = job.approval?.approvalPath;
    const exists = approvalPath ? await fs.access(approvalPath).then(() => true).catch(() => false) : false;
    if (!exists) {
      findings.push({
        severity: "error",
        code: "missing-approval-file",
        message: `Job ${job.id} is awaiting approval but its approval file is missing.`
      });
    }
  }

  for (const job of queue.jobs.filter((item) => item.status === "completed" || item.status === "failed")) {
    const exists = job.reportPath ? await fs.access(job.reportPath).then(() => true).catch(() => false) : false;
    if (!exists) {
      findings.push({
        severity: "warning",
        code: "missing-report",
        message: `Job ${job.id} references a missing review report.`
      });
    }
  }

  if (!benchmarkSummary.loaded) {
    findings.push({
      severity: "info",
      code: "benchmark-missing",
      message: "No benchmark report exists yet. Run `benchmark` before trusting cost recommendations."
    });
  } else if (benchmarkSummary.isStale) {
    findings.push({
      severity: "warning",
      code: "benchmark-stale",
      message: "The last benchmark report is stale. Refresh it before changing runtime cost defaults."
    });
  }

  if (benchmarkSummary.loaded && benchmarkSummary.confidence?.level === "low") {
    findings.push({
      severity: "info",
      code: "benchmark-confidence-low",
      message: `Benchmark confidence is low: ${benchmarkSummary.confidence.reasons?.[0] ?? "benchmark evidence is still thin"}.`
    });
  }

  if (!benchmarkCycleSummary.loaded) {
    findings.push({
      severity: "info",
      code: "benchmark-cycle-missing",
      message: "No benchmark cycle exists yet. Run a short multi-iteration benchmark loop before trusting longer-run tuning behavior."
    });
  } else if (benchmarkCycleSummary.isStale) {
    findings.push({
      severity: "info",
      code: "benchmark-cycle-stale",
      message: "The last benchmark cycle is stale. Refresh a multi-iteration cycle before making long-run tuning decisions."
    });
  }

  if (benchmarkCycleSummary.loaded && benchmarkCycleSummary.confidence?.level === "low") {
    findings.push({
      severity: "info",
      code: "benchmark-cycle-confidence-low",
      message: `Benchmark-cycle confidence is low: ${benchmarkCycleSummary.confidence.reasons?.[0] ?? "cycle evidence is still thin"}.`
    });
  }

  if (benchmarkSummary.cheapestVariant === "saver"
    && (config.reviewExecution?.reviewProfiles?.balanced?.codexReasoningEffort ?? "medium") !== "low") {
    findings.push({
      severity: "info",
      code: "balanced-lane-heavier-than-benchmark",
      message: "Benchmark evidence says saver is cheaper, but balanced reasoning effort is still above the lean lane. Run `tune --auto` or lower the balanced profile manually."
    });
  }

  if (benchmarkSummary.cheapestVariant === "saver" && tuningSummary.loaded && tuningSummary.isStale) {
    findings.push({
      severity: "info",
      code: "auto-tune-stale",
      message: "Benchmark evidence favors the saver lane, but the last auto-tune is stale. Consider running `tune --auto` again."
    });
  }

  if (tuningSummary.canaryStatus === "pending" && benchmarkSummary.loaded) {
    findings.push({
      severity: "info",
      code: "canary-pending-reconcile",
      message: "A recent auto-tune is still waiting for a newer benchmark pass. Run `benchmark` and then `tune --reconcile` or `tune --auto`."
    });
  }

  if (tuningSummary.canaryStatus === "rolled-back") {
    findings.push({
      severity: "warning",
      code: "auto-tune-rolled-back",
      message: "The last auto-tune was rolled back by the canary check. Review benchmark drift before enabling more aggressive self-tuning."
    });
  }

  if (benchmarkSummary.tuningComparison?.available && benchmarkSummary.tuningComparison.outcome === "degraded") {
    findings.push({
      severity: "warning",
      code: "post-tune-benchmark-degraded",
      message: benchmarkSummary.tuningComparison.summary
    });
  }

  if (benchmarkSummary.tuningComparison?.available && benchmarkSummary.tuningComparison.outcome === "improved") {
    findings.push({
      severity: "info",
      code: "post-tune-benchmark-improved",
      message: benchmarkSummary.tuningComparison.summary
    });
  }

  for (const item of benchmarkSummary.domainDiagnostics.filter((entry) => entry.shouldTightenValueGate)) {
    findings.push({
      severity: "info",
      code: `domain-value-gate-drift-${item.domain}`,
      message: `${item.domain} has favored saver for ${item.saverTrendStreak} benchmark runs and still leads by ${item.reductionGap.toFixed(2)} points, but its configured value-gate threshold is only ${item.configuredThreshold}. Consider ${item.suggestedThreshold} for this low-risk domain.`
    });
  }

  for (const item of benchmarkSummary.domainDiagnostics.filter((entry) => entry.isNoisy)) {
    findings.push({
      severity: "info",
      code: `domain-signal-noisy-${item.domain}`,
      message: `${item.domain} has a noisy benchmark signal with ${item.changeCount} cheapest-variant flips in the recent trend window, so tighter tuning should wait for more stable evidence.`
    });
  }

  if (benchmarkCycleSummary.loaded && benchmarkCycleSummary.trendDirection === "degrading") {
    findings.push({
      severity: "warning",
      code: "benchmark-cycle-degrading",
      message: benchmarkCycleSummary.recommendation
    });
  }

  if (benchmarkCycleSummary.loaded && benchmarkCycleSummary.trendDirection === "improving") {
    findings.push({
      severity: "info",
      code: "benchmark-cycle-improving",
      message: benchmarkCycleSummary.recommendation
    });
  }

  if (benchmarkCycleSummary.windowComparison?.available && benchmarkCycleSummary.windowComparison.direction === "degrading") {
    findings.push({
      severity: "warning",
      code: "benchmark-cycle-window-degrading",
      message: benchmarkCycleSummary.windowComparison.recommendation
    });
  }

  if (benchmarkCycleSummary.windowComparison?.available && benchmarkCycleSummary.windowComparison.direction === "improving") {
    findings.push({
      severity: "info",
      code: "benchmark-cycle-window-improving",
      message: benchmarkCycleSummary.windowComparison.recommendation
    });
  }

  if (benchmarkCycleSummary.windowHistorySummary?.available && benchmarkCycleSummary.windowHistorySummary.dominantDirection === "degrading") {
    findings.push({
      severity: "warning",
      code: "benchmark-window-history-degrading",
      message: benchmarkCycleSummary.windowHistorySummary.summary
    });
  }

  if (benchmarkCycleSummary.windowHistorySummary?.available && benchmarkCycleSummary.windowHistorySummary.dominantDirection === "improving") {
    findings.push({
      severity: "info",
      code: "benchmark-window-history-improving",
      message: benchmarkCycleSummary.windowHistorySummary.summary
    });
  }

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    queue,
    worker,
    metrics,
    benchmarkSummary,
    benchmarkCycleSummary,
    tuningSummary,
    recommendedActions: buildDoctorRecommendedActions(findings),
    compactSummary: buildDoctorCompactSummary(findings),
    recovery,
    lock: lock ?? {},
    latestRunSurface,
    findings
  };
}

function diffMinutes(startAt, endAt) {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 0;
  }
  return Math.max(0, Math.floor((endMs - startMs) / 60000));
}

function buildCostSummary(queue, metrics) {
  const liveTokensUsed = Number(metrics?.cost?.liveTokensUsed) || 0;
  const avgTokensPerRun = Number(metrics?.cost?.avgTokensPerRun) || 0;
  const avgTokensPerSelectedOperation = Number(metrics?.cost?.avgTokensPerSelectedOperation) || 0;
  const topMode = metrics?.topTokenModes?.[0]?.key ?? null;
  const topDomain = metrics?.topTokenDomains?.[0]?.key ?? null;
  const balancedQueued = queue.jobs.filter((job) => job.status === "queued" && job.mode === "balanced").length;
  const expensiveQueued = queue.jobs.filter((job) => job.status === "queued" && job.mode === "expensive").length;

  return {
    liveTokensUsed,
    avgTokensPerRun,
    avgTokensPerSelectedOperation,
    highestCostMode: topMode,
    highestCostDomain: topDomain,
    queuePressure: {
      balancedQueued,
      expensiveQueued
    },
    recommendation: buildCostRecommendation({
      avgTokensPerSelectedOperation,
      balancedQueued,
      expensiveQueued
    })
  };
}

async function readBenchmarkSummary(rootDir, config = {}, metrics = null) {
  const benchmark = await readJson(path.join(rootDir, "state/benchmarks/last-benchmark.json"), null);
  const generatedAt = benchmark?.generatedAt ?? null;
  const freshnessMinutes = config.tuning?.benchmarkFreshnessMinutes ?? 1440;
  const ageMinutes = ageInMinutes(generatedAt);
  const domainDiagnostics = buildDomainDiagnostics(benchmark, config, metrics);
  const topWasteDomains = buildTopWasteDomains(domainDiagnostics);
  const safeSavingsOpportunities = buildSafeSavingsOpportunities(domainDiagnostics);
  return {
    loaded: Boolean(benchmark?.aggregate),
    generatedAt,
    ageMinutes,
    isStale: ageMinutes > freshnessMinutes,
    corpusMode: benchmark?.corpusMode ?? "real",
    inputCorpus: benchmark?.inputCorpus ?? {
      noteCount: 0,
      totalTokens: 0,
      noiseNotesAdded: 0,
      realNoteCount: 0,
      realTotalTokens: 0
    },
    cheapestVariant: benchmark?.aggregate?.cheapestVariant ?? null,
    balancedReductionPercent: benchmark?.aggregate?.byVariant?.balanced?.reductionPercent ?? null,
    saverReductionPercent: benchmark?.aggregate?.byVariant?.saver?.reductionPercent ?? null,
    domainDiagnostics,
    topWasteDomains,
    safeSavingsOpportunities,
    realCorpusCheck: benchmark?.realCorpusCheck ?? {
      noteCount: 0,
      totalTokens: 0,
      taskCount: 0,
      averageSelectedNotes: 0,
      averageContextTokens: 0,
      averageReductionPercent: 0,
      emptyContextTasks: 0,
      fullCorpusTasks: 0,
      totalTokensSaved: 0,
      reductionPercent: 0,
      tasks: []
    },
    domainTrend: benchmark?.trend?.byDomain ?? {},
    confidence: benchmark?.trend?.confidence ?? {
      score: 0,
      level: "low",
      reasons: ["benchmark trend confidence is unavailable"]
    },
    tuningComparison: benchmark?.tuningComparison ?? null
  };
}

async function readBenchmarkCycleSummary(rootDir, config = {}) {
  const benchmarkCycle = await readJson(path.join(rootDir, "state/benchmarks/last-benchmark-cycle.json"), null);
  const generatedAt = benchmarkCycle?.generatedAt ?? null;
  const freshnessMinutes = config.tuning?.benchmarkCycleFreshnessMinutes ?? config.tuning?.benchmarkFreshnessMinutes ?? 1440;
  const ageMinutes = ageInMinutes(generatedAt);
  const multiCycle = benchmarkCycle?.multiCycle ?? { available: false, reason: "no-cycle-summary" };

  return {
    loaded: Boolean(benchmarkCycle?.summary),
    generatedAt,
    ageMinutes,
    isStale: ageMinutes > freshnessMinutes,
    suite: benchmarkCycle?.suite ?? "mixed",
    corpusMode: benchmarkCycle?.corpusMode ?? "real",
    iterations: benchmarkCycle?.iterations ?? 0,
    autoTuneBetweenRuns: benchmarkCycle?.autoTuneBetweenRuns === true,
    latestOutcome: multiCycle.latestOutcome ?? benchmarkCycle?.summary?.outcome ?? null,
    trendDirection: multiCycle.trendDirection ?? (benchmarkCycle?.summary?.outcome === "improved"
      ? "improving"
      : benchmarkCycle?.summary?.outcome === "degraded"
        ? "degrading"
        : "mixed"),
    latestOutcomeStreak: multiCycle.latestOutcomeStreak ?? 0,
    averageBalancedDelta: multiCycle.averageBalancedDelta ?? null,
    averageRollbackCount: multiCycle.averageRollbackCount ?? null,
    latestVsPreviousBalancedDelta: multiCycle.latestVsPreviousBalancedDelta ?? null,
    outcomeCounts: multiCycle.outcomeCounts ?? {},
    windowComparison: multiCycle.windowComparison ?? { available: false, reason: "no-window-comparison" },
    windowHistorySummary: multiCycle.windowHistorySummary ?? { available: false, reason: "no-window-history" },
    confidence: multiCycle.confidence ?? {
      score: 0,
      level: "low",
      reasons: ["benchmark cycle confidence is unavailable"]
    },
    recommendation: multiCycle.recommendation ?? benchmarkCycle?.summary?.recommendation ?? null,
    multiCycle
  };
}

async function readTuningSummary(rootDir, config = {}) {
  const tuning = await readJson(path.join(rootDir, "state/tuning/last-tuning.json"), null);
  const generatedAt = tuning?.generatedAt ?? null;
  const freshnessMinutes = config.tuning?.autoTuneFreshnessMinutes ?? 720;
  const ageMinutes = ageInMinutes(generatedAt);
  const recentAppliedPhases = [...new Set(
    (Array.isArray(tuning?.applied) ? tuning.applied : [])
      .map((item) => item.phase)
      .filter(Boolean)
  )];
  return {
    loaded: Boolean(tuning?.generatedAt),
    generatedAt,
    ageMinutes,
    isStale: ageMinutes > freshnessMinutes,
    mode: tuning?.mode ?? null,
    appliedCount: Array.isArray(tuning?.applied) ? tuning.applied.length : 0,
    blockedCount: Array.isArray(tuning?.blocked) ? tuning.blocked.length : 0,
    canaryStatus: tuning?.canary?.status ?? null,
    canaryReconciledAt: tuning?.canary?.reconciledAt ?? null,
    canaryRemainingRollbackCount: tuning?.canary?.reconciliation?.remainingRollbackCount ?? 0,
    canaryReconciliationReasons: tuning?.canary?.reconciliation?.reasons ?? [],
    recentAppliedPhases
  };
}

function ageInMinutes(timestamp) {
  const ts = Date.parse(timestamp ?? "");
  if (!Number.isFinite(ts)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.floor((Date.now() - ts) / 60000));
}

function buildCostRecommendation(summary) {
  if (summary.balancedQueued >= 2 && summary.avgTokensPerSelectedOperation >= 20000) {
    return "Use --costMode saver for balanced live reviews until queue pressure drops.";
  }
  if (summary.expensiveQueued >= 1) {
    return "Reserve strict live runs for high-risk jobs and let balanced jobs stay on the light lane.";
  }
  if (summary.avgTokensPerSelectedOperation > 0 && summary.avgTokensPerSelectedOperation <= 10000) {
    return "Current live review cost looks healthy for the amount of useful note work getting through.";
  }
  return "No strong cost signal yet. Keep collecting local metrics before tightening policy again.";
}

function buildDomainDiagnostics(benchmark, config, metrics) {
  const monitoredDomains = config.tuning?.canaryDomains ?? ["docs", "deploy", "ui", "testing"];
  const byDomain = benchmark?.aggregate?.byDomain ?? {};
  const globalThreshold = Number(config.reviewExecution?.valueGate?.minScore) || 60;
  const tokenMap = Object.fromEntries((metrics?.topTokenDomains ?? []).map((entry) => [entry.key, entry.count]));

  return monitoredDomains
    .filter((domain) => byDomain?.[domain])
    .map((domain) => {
      // Domain diagnostics intentionally focus on cheap, low-risk domains.
      // They help the operator see whether docs/deploy/ui/testing should use a
      // stricter local value gate without forcing the same threshold on security work.
      const summary = byDomain[domain];
      const saverReduction = Number(summary?.byVariant?.saver?.reductionPercent) || 0;
      const balancedReduction = Number(summary?.byVariant?.balanced?.reductionPercent) || 0;
      const reductionGap = Number((saverReduction - balancedReduction).toFixed(2));
      const storedThreshold = config.reviewExecution?.valueGate?.minScoreByDomain?.[domain];
      const configuredThreshold = Number(storedThreshold) || globalThreshold;
      const suggestedThreshold = Math.min(90, globalThreshold + 5);
      const saverTrendStreak = Number(benchmark?.trend?.byDomain?.[domain]?.cheapestVariantStreak?.count) || 0;
      const changeCount = Number(benchmark?.trend?.byDomain?.[domain]?.changeCount) || 0;
      const isNoisy = benchmark?.trend?.byDomain?.[domain]?.isNoisy === true;
      const wasteScore = Math.round((Number(tokenMap[domain]) || 0) * Math.max(1, reductionGap));
      const shouldTightenValueGate = summary?.cheapestVariant === "saver"
        && reductionGap >= 4
        && saverTrendStreak >= 2
        && !isNoisy
        && configuredThreshold < suggestedThreshold;

      return {
        domain,
        cheapestVariant: summary?.cheapestVariant ?? null,
        saverReductionPercent: saverReduction,
        balancedReductionPercent: balancedReduction,
        reductionGap,
        saverTrendStreak,
        configuredThreshold,
        suggestedThreshold,
        liveTokensUsed: Number(tokenMap[domain]) || 0,
        wasteScore,
        changeCount,
        isNoisy,
        shouldTightenValueGate
      };
    })
    .sort((left, right) => {
      if (right.liveTokensUsed !== left.liveTokensUsed) {
        return right.liveTokensUsed - left.liveTokensUsed;
      }
      return right.reductionGap - left.reductionGap;
    });
}

function buildTopWasteDomains(domainDiagnostics) {
  return [...domainDiagnostics]
    .filter((item) => item.liveTokensUsed > 0)
    .sort((left, right) => {
      if (right.wasteScore !== left.wasteScore) {
        return right.wasteScore - left.wasteScore;
      }
      return right.liveTokensUsed - left.liveTokensUsed;
    })
    .slice(0, 3)
    .map((item) => ({
      domain: item.domain,
      liveTokensUsed: item.liveTokensUsed,
      reductionGap: item.reductionGap,
      wasteScore: item.wasteScore,
      evidenceScore: buildDomainEvidenceScore(item),
      evidenceBand: inferEvidenceBand(buildDomainEvidenceScore(item)),
      cheapestVariant: item.cheapestVariant,
      riskLevel: "low",
      expectedSavingsHint: buildDomainSavingsHint(item),
      expectedOutcome: buildDomainWasteOutcome(item),
      impactSummary: buildDomainImpactSummary(item),
      whyRanked: `${item.domain} is consuming ${item.liveTokensUsed} live tokens with a ${item.reductionGap.toFixed(2)} point saver advantage, so it is currently the strongest cheap-domain waste signal.`
    }));
}

function buildSafeSavingsOpportunities(domainDiagnostics) {
  return [...domainDiagnostics]
    .filter((item) => item.shouldTightenValueGate)
    .sort((left, right) => {
      if (right.wasteScore !== left.wasteScore) {
        return right.wasteScore - left.wasteScore;
      }
      return right.saverTrendStreak - left.saverTrendStreak;
    })
    .slice(0, 3)
    .map((item) => ({
      domain: item.domain,
      currentThreshold: item.configuredThreshold,
      suggestedThreshold: item.suggestedThreshold,
      liveTokensUsed: item.liveTokensUsed,
      saverTrendStreak: item.saverTrendStreak,
      reductionGap: item.reductionGap,
      action: `Raise minScoreByDomain.${item.domain} to ${item.suggestedThreshold}`,
      evidenceScore: buildDomainEvidenceScore(item),
      evidenceBand: inferEvidenceBand(buildDomainEvidenceScore(item)),
      riskLevel: "low",
      expectedSavingsHint: buildDomainSavingsHint(item),
      expectedOutcome: buildDomainTuneOutcome(item),
      impactSummary: buildDomainImpactSummary(item),
      whyRanked: `${item.domain} has a stable saver streak of ${item.saverTrendStreak} runs and still burns ${item.liveTokensUsed} live tokens, so tightening its local gate is the safest near-term savings move.`
    }));
}

function buildRuntimeNextActions(queue, costSummary, benchmarkSummary, benchmarkCycleSummary, tuningSummary) {
  const actions = [];

  if (!benchmarkSummary.loaded) {
    actions.push({
      priority: 100,
      action: "node src/cli.mjs benchmark",
      reason: "No benchmark evidence exists yet, so tuning and cost guidance are still blind.",
      evidenceScore: 95,
      evidenceBand: inferEvidenceBand(95),
      riskLevel: "low",
      expectedOutcome: "Creates the missing benchmark baseline for every later tuning and rollback decision.",
      impactSummary: "Unblocks every later cost recommendation with a fresh baseline.",
      whyNow: "Benchmark data is the prerequisite for nearly every bounded tuning or rollback decision."
    });
  } else if (benchmarkSummary.isStale) {
    actions.push({
      priority: 95,
      action: "node src/cli.mjs benchmark",
      reason: "The last benchmark report is stale, so current cost recommendations may be misleading.",
      evidenceScore: 86,
      evidenceBand: inferEvidenceBand(86),
      riskLevel: "low",
      expectedOutcome: "Refreshes stale cost evidence before another bounded policy change is considered.",
      impactSummary: "Replaces stale economics evidence before another tune changes behavior.",
      whyNow: "Fresh benchmark evidence has higher priority than further tuning on stale numbers."
    });
  }

  if (!benchmarkCycleSummary.loaded && benchmarkSummary.loaded) {
    actions.push({
      priority: 94,
      action: "node src/cli.mjs benchmark --iterations 3 --autoTuneBetweenRuns",
      reason: "No benchmark cycle exists yet, so longer-run tuning behavior is still unvalidated.",
      evidenceScore: 82,
      evidenceBand: inferEvidenceBand(82),
      riskLevel: "low",
      expectedOutcome: "Adds short multi-run evidence, so one lucky benchmark does not drive the next tuning step alone.",
      impactSummary: "Adds a short long-run signal before another tuning move.",
      whyNow: "A short benchmark cycle is the fastest way to verify that recent tuning wins are not one-run noise."
    });
  } else if (benchmarkCycleSummary.isStale) {
    actions.push({
      priority: 89,
      action: "node src/cli.mjs benchmark --iterations 3 --autoTuneBetweenRuns",
      reason: "The last benchmark cycle is stale, so long-run tuning guidance may have drifted.",
      evidenceScore: 80,
      evidenceBand: inferEvidenceBand(80),
      riskLevel: "low",
      expectedOutcome: "Refreshes longer-run trend data before another tuning decision relies on old cycle evidence.",
      impactSummary: "Refreshes long-run evidence so current tuning advice is still trustworthy.",
      whyNow: "Cycle-level evidence is more important than another manual tune when the existing long-run signal is old."
    });
  } else if (benchmarkCycleSummary.trendDirection === "degrading") {
    actions.push({
      priority: 88,
      action: "node src/cli.mjs benchmark --iterations 3 --autoTuneBetweenRuns",
      reason: benchmarkCycleSummary.recommendation,
      evidenceScore: 84,
      evidenceBand: inferEvidenceBand(84),
      riskLevel: "low",
      expectedOutcome: "Re-checks the degrading economics trend before more bounded tuning widens the blast radius.",
      impactSummary: "Confirms or rejects the current degrading cycle signal.",
      whyNow: "The last few benchmark cycles already point to degrading economics, so the next step is to reproduce that trend before widening tuning changes."
    });
  }

  if (tuningSummary.canaryStatus === "pending") {
    actions.push({
      priority: 92,
      action: "node src/cli.mjs tune --reconcile",
      reason: "A pending canary is waiting for a post-tune benchmark verdict.",
      evidenceScore: 90,
      evidenceBand: inferEvidenceBand(90),
      riskLevel: "medium",
      expectedOutcome: "Either accepts the last bounded tune or rolls it back before more changes stack on top.",
      impactSummary: "Resolves the only bounded change that can still poison later tuning decisions.",
      whyNow: "Resolve the existing canary before stacking another tuning change on top of it."
    });
  }

  if (benchmarkSummary.tuningComparison?.available && benchmarkSummary.tuningComparison.outcome === "degraded") {
    actions.push({
      priority: 90,
      action: "node src/cli.mjs tune --reconcile",
      reason: benchmarkSummary.tuningComparison.summary,
      evidenceScore: 88,
      evidenceBand: inferEvidenceBand(88),
      riskLevel: "medium",
      expectedOutcome: "Reduces the chance of carrying a regressing tuning change into the next benchmark window.",
      impactSummary: "Cuts off a possible tuning regression before it spreads into the next cycle.",
      whyNow: "The latest benchmark already suggests a tuning regression, so rollback/reconcile outranks fresh tuning."
    });
  }

  const driftingDomain = benchmarkSummary.domainDiagnostics.find((item) => item.shouldTightenValueGate);
  if (driftingDomain) {
    actions.push({
      priority: 80,
      action: "node src/cli.mjs tune --auto",
      reason: `${driftingDomain.domain} still favors saver and is burning tokens above its configured domain gate.`,
      evidenceScore: buildDomainEvidenceScore(driftingDomain),
      evidenceBand: inferEvidenceBand(buildDomainEvidenceScore(driftingDomain)),
      riskLevel: "low",
      expectedOutcome: buildDomainTuneOutcome(driftingDomain),
      impactSummary: buildDomainImpactSummary(driftingDomain),
      whyNow: `${driftingDomain.domain} is the highest-confidence cheap-domain drift signal in the current benchmark summary.`
    });
  }

  if (benchmarkSummary.cheapestVariant === "saver" && tuningSummary.isStale) {
    actions.push({
      priority: 70,
      action: "node src/cli.mjs tune --auto",
      reason: "Saver keeps winning recent benchmark checks, but the last auto-tune is stale.",
      evidenceScore: 68,
      evidenceBand: inferEvidenceBand(68),
      riskLevel: "medium",
      expectedOutcome: "Refreshes bounded policy changes so the runtime keeps tracking the cheaper lane.",
      impactSummary: "Refreshes stale tuning so the cheaper balanced lane remains the default.",
      whyNow: "The system already has a stable cheaper lane, so refreshing bounded auto-tune is more useful than manual tweaking."
    });
  }

  if (costSummary.queuePressure.balancedQueued >= 2 && costSummary.avgTokensPerSelectedOperation >= 20000) {
    actions.push({
      priority: 60,
      action: "Run the next live balanced review with --costMode saver",
      reason: "Balanced queue pressure is high while useful note work per token is still expensive.",
      evidenceScore: 62,
      evidenceBand: inferEvidenceBand(62),
      riskLevel: "low",
      expectedOutcome: "Cuts the next balanced live run cost without changing repository policy or note graph behavior.",
      impactSummary: "Gives the operator a fast one-run cost cut with no policy mutation.",
      whyNow: "This is the quickest operator-side cost reduction that does not mutate repository policy."
    });
  }

  if (queue.awaitingApproval > 0) {
    actions.push({
      priority: 55,
      action: "node src/cli.mjs queue",
      reason: "There are pending approvals waiting for a manual decision before notes can change.",
      evidenceScore: 58,
      evidenceBand: inferEvidenceBand(58),
      riskLevel: "low",
      expectedOutcome: "Clears approval bottlenecks so successful review work can actually reach the note graph.",
      impactSummary: "Unblocks already-approved note work that is stuck behind manual review.",
      whyNow: "Manual approvals block note graph progress regardless of the rest of the tuning state."
    });
  }

  return actions
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 5);
}

function buildDoctorRecommendedActions(findings) {
  const actions = [];
  const push = (condition, priority, action, reason) => {
    if (!condition) {
      return;
    }
    actions.push({
      priority,
      action,
      reason,
      whyNow: reason,
      evidenceScore: inferRecommendedActionEvidenceScore(action),
      evidenceBand: inferEvidenceBand(inferRecommendedActionEvidenceScore(action)),
      riskLevel: inferRecommendedActionRisk(action),
      expectedOutcome: inferRecommendedActionOutcome(action),
      impactSummary: inferRecommendedActionImpact(action)
    });
  };

  push(
    findings.some((item) => ["benchmark-missing", "benchmark-stale", "benchmark-cycle-missing", "benchmark-cycle-stale", "benchmark-cycle-degrading"].includes(item.code)),
    100,
    "node src/cli.mjs benchmark --iterations 3 --autoTuneBetweenRuns",
    "Refresh benchmark evidence before trusting longer-run runtime recommendations."
  );
  push(
    findings.some((item) => item.code === "post-tune-benchmark-degraded" || item.code === "canary-pending-reconcile"),
    95,
    "node src/cli.mjs tune --reconcile",
    "Resolve or roll back the most recent auto-tune before stacking more tuning changes."
  );
  push(
    findings.some((item) => item.code.startsWith("domain-value-gate-drift-")) || findings.some((item) => item.code === "auto-tune-stale"),
    85,
    "node src/cli.mjs tune --auto",
    "The cheap balanced lane has visible drift that bounded auto-tune can usually tighten safely."
  );
  push(
    findings.some((item) => item.code === "missing-approval-file"),
    80,
    "Inspect state/reviews/approvals and rerun review or approval flow",
    "Approval state is inconsistent and should be repaired before more queue work proceeds."
  );
  push(
    findings.some((item) => item.code === "stale-lock" || item.code === "recovery-pending"),
    75,
    "node src/cli.mjs worker --maxJobs 1",
    "A single worker pass should clear stale runtime state or finish recovery."
  );
  push(
    findings.some((item) => ["agent-run-failed", "handoff-stalled", "needs-rework-without-retry", "retry-exhausted", "run-stage-stalled"].includes(item.code)),
    78,
    "node src/cli.mjs run --runId latest",
    "The latest multi-agent run needs drilldown before more task execution proceeds."
  );

  return actions
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 5);
}

function buildRuntimeCompactSummary(queue, metrics, costSummary, benchmarkSummary, benchmarkCycleSummary, tuningSummary) {
  return {
    health: queue.awaitingApproval > 0
      ? "Approval backlog is currently the main note-graph bottleneck."
      : queue.running > 0
        ? "A review worker is active, so queue state may still be moving."
        : "Runtime looks stable and no immediate execution bottleneck is visible.",
    whyExpensive: costSummary.liveTokensUsed > 0
      ? `The heaviest current token pressure is in ${costSummary.highestCostDomain ?? "unknown-domain"} on the ${costSummary.highestCostMode ?? "unknown"} lane.`
      : "No live token burn has been recorded yet in the current metrics window.",
    whyTuneNow: benchmarkSummary.topWasteDomains[0]?.whyRanked
      ?? benchmarkCycleSummary.recommendation
      ?? "No strong tuning signal is available yet.",
    whyQueueBlocked: queue.awaitingApproval > 0
      ? `${queue.awaitingApproval} job(s) are waiting for approval before their note updates can be applied.`
      : queue.queued > 0
        ? `${queue.queued} queued job(s) are still waiting for worker capacity or policy conditions.`
        : "The queue is not currently blocked.",
    whySkipped: buildSkipExplanation(queue, metrics),
    whyLiveReview: buildLiveReviewExplanation(queue, metrics, costSummary),
    whyConfident: benchmarkCycleSummary.confidence?.level === "high"
      ? `Long-run cycle confidence is high because ${benchmarkCycleSummary.confidence.reasons?.[0] ?? "the recent benchmark windows are stable"}.`
      : benchmarkSummary.confidence?.level === "high"
        ? `Benchmark confidence is high because ${benchmarkSummary.confidence.reasons?.[0] ?? "the recent benchmark trend is stable"}.`
        : `Confidence is still ${benchmarkCycleSummary.confidence?.level ?? benchmarkSummary.confidence?.level ?? "low"} because ${benchmarkCycleSummary.confidence?.reasons?.[0] ?? benchmarkSummary.confidence?.reasons?.[0] ?? "recent benchmark evidence is thin or noisy"}.`,
    whyNotTuneHarder: benchmarkSummary.domainDiagnostics.some((item) => item.isNoisy)
      ? "At least one cheap domain is still noisy, so aggressive tightening would overreact to unstable benchmark evidence."
      : tuningSummary.canaryStatus === "pending"
      ? "A pending canary still needs reconciliation before wider tuning changes are safe."
      : "No major blocker is currently preventing another bounded tuning step."
  };
}

function buildSkipExplanation(queue, metrics) {
  if ((metrics?.counters?.skippedJobs ?? 0) <= 0) {
    return queue.awaitingApproval > 0
      ? "Recent sensitive work is pausing at the approval barrier instead of being skipped outright."
      : "No meaningful local skip pattern is visible yet.";
  }

  const topSkippedAdapter = metrics?.topAdapters?.[0]?.key ?? null;
  if (topSkippedAdapter === "value-policy" || metrics?.topAdapters?.some((item) => item.key === "value-policy")) {
    return "Recent balanced jobs are being skipped locally by the value gate before a live model call, which is currently the main source of saved review runs.";
  }

  return "Some review work is already being stopped locally before it reaches note apply, so part of the current cost pressure is being absorbed without another live run.";
}

function buildLiveReviewExplanation(queue, metrics, costSummary) {
  if ((costSummary?.liveTokensUsed ?? 0) > 0) {
    return `Current live review spend is concentrated on the ${costSummary.highestCostMode ?? "unknown"} lane in ${costSummary.highestCostDomain ?? "unknown-domain"}, which means the remaining live calls are mostly coming from jobs that passed the local value and safety gates.`;
  }

  if ((queue.jobs ?? []).some((job) => job.status === "queued" && job.mode === "expensive")) {
    return "The next likely live spend is sitting in the expensive lane, where higher-risk review work is intentionally allowed to bypass the cheaper local skip path.";
  }

  if ((metrics?.counters?.skippedJobs ?? 0) > 0) {
    return "The runtime is currently preferring local-only decisions over live review for weak balanced jobs, so live token spend is being suppressed upstream.";
  }

  return "No strong live-review decision pattern is visible yet because the current metrics window is still mostly empty.";
}

function buildDoctorCompactSummary(findings) {
  const highestSeverity = findings.some((item) => item.severity === "error")
    ? "error"
    : findings.some((item) => item.severity === "warning")
      ? "warning"
      : "info";
  const topFinding = findings[0]?.message ?? "No actionable diagnostics were found.";
  const expensiveFinding = findings.find((item) => item.code.includes("benchmark") || item.code.includes("balanced-lane"))?.message
    ?? "No strong benchmark or cost warning is active.";
  const recoveryFinding = findings.find((item) => item.code.includes("lock") || item.code.includes("recovery") || item.code.includes("approval"))?.message
    ?? "No recovery or approval issue is currently blocking the runtime.";

  return {
    highestSeverity,
    topFinding,
    whyExpensive: expensiveFinding,
    whyBlocked: recoveryFinding
  };
}

function buildDomainSavingsHint(item) {
  const approximateTokens = Math.max(0, Math.round(item.liveTokensUsed * (item.reductionGap / 100)));
  return approximateTokens > 0
    ? `Likely to recover roughly ${approximateTokens} synthetic live tokens if this cheap-domain drift is corrected.`
    : "Likely to recover a small but safe amount of synthetic live-token waste in this cheap domain.";
}

function buildDomainTuneOutcome(item) {
  return `${item.domain} is low-risk and still has a ${item.reductionGap.toFixed(2)} point saver advantage, so bounded auto-tune should tighten it before broader lane changes.`;
}

function buildDomainWasteOutcome(item) {
  return `${item.domain} is the current cheap-domain cost hotspot, so fixing its local drift should reduce live spend without touching high-risk lanes.`;
}

function buildDomainImpactSummary(item) {
  const thresholdHint = item.suggestedThreshold
    ? `A tighter threshold around ${item.suggestedThreshold} is likely to cut weak review jobs earlier.`
    : "A tighter local gate is likely to cut weak review jobs earlier.";
  return `${item.domain} is carrying ${item.liveTokensUsed} live tokens with a ${item.reductionGap.toFixed(2)} point saver edge. ${thresholdHint}`;
}

function buildDomainEvidenceScore(item) {
  let score = 35;
  score += Math.min(25, Math.round((Number(item.liveTokensUsed) || 0) / 1000));
  score += Math.min(20, Math.round(Number(item.reductionGap) || 0));
  score += Math.min(15, (Number(item.saverTrendStreak) || 0) * 3);
  if (item.isNoisy) {
    score -= 18;
  }
  return Math.max(0, Math.min(100, score));
}

function inferEvidenceBand(score) {
  if (score >= 80) {
    return "high";
  }
  if (score >= 55) {
    return "medium";
  }
  return "low";
}

function inferRecommendedActionRisk(action) {
  if (action.includes("tune --reconcile")) {
    return "medium";
  }
  if (action.includes("tune --auto")) {
    return "medium";
  }
  return "low";
}

function inferRecommendedActionEvidenceScore(action) {
  if (action.includes("benchmark --iterations")) {
    return 82;
  }
  if (action.includes("benchmark")) {
    return 90;
  }
  if (action.includes("tune --reconcile")) {
    return 88;
  }
  if (action.includes("tune --auto")) {
    return 74;
  }
  if (action.includes("queue")) {
    return 58;
  }
  return 55;
}

function inferRecommendedActionOutcome(action) {
  if (action.includes("benchmark --iterations")) {
    return "Refreshes long-run synthetic evidence before more bounded tuning decisions are made.";
  }
  if (action.includes("benchmark")) {
    return "Refreshes the synthetic cost baseline that all bounded tuning and rollback decisions depend on.";
  }
  if (action.includes("tune --reconcile")) {
    return "Validates or rolls back the last canary so the next tuning step starts from a clean state.";
  }
  if (action.includes("tune --auto")) {
    return "Applies the highest-priority bounded tuning suggestions while respecting local safeguards and cooldowns.";
  }
  if (action.includes("worker")) {
    return "Lets the runtime clear stale execution state or finish an interrupted recovery path.";
  }
  return "Resolves the highest-priority local control-plane issue before more AI work is queued.";
}

function inferRecommendedActionImpact(action) {
  if (action.includes("benchmark --iterations")) {
    return "Strengthens long-run evidence before another bounded tuning cycle.";
  }
  if (action.includes("benchmark")) {
    return "Refreshes the baseline that later cost and rollback decisions depend on.";
  }
  if (action.includes("tune --reconcile")) {
    return "Prevents a stale canary from distorting the next tuning move.";
  }
  if (action.includes("tune --auto")) {
    return "Applies the highest-confidence bounded savings move available right now.";
  }
  if (action.includes("worker")) {
    return "Unblocks the runtime so queued work can continue safely.";
  }
  return "Improves runtime health through a bounded operator action.";
}
