import fs from "node:fs/promises";
import path from "node:path";
import { inspectReviewQueue } from "./review-worker.mjs";
import { getWorkerState } from "./review-runner.mjs";
import { summarizeReviewMetrics } from "./review-metrics-engine.mjs";
import { readJson } from "./store.mjs";

// Status/doctor commands are operator-facing helpers.
// They intentionally summarize local runtime state instead of exposing raw
// internals that a repo owner would have to mentally reconstruct.

export async function getRuntimeStatus(rootDir) {
  const queue = await inspectReviewQueue(rootDir);
  const metrics = await summarizeReviewMetrics(rootDir);
  return {
    queue,
    worker: await getWorkerState(rootDir),
    metrics,
    costSummary: buildCostSummary(queue, metrics),
    recovery: await readJson(path.join(rootDir, "state/reviews/recovery-state.json"), null)
  };
}

export async function runRuntimeDoctor(rootDir, config = {}) {
  const queue = await inspectReviewQueue(rootDir);
  const worker = await getWorkerState(rootDir);
  const recovery = await readJson(path.join(rootDir, "state/reviews/recovery-state.json"), null);
  const lock = await readJson(path.join(rootDir, "state/reviews/worker-lock.json"), null);
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

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    queue,
    worker,
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
