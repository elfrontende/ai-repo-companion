import fs from "node:fs/promises";
import path from "node:path";
import { appendLine, listFiles, readJson, writeJson } from "./store.mjs";
import { assembleContext, loadNotes } from "./context-engine.mjs";
import { executeReviewPayload, persistReviewReport } from "./provider-engine.mjs";
import { applyReviewOperations } from "./review-note-engine.mjs";
import { evaluateReviewOperations } from "./review-quality-engine.mjs";
import { normalizeReviewOperations } from "./review-normalization-engine.mjs";
import { rankReviewOperations } from "./review-ranking-engine.mjs";
import { applyIdempotencyGuard } from "./review-idempotency-engine.mjs";
import { assessReviewValueGate } from "./review-value-gate-engine.mjs";
import {
  applyApprovalExpiryPolicy,
  assessReviewApprovalRequirement,
  approveReviewJob,
  createApprovalRequest
} from "./review-approval-engine.mjs";
import {
  beginReviewApplyRecovery,
  completeReviewApplyRecovery,
  recoverInterruptedReviewRun
} from "./review-recovery-engine.mjs";
import { acquireReviewLock, releaseReviewLock } from "./review-lock-engine.mjs";
import { recordReviewMetricsEvent } from "./review-metrics-engine.mjs";

// The review worker consumes queued memory jobs.
// It is intentionally separate from the main sync path so background review
// stays visible, inspectable, and easy to throttle.

export async function inspectReviewQueue(rootDir) {
  const queue = await readJson(path.join(rootDir, "state/memory/review-queue.json"), []);
  return {
    total: queue.length,
    queued: queue.filter((job) => job.status === "queued").length,
    running: queue.filter((job) => job.status === "running").length,
    awaitingApproval: queue.filter((job) => job.status === "awaiting-approval").length,
    completed: queue.filter((job) => job.status === "completed").length,
    failed: queue.filter((job) => job.status === "failed").length,
    jobs: queue
  };
}

