import fs from "node:fs/promises";
import path from "node:path";
import { appendLine, readJson, writeJson } from "./store.mjs";
import { applyReviewOperations } from "./review-note-engine.mjs";
import {
  beginReviewApplyRecovery,
  completeReviewApplyRecovery
} from "./review-recovery-engine.mjs";
import { recordReviewMetricsEvent } from "./review-metrics-engine.mjs";

// Approval policy is the explicit "human checkpoint" for sensitive review runs.
// The worker can still do the expensive thinking, but note writes wait until a
// person says "yes, apply these changes".

export function assessReviewApprovalRequirement(job, config = {}) {
  // This function only decides whether a human checkpoint is required.
  // It keeps side effects out of the policy decision so tests stay simple.
  const policy = normalizeApprovalConfig(config);
  if (!policy.enabled) {
    return {
      required: false,
      reasons: [],
      policy
    };
  }

  const reasons = [];
  if (policy.requireForModes.includes(job.mode)) {
    reasons.push(`mode:${job.mode}`);
  }

  const matchingDomains = (job.domains ?? []).filter((domain) => policy.requireForDomains.includes(domain));
  for (const domain of matchingDomains) {
    reasons.push(`domain:${domain}`);
  }

  return {
    required: reasons.length > 0,
    reasons,
    policy
  };
}

export async function createApprovalRequest(rootDir, job, reportPath, notePlan, decision) {
  // The approval file freezes the selected operations so later approval does
  // not depend on rerunning the provider and getting a different answer.
  const approvalPath = path.join(rootDir, "state/reviews/approvals", `${job.id}.json`);
  const createdAt = new Date().toISOString();
  const request = {
    id: job.id,
    createdAt,
    jobId: job.id,
    jobMode: job.mode,
    domains: job.domains ?? [],
    reasons: decision.reasons,
    reportPath,
    selectedOperations: notePlan.selectedOperations ?? [],
    deferredOperations: notePlan.deferredOperations ?? []
  };
  await writeJson(approvalPath, request);
  return {
    approvalPath,
    request
  };
}

export async function applyApprovalExpiryPolicy(rootDir, queue, historyPath, config = {}) {
  // Approvals should not wait forever because the repo context can drift while
  // a pending decision sits untouched.
  const policy = normalizeApprovalConfig(config);
  if (!policy.enabled || policy.pendingApprovalTtlMinutes <= 0) {
    return {
      checked: 0,
      expired: 0,
      requeued: 0,
      completed: 0,
      changed: false
    };
  }

  let expired = 0;
  let requeued = 0;
  let completed = 0;
  let changed = false;
  const checkedJobs = queue.filter((job) => job.status === "awaiting-approval");

  for (const job of checkedJobs) {
    const pendingAt = job.approval?.pendingAt ?? job.finishedAt ?? job.createdAt;
    const pendingAtMs = Date.parse(pendingAt);
    if (!Number.isFinite(pendingAtMs)) {
      continue;
    }

    const ageMinutes = Math.max(0, Math.floor((Date.now() - pendingAtMs) / 60000));
    if (ageMinutes < policy.pendingApprovalTtlMinutes) {
      continue;
    }

    expired += 1;
    changed = true;
    const expiredAt = new Date().toISOString();
    const approvalPath = path.join(rootDir, "state/reviews/approvals", `${job.id}.json`);
    const report = await readJson(job.reportPath, null);

    if (policy.onExpired === "requeue") {
      job.status = "queued";
      job.startedAt = null;
      job.finishedAt = null;
      job.approval = {
        status: "expired",
        expiredAt,
        action: "requeue",
        reason: "Pending approval exceeded the configured TTL, so the job was re-queued for a fresh review pass."
      };
      job.approvalExpiry = {
        expiredAt,
        ageMinutes,
        action: "requeue"
      };
      requeued += 1;
    } else {
      job.status = "completed";
      job.finishedAt = expiredAt;
      job.approval = {
        status: "expired",
        expiredAt,
        action: "expire",
        reason: "Pending approval exceeded the configured TTL and was closed without applying note changes."
      };
      job.approvalExpiry = {
        expiredAt,
        ageMinutes,
        action: "expire"
      };
      completed += 1;
    }

    if (report) {
      report.job = {
        ...(report.job ?? job),
        ...job
      };
      report.noteChanges = {
        ...(report.noteChanges ?? {}),
        approval: {
          ...(report.noteChanges?.approval ?? {}),
          status: "expired",
          expiredAt,
          ageMinutes,
          action: policy.onExpired
        },
        reason: policy.onExpired === "requeue"
          ? "Pending approval expired and the review job was re-queued for a fresh run."
          : "Pending approval expired and the review job was closed without local note apply."
      };
      report.approvalExpiry = {
        expiredAt,
        ageMinutes,
        action: policy.onExpired
      };
      await writeJson(job.reportPath, report);
    }

    await appendLine(historyPath, JSON.stringify({
      id: job.id,
      at: expiredAt,
      status: policy.onExpired === "requeue" ? "approval-expired-requeued" : "approval-expired",
      provider: "local",
      adapter: "approval-expiry-policy",
      reportPath: job.reportPath ?? null
    }));
    await recordReviewMetricsEvent(rootDir, {
      type: "approval-expired",
      at: expiredAt,
      jobId: job.id,
      mode: job.mode,
      status: "expired",
      action: policy.onExpired,
      ageMinutes
    });

    await fs.rm(approvalPath, { force: true }).catch(() => {});
  }

  return {
    checked: checkedJobs.length,
    expired,
    requeued,
    completed,
    changed
  };
}

