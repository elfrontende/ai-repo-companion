import fs from "node:fs/promises";
import path from "node:path";
import { inspectReviewQueue } from "./review-worker.mjs";
import { getWorkerState } from "./review-runner.mjs";
import { summarizeReviewMetrics } from "./review-metrics-engine.mjs";
import { readJson } from "./store.mjs";

// Status/doctor commands are operator-facing helpers.
// They intentionally summarize local runtime state instead of exposing raw
// internals that a repo owner would have to mentally reconstruct.

export async function getRuntimeStatus(rootDir, config = {}) {
  const queue = await inspectReviewQueue(rootDir);
  const metrics = await summarizeReviewMetrics(rootDir);
  const benchmarkSummary = await readBenchmarkSummary(rootDir, config, metrics);
  const tuningSummary = await readTuningSummary(rootDir, config);
  const costSummary = buildCostSummary(queue, metrics);
  return {
    queue,
    worker: await getWorkerState(rootDir),
    metrics,
    costSummary,
    benchmarkSummary,
    tuningSummary,
    nextActions: buildRuntimeNextActions(queue, costSummary, benchmarkSummary, tuningSummary),
    recovery: await readJson(path.join(rootDir, "state/reviews/recovery-state.json"), null)
  };
}

export async function runRuntimeDoctor(rootDir, config = {}) {
  const queue = await inspectReviewQueue(rootDir);
  const worker = await getWorkerState(rootDir);
  const recovery = await readJson(path.join(rootDir, "state/reviews/recovery-state.json"), null);
  const lock = await readJson(path.join(rootDir, "state/reviews/worker-lock.json"), null);
  const metrics = await summarizeReviewMetrics(rootDir);
  const benchmarkSummary = await readBenchmarkSummary(rootDir, config, metrics);
  const tuningSummary = await readTuningSummary(rootDir, config);
  const findings = [];

  if (worker.status === "running" && queue.running === 0) {
    findings.push({
      severity: "warning",
      code: "worker-state-mismatch",
      message: "Worker state says running, but the queue has no running jobs."
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
      message: "No synthetic benchmark report exists yet. Run `benchmark` before trusting cost recommendations."
    });
  } else if (benchmarkSummary.isStale) {
    findings.push({
      severity: "warning",
      code: "benchmark-stale",
      message: "The last synthetic benchmark is stale. Refresh it before changing runtime cost defaults."
    });
  }

  if (benchmarkSummary.cheapestVariant === "saver"
    && (config.reviewExecution?.reviewProfiles?.balanced?.codexReasoningEffort ?? "medium") !== "low") {
    findings.push({
      severity: "info",
      code: "balanced-lane-heavier-than-benchmark",
      message: "Synthetic benchmark says saver is cheaper, but balanced reasoning effort is still above the lean lane. Run `tune --auto` or lower the balanced profile manually."
    });
  }

  if (benchmarkSummary.cheapestVariant === "saver" && tuningSummary.loaded && tuningSummary.isStale) {
    findings.push({
      severity: "info",
      code: "auto-tune-stale",
      message: "Synthetic benchmark favors the saver lane, but the last auto-tune is stale. Consider running `tune --auto` again."
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

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    queue,
    worker,
    metrics,
    benchmarkSummary,
    tuningSummary,
    recommendedActions: buildDoctorRecommendedActions(findings),
    recovery,
    lock: lock ?? {},
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
    cheapestVariant: benchmark?.aggregate?.cheapestVariant ?? null,
    balancedReductionPercent: benchmark?.aggregate?.byVariant?.balanced?.reductionPercent ?? null,
    saverReductionPercent: benchmark?.aggregate?.byVariant?.saver?.reductionPercent ?? null,
    domainDiagnostics,
    topWasteDomains,
    safeSavingsOpportunities,
    domainTrend: benchmark?.trend?.byDomain ?? {},
    tuningComparison: benchmark?.tuningComparison ?? null
  };
}

async function readTuningSummary(rootDir, config = {}) {
  const tuning = await readJson(path.join(rootDir, "state/tuning/last-tuning.json"), null);
  const generatedAt = tuning?.generatedAt ?? null;
  const freshnessMinutes = config.tuning?.autoTuneFreshnessMinutes ?? 720;
  const ageMinutes = ageInMinutes(generatedAt);
  return {
    loaded: Boolean(tuning?.generatedAt),
    generatedAt,
    ageMinutes,
    isStale: ageMinutes > freshnessMinutes,
    mode: tuning?.mode ?? null,
    appliedCount: Array.isArray(tuning?.applied) ? tuning.applied.length : 0,
    blockedCount: Array.isArray(tuning?.blocked) ? tuning.blocked.length : 0,
    canaryStatus: tuning?.canary?.status ?? null,
    canaryReconciledAt: tuning?.canary?.reconciledAt ?? null
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
      cheapestVariant: item.cheapestVariant,
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
      whyRanked: `${item.domain} has a stable saver streak of ${item.saverTrendStreak} runs and still burns ${item.liveTokensUsed} live tokens, so tightening its local gate is the safest near-term savings move.`
    }));
}