export async function processReviewQueue(rootDir, config, options = {}) {
  const runtimeLock = await acquireReviewLock(rootDir, config.reviewExecution?.runtimeLock ?? {});
  if (!runtimeLock.acquired) {
    return {
      lock: runtimeLock,
      recovery: {
        recovered: false,
        reason: "Review queue was not touched because another worker owns the runtime lock."
      },
      approvalExpiry: {
        checked: 0,
        expired: 0,
        requeued: 0,
        completed: 0,
        changed: false
      },
      processedCount: 0,
      processed: [],
      retention: {
        enabled: false,
        deletedReportCount: 0,
        trimmedHistoryEntries: 0,
        remainingReportCount: 0,
        remainingHistoryEntries: 0
      }
    };
  }

  try {
  // Recovery runs first on every worker invocation.
  // If the previous process died during note apply, we want to restore notes
  // before touching the queue again.
  const recovery = await recoverInterruptedReviewRun(rootDir, config.reviewExecution?.recovery ?? {});
  const queuePath = path.join(rootDir, "state/memory/review-queue.json");
  const policyStatePath = path.join(rootDir, "state/memory/policy-state.json");
  const historyPath = path.join(rootDir, "state/reviews/history.jsonl");
  const queue = await readJson(queuePath, []);
  const policyState = await readJson(policyStatePath, {
    domains: {},
    recentModes: [],
    lastDecisionAt: null
  });
  const approvalExpiry = await applyApprovalExpiryPolicy(
    rootDir,
    queue,
    historyPath,
    config.reviewExecution?.approval ?? {}
  );
  if (approvalExpiry.changed) {
    await writeJson(queuePath, queue);
  }
  const maxJobs = Number(options.maxJobs) || config.reviewExecution?.maxJobsPerRun || 3;
  const runOnlyJobId = options.jobId ?? null;
  const jobs = queue.filter((job) => job.status === "queued" && (!runOnlyJobId || job.id === runOnlyJobId)).slice(0, maxJobs);
  const processed = [];

  for (const job of jobs) {
    const staleness = assessReviewJobStaleness(job, config.reviewExecution?.staleJobs ?? {});

    if (staleness.action === "skip") {
      const finishedAt = new Date().toISOString();
      const report = {
        job,
        payload: {
          job,
          contextBundle: null
        },
        execution: {
          provider: "local",
          adapter: "stale-policy",
          status: "skipped",
          output: {
            reason: "Review job exceeded the maximum allowed age and was skipped by stale-job policy."
          }
        },
        noteChanges: {
          applied: [],
          skipped: [],
          reason: "Review job was skipped because it became too old for a live run."
        },
        staleness,
        finishedAt
      };
      const reportPath = await persistReviewReport(rootDir, job.id, report);

      job.status = "completed";
      job.finishedAt = finishedAt;
      job.reportPath = reportPath;
      job.execution = {
        provider: "local",
        adapter: "stale-policy",
        status: "skipped"
      };
      job.staleness = staleness;

      releaseQueuedSlots(policyState, job.domains);

      await appendLine(historyPath, JSON.stringify({
        id: job.id,
        at: finishedAt,
        status: job.status,
        provider: "local",
        adapter: "stale-policy",
        reportPath
      }));

      processed.push({
        id: job.id,
        status: job.status,
        reportPath,
        provider: "local",
        adapter: "stale-policy",
        noteChanges: report.noteChanges
      });
      await recordReviewMetricsEvent(rootDir, {
        type: "review-processed",
        at: finishedAt,
        jobId: job.id,
        mode: job.mode,
        domains: job.domains,
        createdAt: job.createdAt,
        finishedAt,
        status: job.status,
        adapter: "stale-policy",
        payload: report.payload,
        execution: report.execution,
        noteChanges: report.noteChanges
      });

      await writeJson(queuePath, queue);
      await writeJson(policyStatePath, policyState);
      continue;
    }

    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.staleness = staleness;
    await writeJson(queuePath, queue);

    try {
      const effectiveConfig = options.reviewConfig ?? config;
      const payload = await buildReviewPayload(rootDir, job, staleness);
      const valueGate = assessReviewValueGate(
        job,
        payload,
        effectiveConfig.reviewExecution?.valueGate ?? {}
      );

      if (valueGate.shouldSkip) {
        const finishedAt = new Date().toISOString();
        const report = {
          job,
          payload,
          execution: {
            provider: "local",
            adapter: "value-policy",
            status: "skipped",
            output: {
              reason: "Review job was skipped before any live model call because it did not clear the local value gate.",
              usage: {
                totalTokens: 0,
                durationMs: 0
              }
            }
          },
          noteChanges: {
            selectedOperations: [],
            deferredOperations: [],
            applied: [],
            skipped: [],
            reason: valueGate.reason
          },
          valueGate,
          staleness,
          recovery: {
            completed: false,
            reason: "No local note apply was needed because the value gate skipped the review run."
          },
          finishedAt
        };
        const reportPath = await persistReviewReport(rootDir, job.id, report);

        job.status = "completed";
        job.finishedAt = finishedAt;
        job.reportPath = reportPath;
        job.execution = {
          provider: "local",
          adapter: "value-policy",
          status: "skipped"
        };
        job.valueGate = valueGate;

        releaseQueuedSlots(policyState, job.domains);

        await appendLine(historyPath, JSON.stringify({
          id: job.id,
          at: finishedAt,
          status: job.status,
          provider: "local",
          adapter: "value-policy",
          reportPath
        }));

        processed.push({
          id: job.id,
          status: job.status,
          reportPath,
          provider: "local",
          adapter: "value-policy",
          noteChanges: report.noteChanges
        });
        await recordReviewMetricsEvent(rootDir, {
          type: "review-processed",
          at: finishedAt,
          jobId: job.id,
          mode: job.mode,
          domains: job.domains,
          createdAt: job.createdAt,
          finishedAt,
          status: "skipped",
          adapter: "value-policy",
          payload,
          execution: report.execution,
          noteChanges: report.noteChanges
        });

        await writeJson(queuePath, queue);
        await writeJson(policyStatePath, policyState);
        continue;
      }

      const execution = await executeReviewPayload(rootDir, payload, effectiveConfig);
      const finishedAt = new Date().toISOString();
      const notePlan = await planReviewNoteChanges(rootDir, execution, effectiveConfig, job);
      const approvalDecision = assessReviewApprovalRequirement(
        job,
        effectiveConfig.reviewExecution?.approval ?? {}
      );
      let noteChanges = notePlan;
      let recoveryCompletion = {
        completed: false,
        reason: "No local note apply was needed for this review run."
      };

      if (notePlan.shouldApply && approvalDecision.required) {
        const pendingApprovalReportPath = await persistReviewReport(rootDir, job.id, {
          job,
          payload,
          execution,
          noteChanges: {
            ...notePlan,
            approval: {
              status: "pending",
              reasons: approvalDecision.reasons,
              pendingAt: finishedAt
            },
            applied: [],
            skipped: notePlan.skipped ?? [],
            reason: "Review run produced valid note changes, but local approval is required before apply."
          },
          staleness,
          recovery: {
            stage: "not-needed"
          }
        });
        const approvalRequest = await createApprovalRequest(
          rootDir,
          job,
          pendingApprovalReportPath,
          notePlan,
          approvalDecision
        );
        noteChanges = {
          ...notePlan,
          approval: {
            status: "pending",
            reasons: approvalDecision.reasons,
            pendingAt: finishedAt,
            approvalPath: approvalRequest.approvalPath
          },
          applied: [],
          reason: "Review run is waiting for explicit approval before note apply."
        };
      } else if (notePlan.shouldApply) {
        // Persist a pre-apply report before we mutate any note files.
        // This gives recovery code a stable artifact to update later if the
        // process crashes in the middle of note application.
        const pendingReportPath = await persistReviewReport(rootDir, job.id, {
          job,
          payload,
          execution,
          noteChanges: {
            applied: [],
            skipped: [],
            reason: "Review execution completed. Local note apply has not finished yet."
          },
          staleness,
          recovery: {
            stage: "pending-apply"
          }
        });
        const recoverySession = await beginReviewApplyRecovery(
          rootDir,
          job,
          pendingReportPath,
          effectiveConfig.reviewExecution?.recovery ?? {}
        );
        noteChanges = await applyPlannedReviewNoteChanges(rootDir, notePlan, finishedAt);
        // Once note apply succeeds, the recovery session can be cleared.
        // If note apply throws before this point, the session stays on disk and
        // the next worker run will restore the backup automatically.
        recoveryCompletion = await completeReviewApplyRecovery(
          rootDir,
          recoverySession,
          effectiveConfig.reviewExecution?.recovery ?? {}
        );
      }

      const report = {
        job,
        payload,
        execution,
        noteChanges,
        valueGate,
        staleness,
        recovery: recoveryCompletion,
        finishedAt
      };
      const reportPath = await persistReviewReport(rootDir, job.id, report);

      job.status = execution.status === "failed"
        ? "failed"
        : (noteChanges.approval?.status === "pending" ? "awaiting-approval" : "completed");
      job.finishedAt = finishedAt;
      job.reportPath = reportPath;
      job.execution = {
        provider: execution.provider,
        adapter: execution.adapter,
        status: execution.status
      };
      if (noteChanges.approval?.status === "pending") {
        job.approval = noteChanges.approval;
      }

      if (job.status === "completed" || job.status === "awaiting-approval") {
        releaseQueuedSlots(policyState, job.domains);
      }

      await appendLine(historyPath, JSON.stringify({
        id: job.id,
        at: finishedAt,
        status: job.status,
        provider: execution.provider,
        adapter: execution.adapter,
        reportPath
      }));

      processed.push({
        id: job.id,
        status: job.status,
        reportPath,
        provider: execution.provider,
        adapter: execution.adapter,
        noteChanges
      });
      await recordReviewMetricsEvent(rootDir, {
        type: "review-processed",
        at: finishedAt,
        jobId: job.id,
        mode: job.mode,
        domains: job.domains,
        createdAt: job.createdAt,
        finishedAt,
        status: job.status,
        adapter: execution.adapter,
        payload,
        execution,
        noteChanges
      });
    } catch (error) {
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = error.message;
      processed.push({
        id: job.id,
        status: "failed",
        error: error.message
      });
      await recordReviewMetricsEvent(rootDir, {
        type: "review-processed",
        at: job.finishedAt,
        jobId: job.id,
        mode: job.mode,
        domains: job.domains,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
        status: "failed",
        adapter: job.execution?.adapter ?? "unknown",
        execution: {
          output: {
            usage: {
              totalTokens: 0,
              durationMs: 0
            }
          }
        },
        noteChanges: {
          applied: [],
          skipped: [],
          reason: error.message
        }
      });
    }

    await writeJson(queuePath, queue);
    await writeJson(policyStatePath, policyState);
  }

  const retention = await applyReviewRetention(rootDir, config.reviewExecution?.retention ?? {});

  return {
    lock: runtimeLock,
    recovery,
    approvalExpiry,
    processedCount: processed.length,
    processed,
    retention
  };
  } finally {
    await releaseReviewLock(rootDir, runtimeLock);
  }
}

