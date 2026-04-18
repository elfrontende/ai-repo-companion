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
  return {
    queue: await inspectReviewQueue(rootDir),
    worker: await getWorkerState(rootDir),
    metrics: await summarizeReviewMetrics(rootDir),
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
