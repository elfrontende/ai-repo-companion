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
  return {
    queue,
    worker: await getWorkerState(rootDir),
    metrics,
    costSummary: buildCostSummary(queue, metrics),
    benchmarkSummary,
    tuningSummary,
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

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    queue,
    worker,
    metrics,
    benchmarkSummary,
    tuningSummary,
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
  return {
    loaded: Boolean(benchmark?.aggregate),
    generatedAt,
    ageMinutes,
    isStale: ageMinutes > freshnessMinutes,
    cheapestVariant: benchmark?.aggregate?.cheapestVariant ?? null,
    balancedReductionPercent: benchmark?.aggregate?.byVariant?.balanced?.reductionPercent ?? null,
    saverReductionPercent: benchmark?.aggregate?.byVariant?.saver?.reductionPercent ?? null,
    domainDiagnostics,
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
      const shouldTightenValueGate = summary?.cheapestVariant === "saver"
        && reductionGap >= 4
        && saverTrendStreak >= 2
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