export async function applyReviewRetention(rootDir, config = {}) {
  const retentionConfig = {
    enabled: config.enabled !== false,
    maxReportFiles: Math.max(1, Number(config.maxReportFiles) || 25),
    maxHistoryEntries: Math.max(1, Number(config.maxHistoryEntries) || 200)
  };

  if (!retentionConfig.enabled) {
    return {
      enabled: false,
      deletedReportCount: 0,
      trimmedHistoryEntries: 0,
      remainingReportCount: 0,
      remainingHistoryEntries: 0
    };
  }

  const reportsDir = path.join(rootDir, "state/reviews/reports");
  const historyPath = path.join(rootDir, "state/reviews/history.jsonl");

  // Report retention is filename-based because report names are timestamped.
  // Oldest report files sort first, so trimming from the front is stable and
  // easy to understand for someone inspecting the folder manually.
  const reportFiles = await listFiles(reportsDir, ".json");
  const reportsToDelete = reportFiles.slice(0, Math.max(0, reportFiles.length - retentionConfig.maxReportFiles));
  for (const reportFile of reportsToDelete) {
    await fs.rm(reportFile, { force: true });
  }

  const historyRaw = await fs.readFile(historyPath, "utf8").catch(() => "");
  const historyLines = historyRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const retainedHistory = historyLines.slice(-retentionConfig.maxHistoryEntries);
  const trimmedHistoryEntries = historyLines.length - retainedHistory.length;

  if (trimmedHistoryEntries > 0) {
    const nextHistory = retainedHistory.length > 0 ? `${retainedHistory.join("\n")}\n` : "";
    await fs.writeFile(historyPath, nextHistory, "utf8");
  }

  return {
    enabled: true,
    config: retentionConfig,
    deletedReportCount: reportsToDelete.length,
    trimmedHistoryEntries,
    remainingReportCount: reportFiles.length - reportsToDelete.length,
    remainingHistoryEntries: retainedHistory.length
  };
}