function buildRuntimeNextActions(queue, costSummary, benchmarkSummary, tuningSummary) {
  const actions = [];

  if (!benchmarkSummary.loaded) {
    actions.push({
      priority: 100,
      action: "node src/cli.mjs benchmark",
      reason: "No synthetic benchmark exists yet, so tuning and cost guidance are still blind.",
      whyNow: "Benchmark data is the prerequisite for nearly every bounded tuning or rollback decision."
    });
  } else if (benchmarkSummary.isStale) {
    actions.push({
      priority: 95,
      action: "node src/cli.mjs benchmark",
      reason: "The last synthetic benchmark is stale, so current cost recommendations may be misleading.",
      whyNow: "Fresh benchmark evidence has higher priority than further tuning on stale numbers."
    });
  }

  if (tuningSummary.canaryStatus === "pending") {
    actions.push({
      priority: 92,
      action: "node src/cli.mjs tune --reconcile",
      reason: "A pending canary is waiting for a post-tune benchmark verdict.",
      whyNow: "Resolve the existing canary before stacking another tuning change on top of it."
    });
  }

  if (benchmarkSummary.tuningComparison?.available && benchmarkSummary.tuningComparison.outcome === "degraded") {
    actions.push({
      priority: 90,
      action: "node src/cli.mjs tune --reconcile",
      reason: benchmarkSummary.tuningComparison.summary,
      whyNow: "The latest benchmark already suggests a tuning regression, so rollback/reconcile outranks fresh tuning."
    });
  }

  const driftingDomain = benchmarkSummary.domainDiagnostics.find((item) => item.shouldTightenValueGate);
  if (driftingDomain) {
    actions.push({
      priority: 80,
      action: "node src/cli.mjs tune --auto",
      reason: `${driftingDomain.domain} still favors saver and is burning tokens above its configured domain gate.`,
      whyNow: `${driftingDomain.domain} is the highest-confidence cheap-domain drift signal in the current benchmark summary.`
    });
  }

  if (benchmarkSummary.cheapestVariant === "saver" && tuningSummary.isStale) {
    actions.push({
      priority: 70,
      action: "node src/cli.mjs tune --auto",
      reason: "Saver keeps winning synthetic cost checks, but the last auto-tune is stale.",
      whyNow: "The system already has a stable cheaper lane, so refreshing bounded auto-tune is more useful than manual tweaking."
    });
  }

  if (costSummary.queuePressure.balancedQueued >= 2 && costSummary.avgTokensPerSelectedOperation >= 20000) {
    actions.push({
      priority: 60,
      action: "Run the next live balanced review with --costMode saver",
      reason: "Balanced queue pressure is high while useful note work per token is still expensive.",
      whyNow: "This is the quickest operator-side cost reduction that does not mutate repository policy."
    });
  }

  if (queue.awaitingApproval > 0) {
    actions.push({
      priority: 55,
      action: "node src/cli.mjs queue",
      reason: "There are pending approvals waiting for a manual decision before notes can change.",
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
    actions.push({ priority, action, reason, whyNow: reason });
  };

  push(
    findings.some((item) => item.code === "benchmark-missing" || item.code === "benchmark-stale"),
    100,
    "node src/cli.mjs benchmark",
    "Refresh synthetic cost evidence before trusting runtime recommendations."
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

  return actions
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 5);
}
