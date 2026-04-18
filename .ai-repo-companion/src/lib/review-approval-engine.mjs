import fs from "node:fs/promises";
import path from "node:path";
import { appendLine, readJson, writeJson } from "./store.mjs";
import { applyReviewOperations } from "./review-note-engine.mjs";
import {
  beginReviewApplyRecovery,
  completeReviewApplyRecovery
} from "./review-recovery-engine.mjs";

// Approval policy is the explicit "human checkpoint" for sensitive review runs.
// The worker can still do the expensive thinking, but note writes wait until a
// person says "yes, apply these changes".

export function assessReviewApprovalRequirement(job, config = {}) {
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
  const approvalPath = path.join(rootDir, "state/reviews/approvals", `${job.id}.json`);
  const request = {
    id: job.id,
    createdAt: new Date().toISOString(),
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

export async function approveReviewJob(rootDir, jobId, config = {}) {
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
    requireForDomains: Array.isArray(config.requireForDomains) ? config.requireForDomains : ["security"]
  };
}