async function buildReviewPayload(rootDir, job) {
  // Review jobs use the same bounded retrieval strategy as normal task work.
  // This prevents the memory maintenance layer from becoming a token sink.
  const notes = await loadNotes(rootDir);
  const mergedTasks = Array.isArray(job.tasks) && job.tasks.length > 0
    ? job.tasks.map((entry) => entry.task).join(" ")
    : job.task;
  const contextTask = `${mergedTasks} ${job.domains.join(" ")} ${job.mode} memory review`;
  const contextBundle = assembleContext(contextTask, notes, {
    tokenBudget: job.budget,
    maxNotes: 8
  });

  return {
    job,
    staleness: job.staleness ?? null,
    contextBundle
  };
}

function assessReviewJobStaleness(job, config = {}) {
  const policy = {
    enabled: config.enabled !== false,
    staleAfterMinutes: Math.max(1, Number(config.staleAfterMinutes) || 60),
    maxAgeMinutes: Math.max(1, Number(config.maxAgeMinutes) || 240),
    skipExpired: config.skipExpired !== false
  };

  if (!policy.enabled) {
    return {
      enabled: false,
      level: "fresh",
      ageMinutes: 0,
      action: "process"
    };
  }

  const referenceTime = job.lastCompactedAt ?? job.createdAt;
  const createdAtMs = Date.parse(referenceTime);
  if (!Number.isFinite(createdAtMs)) {
    return {
      enabled: true,
      level: "fresh",
      ageMinutes: 0,
      action: "process"
    };
  }

  const ageMinutes = Math.max(0, Math.floor((Date.now() - createdAtMs) / 60000));
  if (ageMinutes >= policy.maxAgeMinutes && policy.skipExpired) {
    return {
      enabled: true,
      level: "expired",
      ageMinutes,
      staleAfterMinutes: policy.staleAfterMinutes,
      maxAgeMinutes: policy.maxAgeMinutes,
      action: "skip"
    };
  }

  if (ageMinutes >= policy.staleAfterMinutes) {
    return {
      enabled: true,
      level: "stale",
      ageMinutes,
      staleAfterMinutes: policy.staleAfterMinutes,
      maxAgeMinutes: policy.maxAgeMinutes,
      action: "process"
    };
  }

  return {
    enabled: true,
    level: "fresh",
    ageMinutes,
    staleAfterMinutes: policy.staleAfterMinutes,
    maxAgeMinutes: policy.maxAgeMinutes,
    action: "process"
  };
}