export async function approveReviewJob(rootDir, jobId, config = {}) {
  // Manual approval reuses the same recovery-safe apply path as the worker so
  // "auto apply" and "approved apply" behave the same way.
  const queuePath = path.join(rootDir, "state/memory/review-queue.json");
  const historyPath = path.join(rootDir, "state/reviews/history.jsonl");
  const approvalPath = path.join(rootDir, "state/reviews/approvals", `${jobId}.json`);
  const queue = await readJson(queuePath, []);
  const job = queue.find((entry) => entry.id === jobId);

  if (!job) {
    throw new Error(`Review job "${jobId}" does not exist.`);
  }
  if (job.status !== "awaiting-approval") {
    throw new Error(`Review job "${jobId}" is not waiting for approval.`);
  }

  const approvalRequest = await readJson(approvalPath, null);
  if (!approvalRequest) {
    throw new Error(`Approval request for job "${jobId}" does not exist.`);
  }

  const report = await readJson(job.reportPath, null);
  if (!report) {
    throw new Error(`Review report for job "${jobId}" does not exist.`);
  }

  const timestamp = new Date().toISOString();
  const recoverySession = await beginReviewApplyRecovery(
    rootDir,
    job,
    job.reportPath,
    config.reviewExecution?.recovery ?? {}
  );
  const appliedResult = await applyReviewOperations(rootDir, approvalRequest.selectedOperations ?? [], { timestamp });
  const recovery = await completeReviewApplyRecovery(
    rootDir,
    recoverySession,
    config.reviewExecution?.recovery ?? {}
  );

  job.status = "completed";
  job.finishedAt = timestamp;
  job.approval = {
    status: "approved",
    approvedAt: timestamp,
    approvalPath
  };

  report.noteChanges = {
    ...(report.noteChanges ?? {}),
    applied: appliedResult.applied,
    skipped: appliedResult.skipped,
    approval: {
      status: "approved",
      approvedAt: timestamp,
      reasons: approvalRequest.reasons ?? []
    },
    reason: "Pending review changes were approved and applied locally."
  };
  report.recovery = recovery;
  report.finishedAt = timestamp;
  report.job = {
    ...(report.job ?? job),
    ...job
  };

  await writeJson(job.reportPath, report);
  await writeJson(queuePath, queue);
  await appendLine(historyPath, JSON.stringify({
    id: job.id,
    at: timestamp,
    status: "approved",
    provider: "local",
    adapter: "approval-policy",
    reportPath: job.reportPath
  }));
  await recordReviewMetricsEvent(rootDir, {
    type: "approval-applied",
    at: timestamp,
    jobId: job.id,
    mode: job.mode,
    status: "approved",
    pendingAt: approvalRequest.createdAt ?? job.approval?.pendingAt ?? job.finishedAt,
    approvedAt: timestamp
  });
  await fs.rm(approvalPath, { force: true }).catch(() => {});

  return {
    jobId,
    status: "approved",
    approvalPath,
    reportPath: job.reportPath,
    noteChanges: report.noteChanges
  };
}

function normalizeApprovalConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    strategy: config.strategy ?? "suggest-only",
    requireForModes: Array.isArray(config.requireForModes) ? config.requireForModes : ["expensive"],
    requireForDomains: Array.isArray(config.requireForDomains) ? config.requireForDomains : ["security"],
    pendingApprovalTtlMinutes: Math.max(0, Number(config.pendingApprovalTtlMinutes) || 240),
    onExpired: config.onExpired === "expire" ? "expire" : "requeue"
  };
}
