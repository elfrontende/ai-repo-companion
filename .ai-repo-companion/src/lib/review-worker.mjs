import path from "node:path";
import { appendLine, readJson, writeJson } from "./store.mjs";
import { assembleContext, loadNotes } from "./context-engine.mjs";
import { executeReviewPayload, persistReviewReport } from "./provider-engine.mjs";
import { applyReviewOperations } from "./review-note-engine.mjs";
import { evaluateReviewOperations } from "./review-quality-engine.mjs";
import { normalizeReviewOperations } from "./review-normalization-engine.mjs";
import { rankReviewOperations } from "./review-ranking-engine.mjs";
import { applyIdempotencyGuard } from "./review-idempotency-engine.mjs";

// The review worker consumes queued memory jobs.
// It is intentionally separate from the main sync path so background review
// stays visible, inspectable, and easy to throttle.

export async function inspectReviewQueue(rootDir) {
  const queue = await readJson(path.join(rootDir, "state/memory/review-queue.json"), []);
  return {
    total: queue.length,
    queued: queue.filter((job) => job.status === "queued").length,
    running: queue.filter((job) => job.status === "running").length,
    completed: queue.filter((job) => job.status === "completed").length,
    failed: queue.filter((job) => job.status === "failed").length,
    jobs: queue
  };
}

export async function processReviewQueue(rootDir, config, options = {}) {
  const queuePath = path.join(rootDir, "state/memory/review-queue.json");
  const policyStatePath = path.join(rootDir, "state/memory/policy-state.json");
  const historyPath = path.join(rootDir, "state/reviews/history.jsonl");
  const queue = await readJson(queuePath, []);
  const policyState = await readJson(policyStatePath, {
    domains: {},
    recentModes: [],
    lastDecisionAt: null
  });
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

      await writeJson(queuePath, queue);
      await writeJson(policyStatePath, policyState);
      continue;
    }

    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.staleness = staleness;
    await writeJson(queuePath, queue);

    try {
      const payload = await buildReviewPayload(rootDir, job, staleness);
      const effectiveConfig = options.reviewConfig ?? config;
      const execution = await executeReviewPayload(rootDir, payload, effectiveConfig);
      const finishedAt = new Date().toISOString();
      const noteChanges = await maybeApplyReviewOperations(rootDir, execution, effectiveConfig, finishedAt);
      const report = {
        job,
        payload,
        execution,
        noteChanges,
        staleness,
        finishedAt
      };
      const reportPath = await persistReviewReport(rootDir, job.id, report);

      job.status = execution.status === "failed" ? "failed" : "completed";
      job.finishedAt = finishedAt;
      job.reportPath = reportPath;
      job.execution = {
        provider: execution.provider,
        adapter: execution.adapter,
        status: execution.status
      };

      if (job.status === "completed") {
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
    } catch (error) {
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = error.message;
      processed.push({
        id: job.id,
        status: "failed",
        error: error.message
      });
    }

    await writeJson(queuePath, queue);
    await writeJson(policyStatePath, policyState);
  }

  return {
    processedCount: processed.length,
    processed
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
  const operations = execution.output?.parsed?.operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    return {
      qualityGate: {
        passed: false,
        accepted: [],
        rejected: [],
        reason: "Execution produced no structured note operations."
      },
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
      applied: [],
      skipped: ranking.deferred,
      reason: ranking.reason
    };
  }

  const appliedResult = await applyReviewOperations(rootDir, ranking.selected, { timestamp });
  return {
    normalization: normalized,
    qualityGate,
    idempotency,
    ranking,
    ...appliedResult
  };
}