function releaseQueuedSlots(policyState, domains) {
  for (const domain of domains) {
    const current = policyState.domains?.[domain];
    if (!current) {
      continue;
    }
    current.queuedJobs = Math.max(0, (current.queuedJobs ?? 0) - 1);
  }
}

async function maybeApplyReviewOperations(rootDir, execution, config, timestamp) {
  const notePlan = await planReviewNoteChanges(rootDir, execution, config, { mode: "unknown", domains: [] });
  if (!notePlan.shouldApply) {
    return notePlan;
  }

  return applyPlannedReviewNoteChanges(rootDir, notePlan, timestamp);
}

export async function planReviewNoteChanges(rootDir, execution, config, job = { mode: "unknown", domains: [] }) {
  const operations = execution.output?.parsed?.operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    return {
      qualityGate: {
        passed: false,
        accepted: [],
        rejected: [],
        reason: "Execution produced no structured note operations."
      },
      selectedOperations: [],
      deferredOperations: [],
      shouldApply: false,
      applied: [],
      skipped: [],
      reason: "Execution produced no structured note operations."
    };
  }

  const normalized = await normalizeReviewOperations(rootDir, operations);
  const qualityGate = await evaluateReviewOperations(rootDir, normalized.normalized);
  if (!qualityGate.passed) {
    return {
      normalization: normalized,
      qualityGate,
      selectedOperations: [],
      deferredOperations: [],
      shouldApply: false,
      applied: [],
      skipped: qualityGate.rejected,
      reason: qualityGate.reason
    };
  }

  const idempotency = await applyIdempotencyGuard(
    rootDir,
    qualityGate.accepted,
    config.reviewExecution?.idempotency ?? {}
  );
  if (!idempotency.passed) {
    return {
      normalization: normalized,
      qualityGate,
      idempotency,
      selectedOperations: [],
      deferredOperations: [],
      shouldApply: false,
      applied: [],
      skipped: idempotency.rejected,
      reason: idempotency.reason
    };
  }

  const ranking = await rankReviewOperations(
    rootDir,
    idempotency.accepted,
    config.reviewExecution?.operationRanking ?? {}
  );
  if (!ranking.passed) {
    return {
      normalization: normalized,
      qualityGate,
      idempotency,
      ranking,
      selectedOperations: [],
      deferredOperations: ranking.deferred,
      shouldApply: false,
      applied: [],
      skipped: ranking.deferred,
      reason: ranking.reason
    };
  }

  return {
    normalization: normalized,
    qualityGate,
    idempotency,
    ranking,
    selectedOperations: ranking.selected,
    deferredOperations: ranking.deferred,
    shouldApply: ranking.selected.length > 0,
    applied: [],
    skipped: ranking.deferred
  };
}

async function applyPlannedReviewNoteChanges(rootDir, notePlan, timestamp) {
  const appliedResult = await applyReviewOperations(rootDir, notePlan.selectedOperations ?? [], { timestamp });
  return {
    ...notePlan,
    ...appliedResult
  };
}

export async function approvePendingReview(rootDir, jobId, config) {
  return approveReviewJob(rootDir, jobId, config);
}
