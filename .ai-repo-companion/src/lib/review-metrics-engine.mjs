import path from "node:path";
import { readJson, writeJson } from "./store.mjs";

// Review metrics stay local and intentionally simple.
// We want enough signal to tune the pipeline later, but not a second
// analytics system that is harder to understand than the runtime itself.

export async function getReviewMetrics(rootDir) {
  return readJson(path.join(rootDir, "state/reviews/metrics.json"), createEmptyMetrics());
}

export async function recordReviewMetricsEvent(rootDir, event = {}) {
  const metrics = await getReviewMetrics(rootDir);
  const next = {
    ...metrics,
    updatedAt: new Date().toISOString()
  };

  switch (event.type) {
    case "review-processed":
      applyProcessedReviewMetrics(next, event);
      break;
    case "approval-applied":
      applyApprovalMetrics(next, event);
      break;
    case "approval-expired":
      applyApprovalExpiryMetrics(next, event);
      break;
    case "recovery-run":
      applyRecoveryMetrics(next, event);
      break;
    default:
      break;
  }

  next.recentEvents = [
    {
      type: event.type ?? "unknown",
      at: event.at ?? new Date().toISOString(),
      jobId: event.jobId ?? null,
      mode: event.mode ?? null,
      status: event.status ?? null
    },
    ...next.recentEvents
  ].slice(0, 20);

  await writeJson(path.join(rootDir, "state/reviews/metrics.json"), next);
  return next;
}

export async function summarizeReviewMetrics(rootDir) {
  const metrics = await getReviewMetrics(rootDir);
  return {
    counters: metrics.counters,
    queueLatency: summarizeLatency(metrics.latencies.queueMinutes),
    approvalLatency: summarizeLatency(metrics.latencies.approvalMinutes),
    topAdapters: sortEntries(metrics.byAdapter),
    topModes: sortEntries(metrics.byMode),
    recentEvents: metrics.recentEvents
  };
}

function createEmptyMetrics() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    counters: {
      processedJobs: 0,
      completedJobs: 0,
      failedJobs: 0,
      skippedJobs: 0,
      awaitingApprovalJobs: 0,
      approvalsApplied: 0,
      approvalsExpiredRequeued: 0,
      approvalsExpiredClosed: 0,
      recoveredRuns: 0,
      noteApplyRuns: 0,
      appliedOperations: 0,
      skippedOperations: 0,
      rejectedOperations: 0,
      deferredOperations: 0
    },
    latencies: {
      queueMinutes: createLatencyBucket(),
      approvalMinutes: createLatencyBucket()
    },
    byAdapter: {},
    byMode: {},
    recentEvents: []
  };
}

function applyProcessedReviewMetrics(metrics, event) {
  metrics.counters.processedJobs += 1;
  incrementKey(metrics.byAdapter, event.adapter ?? "unknown");
  incrementKey(metrics.byMode, event.mode ?? "unknown");

  if (event.status === "completed") {
    metrics.counters.completedJobs += 1;
  } else if (event.status === "failed") {
    metrics.counters.failedJobs += 1;
  } else if (event.status === "awaiting-approval") {
    metrics.counters.awaitingApprovalJobs += 1;
  } else {
    metrics.counters.skippedJobs += 1;
  }

  if (event.createdAt && event.finishedAt) {
    addLatencySample(metrics.latencies.queueMinutes, diffMinutes(event.createdAt, event.finishedAt));
  }

  if (event.noteChanges) {
    metrics.counters.appliedOperations += Array.isArray(event.noteChanges.applied)
      ? event.noteChanges.applied.length
      : 0;
    metrics.counters.skippedOperations += Array.isArray(event.noteChanges.skipped)
      ? event.noteChanges.skipped.length
      : 0;
    metrics.counters.rejectedOperations += Array.isArray(event.noteChanges.qualityGate?.rejected)
      ? event.noteChanges.qualityGate.rejected.length
      : 0;
    metrics.counters.deferredOperations += Array.isArray(event.noteChanges.deferredOperations)
      ? event.noteChanges.deferredOperations.length
      : 0;

    if (Array.isArray(event.noteChanges.applied) && event.noteChanges.applied.length > 0) {
      metrics.counters.noteApplyRuns += 1;
    }
  }
}

function applyApprovalMetrics(metrics, event) {
  metrics.counters.approvalsApplied += 1;
  if (event.pendingAt && event.approvedAt) {
    addLatencySample(metrics.latencies.approvalMinutes, diffMinutes(event.pendingAt, event.approvedAt));
  }
}

function applyApprovalExpiryMetrics(metrics, event) {
  if (event.action === "requeue") {
    metrics.counters.approvalsExpiredRequeued += 1;
  } else {
    metrics.counters.approvalsExpiredClosed += 1;
  }

  if (typeof event.ageMinutes === "number") {
    addLatencySample(metrics.latencies.approvalMinutes, event.ageMinutes);
  }
}

function applyRecoveryMetrics(metrics, event) {
  if (event.recovered) {
    metrics.counters.recoveredRuns += 1;
  }
}

function createLatencyBucket() {
  return {
    count: 0,
    total: 0,
    max: 0,
    last: 0
  };
}

function addLatencySample(bucket, minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) {
    return;
  }
  bucket.count += 1;
  bucket.total += minutes;
  bucket.max = Math.max(bucket.max, minutes);
  bucket.last = minutes;
}

function summarizeLatency(bucket) {
  return {
    count: bucket.count,
    avg: bucket.count > 0 ? Number((bucket.total / bucket.count).toFixed(2)) : 0,
    max: bucket.max,
    last: bucket.last
  };
}

function diffMinutes(startAt, endAt) {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 0;
  }
  return Math.max(0, Math.round((endMs - startMs) / 60000));
}

function incrementKey(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function sortEntries(map) {
  return Object.entries(map)
    .sort((left, right) => right[1] - left[1])
    .map(([key, count]) => ({ key, count }));
}
