import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureWorkspace } from "../src/lib/bootstrap.mjs";
import { readJson, writeJson } from "../src/lib/store.mjs";
import { classifyTask } from "../src/lib/task-engine.mjs";
import { planAgents } from "../src/lib/agent-engine.mjs";
import { assembleContext, loadNotes } from "../src/lib/context-engine.mjs";
import { syncMemory } from "../src/lib/memory-engine.mjs";
import { applyMemoryPolicyOutcome, evaluateMemoryPolicy } from "../src/lib/policy-engine.mjs";
import {
  applyReviewRetention,
  approvePendingReview,
  inspectReviewQueue,
  planReviewNoteChanges,
  processReviewQueue
} from "../src/lib/review-worker.mjs";
import { applyReviewOperations } from "../src/lib/review-note-engine.mjs";
import { getWorkerState, runReviewWorker } from "../src/lib/review-runner.mjs";
import { runTaskFlow } from "../src/lib/task-flow-engine.mjs";
import { evaluateReviewOperations } from "../src/lib/review-quality-engine.mjs";
import { normalizeReviewOperations } from "../src/lib/review-normalization-engine.mjs";
import { rankReviewOperations } from "../src/lib/review-ranking-engine.mjs";
import { applyIdempotencyGuard } from "../src/lib/review-idempotency-engine.mjs";
import {
  applyApprovalExpiryPolicy,
  assessReviewApprovalRequirement,
  createApprovalRequest
} from "../src/lib/review-approval-engine.mjs";
import {
  beginReviewApplyRecovery,
  recoverInterruptedReviewRun
} from "../src/lib/review-recovery-engine.mjs";
import { summarizeReviewMetrics } from "../src/lib/review-metrics-engine.mjs";
import { analyzePolicyTuning, applyPolicyTuning, reconcileAutoPolicyTuning, runAutoPolicyTuning } from "../src/lib/policy-tuning-engine.mjs";
import { acquireReviewLock, releaseReviewLock } from "../src/lib/review-lock-engine.mjs";
import { getRuntimeStatus, runRuntimeDoctor } from "../src/lib/runtime-status-engine.mjs";
import { runSyntheticBenchmark, runSyntheticBenchmarkCycle } from "../src/lib/benchmark-engine.mjs";
import { executeReviewPayload } from "../src/lib/provider-engine.mjs";
import { applyReviewCostMode } from "../src/lib/review-cost-mode-engine.mjs";
import { assessReviewValueGate } from "../src/lib/review-value-gate-engine.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-"));
await fs.cp(path.resolve("config"), path.join(tempRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(tempRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(tempRoot, "state"), { recursive: true });

// Tests must not inherit whatever runtime state happened to be left in the
// developer's local workspace. We reset the mutable state files so the test
// always exercises the same clean scenario.
await fs.writeFile(path.join(tempRoot, "state/memory/working-memory.json"), JSON.stringify({
  hotNoteIds: [],
  recentEventIds: [],
  lastSyncAt: null
}, null, 2));
await fs.writeFile(path.join(tempRoot, "state/memory/events.jsonl"), "");
await fs.writeFile(path.join(tempRoot, "state/memory/policy-state.json"), JSON.stringify({
  domains: {},
  recentModes: [],
  lastDecisionAt: null
}, null, 2));
await fs.writeFile(path.join(tempRoot, "state/memory/review-queue.json"), "[]\n");
await fs.mkdir(path.join(tempRoot, "state/reviews/reports"), { recursive: true });
await fs.writeFile(path.join(tempRoot, "state/reviews/history.jsonl"), "");

await ensureWorkspace(tempRoot);

const config = await readJson(path.join(tempRoot, "config/system.json"), {});
const taskProfile = classifyTask("design a security-focused migration plan for auth and context retrieval");
const plan = await planAgents(tempRoot, taskProfile, config);

assert.equal(plan.taskProfile.effort, "high");
assert.ok(plan.agents.some((agent) => agent.id === "migration-planner"));
assert.ok(plan.agents.some((agent) => agent.id === "security-reviewer"));

const memoryPolicy = await evaluateMemoryPolicy(tempRoot, taskProfile, config);
assert.equal(memoryPolicy.mode, "expensive");
assert.ok(memoryPolicy.shouldQueueReview);

const notes = await loadNotes(tempRoot);
const context = assembleContext("optimize context retrieval with atomic notes", notes, {
  tokenBudget: 500,
  maxNotes: 4
});

assert.ok(context.selectedNotes.length > 0);
assert.ok(context.usedTokens <= 500);

const sync = await syncMemory(
  tempRoot,
  {
    task: "capture a new learning about token budgets",
    summary: "Store only atomic retrieval rules and keep working memory pointer-only.",
    artifacts: ["notes", "working-memory"]
  },
  config
);

assert.ok(sync.eventId.startsWith("evt-"));
assert.ok(sync.touchedNoteId.startsWith("z-task-") || sync.touchedNoteId.startsWith("z-"));

const policyOutcome = await applyMemoryPolicyOutcome(tempRoot, memoryPolicy, taskProfile, sync, config);
assert.ok(policyOutcome.queuedJob);
assert.equal(policyOutcome.queuedJob.mode, "expensive");

const workingMemory = await readJson(path.join(tempRoot, "state/memory/working-memory.json"), {});
assert.ok(workingMemory.hotNoteIds.length >= 1);
assert.ok(workingMemory.recentEventIds.length >= 1);

const reviewQueue = await readJson(path.join(tempRoot, "state/memory/review-queue.json"), []);
assert.ok(reviewQueue.length >= 1);
assert.equal(reviewQueue[0].mode, "expensive");

const queueBeforeRun = await inspectReviewQueue(tempRoot);
assert.equal(queueBeforeRun.queued, 1);

const reviewRun = await processReviewQueue(tempRoot, config, { maxJobs: 1 });
assert.equal(reviewRun.processedCount, 1);
assert.equal(reviewRun.processed[0].adapter, "dry-run");

const queueAfterRun = await inspectReviewQueue(tempRoot);
assert.equal(queueAfterRun.completed, 1);
assert.equal(queueAfterRun.queued, 0);

const reviewReport = await readJson(queueAfterRun.jobs[0].reportPath, null);
assert.equal(reviewReport.execution.adapter, "dry-run");
assert.ok(reviewReport.execution.output.prompt.includes("Review mode: expensive"));

const historyRaw = await fs.readFile(path.join(tempRoot, "state/reviews/history.jsonl"), "utf8");
assert.ok(historyRaw.includes("\"adapter\":\"dry-run\""));
const firstMetrics = await summarizeReviewMetrics(tempRoot);
assert.equal(firstMetrics.counters.processedJobs, 1);
assert.equal(firstMetrics.counters.completedJobs, 1);
assert.ok(firstMetrics.topAdapters.some((entry) => entry.key === "dry-run"));
assert.ok(firstMetrics.cost.estimatedContextTokens > 0);
assert.equal(firstMetrics.cost.liveTokensUsed, 0);
assert.ok(firstMetrics.cost.avgEstimatedContextTokensPerRun > 0);

const valueGateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-value-gate-"));
await fs.cp(path.resolve("config"), path.join(valueGateRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(valueGateRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(valueGateRoot, "state"), { recursive: true });
await ensureWorkspace(valueGateRoot);
const valueGateNow = new Date().toISOString();

await writeJson(path.join(valueGateRoot, "state/memory/review-queue.json"), [
  {
    id: "memjob-value-gate-1",
    createdAt: valueGateNow,
    mode: "balanced",
    budget: 180,
    task: "touch one small docs note",
    domains: ["docs"],
    reasons: ["Medium-risk task should get a small memory review pass."],
    sourceEventId: "evt-value-gate-1",
    sourceNoteId: "100-context-minimization",
    sourceEventIds: ["evt-value-gate-1"],
    sourceNoteIds: ["100-context-minimization"],
    tasks: [
      {
        task: "touch one small docs note",
        reasons: ["Medium-risk task should get a small memory review pass."],
        sourceEventId: "evt-value-gate-1",
        sourceNoteId: "100-context-minimization",
        addedAt: valueGateNow
      }
    ],
    mergedTaskCount: 1,
    status: "queued"
  }
]);

const valueGateRun = await processReviewQueue(valueGateRoot, config, {
  maxJobs: 1,
  reviewConfig: {
    ...config,
    reviewExecution: {
      ...config.reviewExecution,
      valueGate: {
        enabled: true,
        applyToModes: ["balanced"],
        minScore: 999
      }
    }
  }
});

assert.equal(valueGateRun.processedCount, 1);
assert.equal(valueGateRun.processed[0].adapter, "value-policy");

const valueGateQueue = await inspectReviewQueue(valueGateRoot);
assert.equal(valueGateQueue.completed, 1);

const valueGateReport = await readJson(valueGateQueue.jobs[0].reportPath, null);
assert.equal(valueGateReport.execution.adapter, "value-policy");
assert.equal(valueGateReport.execution.output.usage.totalTokens, 0);
assert.equal(valueGateReport.valueGate.shouldSkip, true);
assert.match(valueGateReport.noteChanges.reason, /value gate/i);

const valueGateMetrics = await summarizeReviewMetrics(valueGateRoot);
assert.equal(valueGateMetrics.counters.processedJobs, 1);
assert.equal(valueGateMetrics.counters.skippedJobs, 1);
assert.equal(valueGateMetrics.cost.liveTokensUsed, 0);
assert.ok(valueGateMetrics.topAdapters.some((entry) => entry.key === "value-policy"));

const domainValueGate = assessReviewValueGate(
  {
    mode: "balanced",
    domains: ["docs"],
    reasons: ["Synthetic domain value-gate test."],
    sourceEventIds: ["evt-domain-gate-1"],
    mergedTaskCount: 1
  },
  {
    contextBundle: {
      selectedNotes: [{ id: "100-context-minimization" }],
      usedTokens: 180
    }
  },
  {
    enabled: true,
    applyToModes: ["balanced"],
    minScore: 60,
    minScoreByDomain: {
      docs: 70
    }
  }
);
assert.equal(domainValueGate.threshold, 70);
assert.equal(domainValueGate.thresholdSource, "domain:docs");
assert.equal(domainValueGate.shouldSkip, true);

const retentionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-retention-"));
await fs.mkdir(path.join(retentionRoot, "state/reviews/reports"), { recursive: true });
const retentionReportsDir = path.join(retentionRoot, "state/reviews/reports");
await fs.writeFile(path.join(retentionReportsDir, "memjob-20260418000000001.json"), JSON.stringify({ id: "oldest" }, null, 2));
await fs.writeFile(path.join(retentionReportsDir, "memjob-20260418000000002.json"), JSON.stringify({ id: "middle" }, null, 2));
await fs.writeFile(path.join(retentionReportsDir, "memjob-20260418000000003.json"), JSON.stringify({ id: "newest" }, null, 2));
await fs.writeFile(
  path.join(retentionRoot, "state/reviews/history.jsonl"),
  ["one", "two", "three", "four"].join("\n") + "\n"
);

const retentionResult = await applyReviewRetention(retentionRoot, {
  enabled: true,
  maxReportFiles: 2,
  maxHistoryEntries: 3
});

assert.equal(retentionResult.enabled, true);
assert.equal(retentionResult.deletedReportCount, 1);
assert.equal(retentionResult.trimmedHistoryEntries, 1);
assert.equal(retentionResult.remainingReportCount, 2);
assert.equal(retentionResult.remainingHistoryEntries, 3);

const retainedReports = (await fs.readdir(retentionReportsDir))
  .filter((entry) => entry.endsWith(".json"))
  .sort();
assert.deepEqual(retainedReports, [
  "memjob-20260418000000002.json",
  "memjob-20260418000000003.json"
]);

const retainedHistory = (await fs.readFile(path.join(retentionRoot, "state/reviews/history.jsonl"), "utf8"))
  .trim()
  .split("\n");
assert.deepEqual(retainedHistory, ["two", "three", "four"]);

const recoveryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-recovery-"));
await fs.cp(path.resolve("config"), path.join(recoveryRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(recoveryRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(recoveryRoot, "state"), { recursive: true });
await ensureWorkspace(recoveryRoot);

const recoveryConfig = await readJson(path.join(recoveryRoot, "config/system.json"), {});
const recoveryQueuePath = path.join(recoveryRoot, "state/memory/review-queue.json");
const recoveryHistoryPath = path.join(recoveryRoot, "state/reviews/history.jsonl");
const recoveryReportPath = path.join(recoveryRoot, "state/reviews/reports/memjob-recovery-1.json");
const recoveryNotePath = path.join(recoveryRoot, "notes/100-context-minimization.md");
const originalRecoveryNote = await fs.readFile(recoveryNotePath, "utf8");

const recoveryJob = {
  id: "memjob-recovery-1",
  createdAt: "2026-04-18T02:00:00.000Z",
  startedAt: "2026-04-18T02:01:00.000Z",
  mode: "balanced",
  budget: 400,
  task: "recover an interrupted review apply",
  domains: ["memory", "notes"],
  reasons: ["Synthetic recovery test."],
  status: "running"
};

await writeJson(recoveryQueuePath, [recoveryJob]);
await writeJson(recoveryReportPath, {
  job: recoveryJob,
  noteChanges: {
    applied: [],
    skipped: [],
    reason: "Synthetic pending apply report."
  }
});

const recoverySession = await beginReviewApplyRecovery(
  recoveryRoot,
  recoveryJob,
  recoveryReportPath,
  recoveryConfig.reviewExecution?.recovery ?? {}
);
assert.ok(recoverySession?.sessionId);

await fs.appendFile(recoveryNotePath, "\nINTERRUPTED APPLY MARKER\n", "utf8");

const recoveryResult = await recoverInterruptedReviewRun(
  recoveryRoot,
  recoveryConfig.reviewExecution?.recovery ?? {}
);

assert.equal(recoveryResult.recovered, true);
const restoredRecoveryNote = await fs.readFile(recoveryNotePath, "utf8");
assert.equal(restoredRecoveryNote, originalRecoveryNote);

const recoveryQueue = await readJson(recoveryQueuePath, []);
assert.equal(recoveryQueue[0].status, "queued");
assert.equal(recoveryQueue[0].recoveryCount, 1);
assert.equal(recoveryQueue[0].recovery.action, "rolled-back-and-requeued");

const recoveredReport = await readJson(recoveryReportPath, null);
assert.equal(recoveredReport.recovery.action, "rolled-back-and-requeued");
assert.match(recoveredReport.noteChanges.reason, /interrupted/i);

const recoveryHistoryRaw = await fs.readFile(recoveryHistoryPath, "utf8");
assert.match(recoveryHistoryRaw, /"adapter":"recovery-policy"/);
const recoveryMetrics = await summarizeReviewMetrics(recoveryRoot);
assert.equal(recoveryMetrics.counters.recoveredRuns, 1);

const approvalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-approval-"));
await fs.cp(path.resolve("config"), path.join(approvalRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(approvalRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(approvalRoot, "state"), { recursive: true });
await ensureWorkspace(approvalRoot);

const approvalConfig = await readJson(path.join(approvalRoot, "config/system.json"), {});
const approvalJob = {
  id: "memjob-approval-1",
  createdAt: "2026-04-18T03:00:00.000Z",
  mode: "expensive",
  domains: ["security", "auth", "migration"],
  reasons: ["Synthetic approval test."],
  status: "awaiting-approval"
};
const approvalExecution = {
  output: {
    parsed: {
      summary: "Prepare a security-sensitive note update for manual approval.",
      operations: [
        {
          type: "append_note_update",
          noteId: "z-130-background-memory-sync",
          sourceNoteId: "",
          targetNoteId: "",
          title: "",
          kind: "",
          summary: "Security-sensitive review updates should stop at a suggest-only gate until a human approves the final write.",
          signals: [
            "Use suggest-only mode for security-heavy review runs",
            "Require an explicit approval step before local note apply"
          ],
          tagsToAdd: ["approval-policy", "security-review"],
          linksToAdd: ["z-120-agent-orchestration"],
          tags: [],
          links: []
        }
      ]
    }
  }
};

const approvalPlan = await planReviewNoteChanges(approvalRoot, approvalExecution, approvalConfig, approvalJob);
assert.equal(approvalPlan.shouldApply, true);
assert.equal(approvalPlan.selectedOperations.length, 1);

const approvalDecision = assessReviewApprovalRequirement(
  approvalJob,
  approvalConfig.reviewExecution?.approval ?? {}
);
assert.equal(approvalDecision.required, true);
assert.ok(approvalDecision.reasons.includes("mode:expensive"));
assert.ok(approvalDecision.reasons.includes("domain:security"));

const approvalReportPath = path.join(approvalRoot, "state/reviews/reports/memjob-approval-1.json");
await writeJson(approvalReportPath, {
  job: approvalJob,
  noteChanges: {
    ...approvalPlan,
    approval: {
      status: "pending",
      reasons: approvalDecision.reasons
    },
    applied: [],
    reason: "Synthetic pending approval report."
  }
});
await writeJson(path.join(approvalRoot, "state/memory/review-queue.json"), [
  {
    ...approvalJob,
    reportPath: approvalReportPath,
    approval: {
      status: "pending"
    }
  }
]);

const createdApproval = await createApprovalRequest(
  approvalRoot,
  approvalJob,
  approvalReportPath,
  approvalPlan,
  approvalDecision
);
assert.equal(createdApproval.request.selectedOperations.length, 1);

const approvalQueueBeforeApply = await inspectReviewQueue(approvalRoot);
assert.equal(approvalQueueBeforeApply.awaitingApproval, 1);

const approvalNotePath = path.join(approvalRoot, "notes/130-background-memory-sync.md");
const approvalBefore = await fs.readFile(approvalNotePath, "utf8");
const approvalResult = await approvePendingReview(approvalRoot, approvalJob.id, approvalConfig);
assert.equal(approvalResult.status, "approved");

const approvalAfter = await fs.readFile(approvalNotePath, "utf8");
assert.notEqual(approvalAfter, approvalBefore);
assert.match(approvalAfter, /suggest-only gate/i);

const approvalQueueAfterApply = await readJson(path.join(approvalRoot, "state/memory/review-queue.json"), []);
assert.equal(approvalQueueAfterApply[0].status, "completed");
assert.equal(approvalQueueAfterApply[0].approval.status, "approved");

const approvalReport = await readJson(approvalReportPath, null);
assert.equal(approvalReport.noteChanges.approval.status, "approved");
assert.match(approvalReport.noteChanges.reason, /approved and applied/i);

const approvalHistoryRaw = await fs.readFile(path.join(approvalRoot, "state/reviews/history.jsonl"), "utf8");
assert.match(approvalHistoryRaw, /"adapter":"approval-policy"/);
const approvalMetrics = await summarizeReviewMetrics(approvalRoot);
assert.equal(approvalMetrics.counters.approvalsApplied, 1);
assert.ok(approvalMetrics.approvalLatency.count >= 1);

await fs.access(createdApproval.approvalPath).then(
  () => Promise.reject(new Error("Approval file should be removed after apply.")),
  () => Promise.resolve()
);

const approvalExpiryRequeueRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-approval-expiry-requeue-"));
await fs.cp(path.resolve("config"), path.join(approvalExpiryRequeueRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(approvalExpiryRequeueRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(approvalExpiryRequeueRoot, "state"), { recursive: true });
await ensureWorkspace(approvalExpiryRequeueRoot);

const approvalExpiryHistoryPath = path.join(approvalExpiryRequeueRoot, "state/reviews/history.jsonl");
const expiredPendingAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const requeueApprovalJob = {
  id: "memjob-approval-expiry-requeue-1",
  createdAt: expiredPendingAt,
  finishedAt: expiredPendingAt,
  status: "awaiting-approval",
  mode: "expensive",
  domains: ["security"],
  reportPath: path.join(approvalExpiryRequeueRoot, "state/reviews/reports/memjob-approval-expiry-requeue-1.json"),
  approval: {
    status: "pending",
    pendingAt: expiredPendingAt,
    approvalPath: path.join(approvalExpiryRequeueRoot, "state/reviews/approvals/memjob-approval-expiry-requeue-1.json")
  }
};
await writeJson(requeueApprovalJob.reportPath, {
  job: requeueApprovalJob,
  noteChanges: {
    approval: {
      status: "pending",
      pendingAt: expiredPendingAt
    },
    applied: [],
    skipped: [],
    reason: "Synthetic pending approval for requeue."
  }
});
await writeJson(requeueApprovalJob.approval.approvalPath, {
  id: requeueApprovalJob.id,
  createdAt: expiredPendingAt,
  selectedOperations: []
});
const requeueQueue = [requeueApprovalJob];
const requeueExpiry = await applyApprovalExpiryPolicy(
  approvalExpiryRequeueRoot,
  requeueQueue,
  approvalExpiryHistoryPath,
  {
    enabled: true,
    pendingApprovalTtlMinutes: 1,
    onExpired: "requeue"
  }
);
assert.equal(requeueExpiry.expired, 1);
assert.equal(requeueExpiry.requeued, 1);
assert.equal(requeueQueue[0].status, "queued");
assert.equal(requeueQueue[0].approval.status, "expired");
assert.equal(requeueQueue[0].approval.action, "requeue");
const requeueExpiredReport = await readJson(requeueApprovalJob.reportPath, null);
assert.equal(requeueExpiredReport.noteChanges.approval.status, "expired");
assert.equal(requeueExpiredReport.noteChanges.approval.action, "requeue");
const requeueExpiryMetrics = await summarizeReviewMetrics(approvalExpiryRequeueRoot);
assert.equal(requeueExpiryMetrics.counters.approvalsExpiredRequeued, 1);
await fs.access(requeueApprovalJob.approval.approvalPath).then(
  () => Promise.reject(new Error("Expired requeue approval file should be removed.")),
  () => Promise.resolve()
);

const approvalExpiryExpireRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-approval-expiry-expire-"));
await fs.cp(path.resolve("config"), path.join(approvalExpiryExpireRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(approvalExpiryExpireRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(approvalExpiryExpireRoot, "state"), { recursive: true });
await ensureWorkspace(approvalExpiryExpireRoot);

const approvalExpireHistoryPath = path.join(approvalExpiryExpireRoot, "state/reviews/history.jsonl");
const expireApprovalJob = {
  id: "memjob-approval-expiry-expire-1",
  createdAt: expiredPendingAt,
  finishedAt: expiredPendingAt,
  status: "awaiting-approval",
  mode: "expensive",
  domains: ["security"],
  reportPath: path.join(approvalExpiryExpireRoot, "state/reviews/reports/memjob-approval-expiry-expire-1.json"),
  approval: {
    status: "pending",
    pendingAt: expiredPendingAt,
    approvalPath: path.join(approvalExpiryExpireRoot, "state/reviews/approvals/memjob-approval-expiry-expire-1.json")
  }
};
await writeJson(expireApprovalJob.reportPath, {
  job: expireApprovalJob,
  noteChanges: {
    approval: {
      status: "pending",
      pendingAt: expiredPendingAt
    },
    applied: [],
    skipped: [],
    reason: "Synthetic pending approval for expire."
  }
});
await writeJson(expireApprovalJob.approval.approvalPath, {
  id: expireApprovalJob.id,
  createdAt: expiredPendingAt,
  selectedOperations: []
});
const expireQueue = [expireApprovalJob];
const expireExpiry = await applyApprovalExpiryPolicy(
  approvalExpiryExpireRoot,
  expireQueue,
  approvalExpireHistoryPath,
  {
    enabled: true,
    pendingApprovalTtlMinutes: 1,
    onExpired: "expire"
  }
);
assert.equal(expireExpiry.expired, 1);
assert.equal(expireExpiry.completed, 1);
assert.equal(expireQueue[0].status, "completed");
assert.equal(expireQueue[0].approval.status, "expired");
assert.equal(expireQueue[0].approval.action, "expire");
const expireExpiredReport = await readJson(expireApprovalJob.reportPath, null);
assert.equal(expireExpiredReport.noteChanges.approval.status, "expired");
assert.equal(expireExpiredReport.noteChanges.approval.action, "expire");
const approvalExpiryHistoryRaw = await fs.readFile(approvalExpireHistoryPath, "utf8");
assert.match(approvalExpiryHistoryRaw, /"adapter":"approval-expiry-policy"/);
const expireExpiryMetrics = await summarizeReviewMetrics(approvalExpiryExpireRoot);
assert.equal(expireExpiryMetrics.counters.approvalsExpiredClosed, 1);

const tuningRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-tuning-"));
await fs.cp(path.resolve("config"), path.join(tuningRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(tuningRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(tuningRoot, "state"), { recursive: true });
await ensureWorkspace(tuningRoot);
await writeJson(path.join(tuningRoot, "state/reviews/metrics.json"), {
  schemaVersion: 1,
  updatedAt: "2026-04-18T04:00:00.000Z",
  counters: {
    processedJobs: 8,
    completedJobs: 7,
    failedJobs: 1,
    skippedJobs: 0,
    awaitingApprovalJobs: 2,
    approvalsApplied: 1,
    approvalsExpiredRequeued: 2,
    approvalsExpiredClosed: 1,
    recoveredRuns: 0,
    noteApplyRuns: 3,
    selectedOperations: 3,
    appliedOperations: 3,
    skippedOperations: 2,
    rejectedOperations: 6,
    deferredOperations: 4
  },
  cost: {
    liveTokensUsed: 120000,
    estimatedContextTokens: 2400,
    liveRunsWithUsage: 3
  },
  latencies: {
    queueMinutes: {
      count: 8,
      total: 480,
      max: 90,
      last: 75
    },
    approvalMinutes: {
      count: 3,
      total: 390,
      max: 180,
      last: 150
    }
  },
  byAdapter: {
    "codex-native": 3,
    "dry-run": 5
  },
  byMode: {
    balanced: 3,
    expensive: 5
  },
  recentEvents: []
});
await writeJson(path.join(tuningRoot, "state/benchmarks/last-benchmark.json"), {
  generatedAt: "2026-04-18T04:10:00.000Z",
  aggregate: {
    taskCount: 5,
    cheapestVariant: "saver",
    byDomain: {
      docs: {
        cheapestVariant: "saver",
        byVariant: {
          saver: { reductionPercent: 51.4 },
          balanced: { reductionPercent: 42.1 }
        }
      },
      deploy: {
        cheapestVariant: "saver",
        byVariant: {
          saver: { reductionPercent: 48.8 },
          balanced: { reductionPercent: 40.6 }
        }
      },
      ui: {
        cheapestVariant: "saver",
        byVariant: {
          saver: { reductionPercent: 46.4 },
          balanced: { reductionPercent: 39.9 }
        }
      },
      testing: {
        cheapestVariant: "saver",
        byVariant: {
          saver: { reductionPercent: 44.1 },
          balanced: { reductionPercent: 37.6 }
        }
      }
    },
    byVariant: {
      saver: {
        totalTokens: 4200,
        tokensSaved: 3800,
        reductionPercent: 47.5
      },
      balanced: {
        totalTokens: 4900,
        tokensSaved: 3100,
        reductionPercent: 38.75
      },
      strict: {
        totalTokens: 6100,
        tokensSaved: 1900,
        reductionPercent: 23.75
      }
    }
  }
});

const tuningAnalysis = await analyzePolicyTuning(tuningRoot);
assert.equal(tuningAnalysis.summary.benchmarkLoaded, true);
assert.equal(tuningAnalysis.summary.tuningPlanSteps >= 3, true);
assert.ok(tuningAnalysis.suggestions.some((item) => item.id === "raise-domain-threshold"));
assert.ok(tuningAnalysis.suggestions.some((item) => item.id === "tighten-ranking-floor"));
assert.ok(tuningAnalysis.suggestions.some((item) => item.id === "tighten-value-gate"));
assert.ok(tuningAnalysis.suggestions.some((item) => item.id === "benchmark-lower-balanced-effort"));
assert.ok(tuningAnalysis.suggestions.some((item) => item.id === "benchmark-lean-balanced-operations"));
assert.ok(tuningAnalysis.suggestions.some((item) => item.id === "domain-tighten-value-gate-docs"));
assert.ok(tuningAnalysis.suggestions.some((item) => item.id === "domain-tighten-value-gate-deploy"));
assert.ok(tuningAnalysis.suggestions.some((item) => item.id === "raise-apply-budget"));
assert.ok(tuningAnalysis.suggestions.some((item) => item.id === "extend-approval-ttl"));
assert.equal(tuningAnalysis.tuningPlan.steps[0].phase, "cheap-domains");
assert.equal(tuningAnalysis.workflow.phases[0].phase, "cheap-domains");
assert.match(tuningAnalysis.workflow.phases[0].commands.preview, /--phase cheap-domains/);
assert.match(tuningAnalysis.workflow.phases[0].commands.reconcile, /--phase cheap-domains/);
assert.match(tuningAnalysis.workflow.phases[0].recommendedLoop[2], /benchmark cycle/i);
assert.ok(tuningAnalysis.tuningPlan.steps[0].suggestionIds.includes("domain-tighten-value-gate-docs"));
assert.equal(tuningAnalysis.tuningPlan.steps[0].expectedImpact.domains[0].domain, "docs");
assert.equal(tuningAnalysis.tuningPlan.steps[0].riskLevel, "low");
assert.match(tuningAnalysis.tuningPlan.steps[0].expectedImpactSummary, /cheap domains/i);
assert.match(tuningAnalysis.tuningPlan.steps[0].whyThisPhase, /starts there/i);
assert.ok(tuningAnalysis.tuningPlan.steps[1].suggestionIds.includes("benchmark-lower-balanced-effort"));
assert.ok(tuningAnalysis.tuningPlan.steps[1].expectedImpact.estimatedTokenDelta > 0);
assert.equal(tuningAnalysis.tuningPlan.steps[1].riskLevel, "medium");
assert.match(tuningAnalysis.tuningPlan.steps[1].expectedImpactSummary, /balanced-lane/i);
assert.match(tuningAnalysis.tuningPlan.steps[1].whyThisPhase, /extra tokens/i);
assert.equal(
  tuningAnalysis.suggestions.find((item) => item.id === "domain-tighten-value-gate-docs").expectedImpact.domain,
  "docs"
);
assert.equal(
  tuningAnalysis.suggestions.find((item) => item.id === "domain-tighten-value-gate-docs").riskLevel,
  "low"
);
assert.match(
  tuningAnalysis.suggestions.find((item) => item.id === "domain-tighten-value-gate-docs").expectedImpactSummary,
  /docs is carrying/i
);
const phaseOnlyAnalysis = await analyzePolicyTuning(tuningRoot, { phase: "cheap-domains" });
assert.equal(phaseOnlyAnalysis.selectedPhase, "cheap-domains");
assert.equal(phaseOnlyAnalysis.suggestions.every((item) => item.id.startsWith("domain-tighten-value-gate-")), true);
assert.equal(phaseOnlyAnalysis.tuningPlan.steps.length, 1);
assert.match(phaseOnlyAnalysis.workflow.recommendation, /cheap-domains phase/i);

const tuningApply = await applyPolicyTuning(tuningRoot);
assert.ok(tuningApply.applied.length >= 8);
const tunedConfig = await readJson(path.join(tuningRoot, "config/system.json"), {});
assert.equal(tunedConfig.memoryPolicy.sameDomainEventThreshold, 4);
assert.equal(tunedConfig.reviewExecution.operationRanking.minScore, 40);
assert.equal(tunedConfig.reviewExecution.valueGate.minScore, 65);
assert.equal(tunedConfig.reviewExecution.valueGate.minScoreByDomain.docs, 65);
assert.equal(tunedConfig.reviewExecution.valueGate.minScoreByDomain.deploy, 65);
assert.equal(tunedConfig.reviewExecution.reviewProfiles.balanced.codexReasoningEffort, "low");
assert.equal(tunedConfig.reviewExecution.reviewProfiles.balanced.maxOperations, 1);
assert.equal(tunedConfig.reviewExecution.operationRanking.maxAppliedOperations, 3);
assert.equal(tunedConfig.reviewExecution.approval.pendingApprovalTtlMinutes, 300);
assert.equal(tunedConfig.reviewExecution.approval.onExpired, "requeue");

const autoTuneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-auto-tune-"));
await fs.cp(path.resolve("config"), path.join(autoTuneRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(autoTuneRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(autoTuneRoot, "state"), { recursive: true });
await ensureWorkspace(autoTuneRoot);
await writeJson(path.join(autoTuneRoot, "state/reviews/metrics.json"), {
  schemaVersion: 1,
  updatedAt: "2026-04-18T04:00:00.000Z",
  counters: {
    processedJobs: 8,
    completedJobs: 7,
    failedJobs: 1,
    skippedJobs: 0,
    awaitingApprovalJobs: 2,
    approvalsApplied: 1,
    approvalsExpiredRequeued: 2,
    approvalsExpiredClosed: 1,
    recoveredRuns: 0,
    noteApplyRuns: 3,
    selectedOperations: 3,
    appliedOperations: 3,
    skippedOperations: 2,
    rejectedOperations: 6,
    deferredOperations: 4
  },
  cost: {
    liveTokensUsed: 120000,
    estimatedContextTokens: 2400,
    liveRunsWithUsage: 3
  },
  latencies: {
    queueMinutes: {
      count: 8,
      total: 480,
      max: 90,
      last: 75
    },
    approvalMinutes: {
      count: 3,
      total: 390,
      max: 180,
      last: 150
    }
  },
  byAdapter: {
    "codex-native": 3,
    "dry-run": 5
  },
  byMode: {
    balanced: 3,
    expensive: 5
  },
  recentEvents: []
});
await writeJson(path.join(autoTuneRoot, "state/benchmarks/last-benchmark.json"), {
  generatedAt: "2026-04-18T04:10:00.000Z",
  aggregate: {
    taskCount: 5,
    cheapestVariant: "saver",
    byDomain: {
      docs: {
        cheapestVariant: "saver",
        byVariant: {
          saver: { reductionPercent: 52.4 },
          balanced: { reductionPercent: 45.1 }
        }
      },
      deploy: {
        cheapestVariant: "saver",
        byVariant: {
          saver: { reductionPercent: 49.8 },
          balanced: { reductionPercent: 41.2 }
        }
      },
      ui: {
        cheapestVariant: "saver",
        byVariant: {
          saver: { reductionPercent: 46.9 },
          balanced: { reductionPercent: 40.4 }
        }
      },
      testing: {
        cheapestVariant: "saver",
        byVariant: {
          saver: { reductionPercent: 44.5 },
          balanced: { reductionPercent: 37.8 }
        }
      },
      security: {
        cheapestVariant: "balanced",
        byVariant: {
          saver: { reductionPercent: 28.5 },
          balanced: { reductionPercent: 32.6 }
        }
      }
    },
    byVariant: {
      saver: {
        totalTokens: 4200,
        tokensSaved: 3800,
        reductionPercent: 47.5
      },
      balanced: {
        totalTokens: 4900,
        tokensSaved: 3100,
        reductionPercent: 38.75
      },
      strict: {
        totalTokens: 6100,
        tokensSaved: 1900,
        reductionPercent: 23.75
      }
    }
  }
});

const autoTuningFirst = await runAutoPolicyTuning(autoTuneRoot);
assert.equal(autoTuningFirst.enabled, true);
assert.equal(autoTuningFirst.maxAutoApplySuggestionsPerRun, 4);
assert.ok(autoTuningFirst.applied.length <= 4);
assert.ok(autoTuningFirst.applied.length >= 4);
assert.ok(autoTuningFirst.applied.some((item) => item.id === "domain-tighten-value-gate-docs"));
assert.ok(autoTuningFirst.applied.some((item) => item.id === "domain-tighten-value-gate-deploy"));
const autoTunedConfig = await readJson(path.join(autoTuneRoot, "config/system.json"), {});
assert.equal(autoTunedConfig.reviewExecution.valueGate.minScoreByDomain.docs, 65);
assert.equal(autoTunedConfig.reviewExecution.valueGate.minScoreByDomain.deploy, 65);
assert.equal(autoTunedConfig.reviewExecution.reviewProfiles.balanced.codexReasoningEffort, "medium");
assert.ok(autoTuningFirst.blocked.some((item) => item.id === "tighten-value-gate" && item.reason === "auto-apply-budget-exhausted"));

const autoTuneState = await readJson(path.join(autoTuneRoot, "state/tuning/auto-tune-state.json"), {});
assert.ok(autoTuneState.lastAppliedById["domain-tighten-value-gate-docs"]);
const autoTuneHistory = await fs.readFile(path.join(autoTuneRoot, "state/tuning/history.jsonl"), "utf8");
assert.match(autoTuneHistory, /domain-tighten-value-gate-docs/);

const phaseTuneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-phase-tune-"));
await fs.cp(path.resolve("config"), path.join(phaseTuneRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(phaseTuneRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(phaseTuneRoot, "state"), { recursive: true });
await ensureWorkspace(phaseTuneRoot);
await writeJson(path.join(phaseTuneRoot, "state/reviews/metrics.json"), await readJson(path.join(autoTuneRoot, "state/reviews/metrics.json"), {}));
await writeJson(path.join(phaseTuneRoot, "state/benchmarks/last-benchmark.json"), await readJson(path.join(autoTuneRoot, "state/benchmarks/last-benchmark.json"), {}));
const phaseTuneConfig = await readJson(path.join(phaseTuneRoot, "config/system.json"), {});
phaseTuneConfig.tuning.cooldownMinutes = 0;
phaseTuneConfig.tuning.maxAutoApplySuggestionsPerRun = 5;
await writeJson(path.join(phaseTuneRoot, "config/system.json"), phaseTuneConfig);
const cheapPhaseAutoTune = await runAutoPolicyTuning(phaseTuneRoot, { phase: "cheap-domains" });
assert.equal(cheapPhaseAutoTune.selectedPhase, "cheap-domains");
assert.equal(cheapPhaseAutoTune.applied.every((item) => item.id.startsWith("domain-tighten-value-gate-")), true);

const autoTuningSecond = await runAutoPolicyTuning(autoTuneRoot);
assert.equal(autoTuningSecond.applied.length, 4);
assert.ok(autoTuningSecond.applied.some((item) => item.id === "tighten-value-gate"));
assert.ok(autoTuningSecond.applied.some((item) => item.id === "benchmark-lower-balanced-effort"));
assert.ok(autoTuningSecond.blocked.some((item) => item.id === "domain-tighten-value-gate-docs" && item.reason === "cooldown-active"));

await writeJson(path.join(autoTuneRoot, "state/benchmarks/last-benchmark.json"), {
  generatedAt: new Date(Date.now() + 60 * 1000).toISOString(),
  aggregate: {
    taskCount: 5,
    cheapestVariant: "balanced",
    byDomain: {
      docs: {
        cheapestVariant: "balanced",
        byVariant: {
          saver: { reductionPercent: 34.1 },
          balanced: { reductionPercent: 30.4 }
        }
      },
      deploy: {
        cheapestVariant: "balanced",
        byVariant: {
          saver: { reductionPercent: 32.5 },
          balanced: { reductionPercent: 28.1 }
        }
      },
      ui: {
        cheapestVariant: "balanced",
        byVariant: {
          saver: { reductionPercent: 35.2 },
          balanced: { reductionPercent: 31.6 }
        }
      },
      testing: {
        cheapestVariant: "balanced",
        byVariant: {
          saver: { reductionPercent: 33.7 },
          balanced: { reductionPercent: 29.3 }
        }
      },
      security: {
        cheapestVariant: "balanced",
        byVariant: {
          saver: { reductionPercent: 26.4 },
          balanced: { reductionPercent: 31.7 }
        }
      }
    },
    byVariant: {
      saver: {
        totalTokens: 5200,
        tokensSaved: 2800,
        reductionPercent: 35.5
      },
      balanced: {
        totalTokens: 5600,
        tokensSaved: 2400,
        reductionPercent: 30.75
      },
      strict: {
        totalTokens: 6400,
        tokensSaved: 1600,
        reductionPercent: 20
      }
    }
  }
});

const reconcileResult = await reconcileAutoPolicyTuning(autoTuneRoot);
assert.equal(reconcileResult.accepted, false);
assert.ok(reconcileResult.rolledBack.some((item) => item.id === "tighten-value-gate"));
assert.ok(reconcileResult.reasons.some((reason) => /cheapest variant changed/i.test(reason)));
const rolledBackConfig = await readJson(path.join(autoTuneRoot, "config/system.json"), {});
assert.equal(rolledBackConfig.reviewExecution.valueGate.minScore, 60);
assert.equal(rolledBackConfig.reviewExecution.valueGate.minScoreByDomain.docs, 65);
assert.equal(rolledBackConfig.reviewExecution.reviewProfiles.balanced.codexReasoningEffort, "medium");
const rolledBackTuning = await readJson(path.join(autoTuneRoot, "state/tuning/last-tuning.json"), {});
assert.equal(rolledBackTuning.canary.status, "rolled-back");
const rolledBackState = await readJson(path.join(autoTuneRoot, "state/tuning/auto-tune-state.json"), {});
assert.ok(rolledBackState.lastAppliedById["domain-tighten-value-gate-docs"]);

const phaseRollbackRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-phase-rollback-"));
await fs.cp(path.resolve("config"), path.join(phaseRollbackRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(phaseRollbackRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(phaseRollbackRoot, "state"), { recursive: true });
await ensureWorkspace(phaseRollbackRoot);
await writeJson(path.join(phaseRollbackRoot, "state/reviews/metrics.json"), await readJson(path.join(autoTuneRoot, "state/reviews/metrics.json"), {}));
await writeJson(path.join(phaseRollbackRoot, "state/benchmarks/last-benchmark.json"), await readJson(path.join(phaseTuneRoot, "state/benchmarks/last-benchmark.json"), {}));
const phaseRollbackConfigPath = path.join(phaseRollbackRoot, "config/system.json");
const phaseRollbackConfig = await readJson(phaseRollbackConfigPath, {});
phaseRollbackConfig.tuning.cooldownMinutes = 0;
phaseRollbackConfig.tuning.maxAutoApplySuggestionsPerRun = 3;
phaseRollbackConfig.tuning.autoApplySuggestionIds = [
  "domain-tighten-value-gate-docs",
  "domain-tighten-value-gate-deploy",
  "benchmark-lower-balanced-effort"
];
await writeJson(phaseRollbackConfigPath, phaseRollbackConfig);
const phaseRollbackAutoTune = await runAutoPolicyTuning(phaseRollbackRoot);
assert.ok(phaseRollbackAutoTune.applied.some((item) => item.phase === "cheap-domains"));
assert.ok(phaseRollbackAutoTune.applied.some((item) => item.phase === "balanced-lane"));
await writeJson(path.join(phaseRollbackRoot, "state/benchmarks/last-benchmark.json"), {
  generatedAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
  aggregate: {
    taskCount: 5,
    cheapestVariant: "balanced",
    byDomain: {
      docs: {
        cheapestVariant: "balanced",
        byVariant: {
          saver: { reductionPercent: 34.1 },
          balanced: { reductionPercent: 30.4 }
        }
      },
      deploy: {
        cheapestVariant: "balanced",
        byVariant: {
          saver: { reductionPercent: 32.5 },
          balanced: { reductionPercent: 28.1 }
        }
      },
      ui: {
        cheapestVariant: "balanced",
        byVariant: {
          saver: { reductionPercent: 35.2 },
          balanced: { reductionPercent: 31.6 }
        }
      },
      testing: {
        cheapestVariant: "balanced",
        byVariant: {
          saver: { reductionPercent: 33.7 },
          balanced: { reductionPercent: 29.3 }
        }
      }
    },
    byVariant: {
      saver: {
        totalTokens: 5200,
        tokensSaved: 2800,
        reductionPercent: 35.5
      },
      balanced: {
        totalTokens: 5600,
        tokensSaved: 2400,
        reductionPercent: 30.75
      },
      strict: {
        totalTokens: 6400,
        tokensSaved: 1600,
        reductionPercent: 20
      }
    }
  }
});
const phaseRollbackBalanced = await reconcileAutoPolicyTuning(phaseRollbackRoot, { phase: "balanced-lane" });
assert.equal(phaseRollbackBalanced.selectedPhase, "balanced-lane");
assert.equal(phaseRollbackBalanced.remainingRollbackCount, 2);
assert.equal(phaseRollbackBalanced.rolledBack.every((item) => item.id === "benchmark-lower-balanced-effort"), true);
const phaseRollbackConfigAfterBalanced = await readJson(phaseRollbackConfigPath, {});
assert.equal(phaseRollbackConfigAfterBalanced.reviewExecution.reviewProfiles.balanced.codexReasoningEffort, "medium");
assert.equal(phaseRollbackConfigAfterBalanced.reviewExecution.valueGate.minScoreByDomain.docs, 65);
const phaseRollbackTuningAfterBalanced = await readJson(path.join(phaseRollbackRoot, "state/tuning/last-tuning.json"), {});
assert.equal(phaseRollbackTuningAfterBalanced.canary.status, "pending");
assert.equal(phaseRollbackTuningAfterBalanced.canary.rollbackPlan.length, 2);
const phaseRollbackCheap = await reconcileAutoPolicyTuning(phaseRollbackRoot, { phase: "cheap-domains" });
assert.equal(phaseRollbackCheap.selectedPhase, "cheap-domains");
assert.equal(phaseRollbackCheap.remainingRollbackCount, 0);
const phaseRollbackConfigAfterCheap = await readJson(phaseRollbackConfigPath, {});
assert.equal(phaseRollbackConfigAfterCheap.reviewExecution.valueGate.minScoreByDomain.docs, undefined);
assert.equal(phaseRollbackConfigAfterCheap.reviewExecution.valueGate.minScoreByDomain.deploy, undefined);
const phaseRollbackTuningAfterCheap = await readJson(path.join(phaseRollbackRoot, "state/tuning/last-tuning.json"), {});
assert.equal(phaseRollbackTuningAfterCheap.canary.status, "rolled-back");

const priorityTuneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-priority-tune-"));
await fs.cp(path.resolve("config"), path.join(priorityTuneRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(priorityTuneRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(priorityTuneRoot, "state"), { recursive: true });
await ensureWorkspace(priorityTuneRoot);

const priorityConfigPath = path.join(priorityTuneRoot, "config/system.json");
const priorityConfig = await readJson(priorityConfigPath, {});
priorityConfig.tuning.maxAutoApplySuggestionsPerRun = 1;
priorityConfig.tuning.canaryDomains = ["docs", "deploy"];
priorityConfig.tuning.autoApplySuggestionIds = [
  "domain-tighten-value-gate-docs",
  "domain-tighten-value-gate-deploy"
];
await writeJson(priorityConfigPath, priorityConfig);

await writeJson(path.join(priorityTuneRoot, "state/reviews/metrics.json"), {
  schemaVersion: 2,
  updatedAt: "2026-04-18T05:00:00.000Z",
  counters: {
    processedJobs: 2,
    completedJobs: 2,
    failedJobs: 0,
    skippedJobs: 0,
    awaitingApprovalJobs: 0,
    approvalsApplied: 0,
    approvalsExpiredRequeued: 0,
    approvalsExpiredClosed: 0,
    recoveredRuns: 0,
    noteApplyRuns: 1,
    selectedOperations: 2,
    appliedOperations: 2,
    skippedOperations: 0,
    rejectedOperations: 0,
    deferredOperations: 0
  },
  cost: {
    liveTokensUsed: 26000,
    estimatedContextTokens: 800,
    liveRunsWithUsage: 2
  },
  latencies: {
    queueMinutes: { count: 2, total: 20, max: 10, last: 10 },
    approvalMinutes: { count: 0, total: 0, max: 0, last: 0 }
  },
  byAdapter: { "codex-native": 2 },
  byMode: { balanced: 2 },
  tokensByDomain: {
    docs: 18000,
    deploy: 6000
  },
  recentEvents: []
});

await writeJson(path.join(priorityTuneRoot, "state/benchmarks/last-benchmark.json"), {
  generatedAt: "2026-04-18T05:10:00.000Z",
  aggregate: {
    taskCount: 2,
    cheapestVariant: "saver",
    byDomain: {
      docs: {
        cheapestVariant: "saver",
        byVariant: {
          saver: { reductionPercent: 52.1 },
          balanced: { reductionPercent: 43.2 }
        }
      },
      deploy: {
        cheapestVariant: "saver",
        byVariant: {
          saver: { reductionPercent: 48.4 },
          balanced: { reductionPercent: 43.1 }
        }
      }
    },
    byVariant: {
      saver: { totalTokens: 3000, tokensSaved: 2000, reductionPercent: 40 },
      balanced: { totalTokens: 3600, tokensSaved: 1400, reductionPercent: 28 }
    }
  }
});

const priorityAnalysis = await analyzePolicyTuning(priorityTuneRoot);
const docsSuggestion = priorityAnalysis.suggestions.find((item) => item.id === "domain-tighten-value-gate-docs");
const deploySuggestion = priorityAnalysis.suggestions.find((item) => item.id === "domain-tighten-value-gate-deploy");
assert.ok(docsSuggestion.priority > deploySuggestion.priority);

const priorityAutoTune = await runAutoPolicyTuning(priorityTuneRoot);
assert.equal(priorityAutoTune.applied.length, 1);
assert.equal(priorityAutoTune.applied[0].id, "domain-tighten-value-gate-docs");
assert.ok(priorityAutoTune.blocked.some((item) => item.id === "domain-tighten-value-gate-deploy" && item.reason === "auto-apply-budget-exhausted"));
const priorityTunedConfig = await readJson(priorityConfigPath, {});
assert.equal(priorityTunedConfig.reviewExecution.valueGate.minScoreByDomain.docs, 65);
assert.equal(priorityTunedConfig.reviewExecution.valueGate.minScoreByDomain.deploy, undefined);

const lockRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-lock-"));
await fs.cp(path.resolve("config"), path.join(lockRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(lockRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(lockRoot, "state"), { recursive: true });
await ensureWorkspace(lockRoot);

const lockConfig = await readJson(path.join(lockRoot, "config/system.json"), {});
const heldLock = await acquireReviewLock(lockRoot, lockConfig.reviewExecution?.runtimeLock ?? {});
assert.equal(heldLock.acquired, true);

const blockedRun = await processReviewQueue(lockRoot, lockConfig, { maxJobs: 1 });
assert.equal(blockedRun.processedCount, 0);
assert.equal(blockedRun.lock.acquired, false);
assert.match(blockedRun.lock.reason, /runtime lock/i);

const releaseLockResult = await releaseReviewLock(lockRoot, heldLock);
assert.equal(releaseLockResult.released, true);

const staleLockRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-stale-lock-"));
await fs.cp(path.resolve("config"), path.join(staleLockRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(staleLockRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(staleLockRoot, "state"), { recursive: true });
await ensureWorkspace(staleLockRoot);

const staleLockConfig = await readJson(path.join(staleLockRoot, "config/system.json"), {});
await writeJson(path.join(staleLockRoot, "state/reviews/worker-lock.json"), {
  ownerId: "stale-lock-owner",
  startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString()
});
await writeJson(path.join(staleLockRoot, "state/memory/review-queue.json"), [
  {
    id: "memjob-stale-lock-1",
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    mode: "balanced",
    budget: 300,
    task: "recover after a stale runtime lock",
    domains: ["docs"],
    reasons: ["Synthetic stale lock test."],
    status: "queued"
  }
]);

const staleLockRun = await processReviewQueue(staleLockRoot, staleLockConfig, { maxJobs: 1 });
assert.equal(staleLockRun.lock.acquired, true);
assert.equal(staleLockRun.processedCount, 1);
const staleLockFile = await readJson(path.join(staleLockRoot, "state/reviews/worker-lock.json"), {});
assert.deepEqual(staleLockFile, {});

const statusRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-status-"));
await fs.cp(path.resolve("config"), path.join(statusRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(statusRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(statusRoot, "state"), { recursive: true });
await ensureWorkspace(statusRoot);

await writeJson(path.join(statusRoot, "state/memory/review-queue.json"), [
  {
    id: "memjob-status-1",
    createdAt: "2026-04-18T05:00:00.000Z",
    status: "queued",
    mode: "balanced",
    domains: ["docs"]
  }
]);
await writeJson(path.join(statusRoot, "state/reviews/metrics.json"), {
  schemaVersion: 1,
  updatedAt: "2026-04-18T05:05:00.000Z",
  counters: {
    processedJobs: 2,
    completedJobs: 2,
    failedJobs: 0,
    skippedJobs: 0,
    awaitingApprovalJobs: 0,
    approvalsApplied: 0,
    approvalsExpiredRequeued: 0,
    approvalsExpiredClosed: 0,
    recoveredRuns: 0,
    noteApplyRuns: 1,
    appliedOperations: 1,
    skippedOperations: 0,
    rejectedOperations: 0,
    deferredOperations: 0
  },
  latencies: {
    queueMinutes: { count: 2, total: 20, max: 15, last: 5 },
    approvalMinutes: { count: 0, total: 0, max: 0, last: 0 }
  },
  byAdapter: { "dry-run": 2 },
  byMode: { balanced: 2 },
  tokensByDomain: {
    docs: 12000,
    deploy: 4000
  },
  recentEvents: []
});
await writeJson(path.join(statusRoot, "state/benchmarks/last-benchmark.json"), {
  generatedAt: new Date().toISOString(),
  aggregate: {
    taskCount: 5,
    cheapestVariant: "saver",
    byDomain: {
      docs: {
        cheapestVariant: "saver",
        byVariant: {
          saver: { reductionPercent: 49.5 },
          balanced: { reductionPercent: 41.2 }
        }
      },
      deploy: {
        cheapestVariant: "saver",
        byVariant: {
          saver: { reductionPercent: 46.1 },
          balanced: { reductionPercent: 41.8 }
        }
      },
      ui: {
        cheapestVariant: "balanced",
        byVariant: {
          saver: { reductionPercent: 38.4 },
          balanced: { reductionPercent: 40.2 }
        }
      },
      testing: {
        cheapestVariant: "saver",
        byVariant: {
          saver: { reductionPercent: 44.1 },
          balanced: { reductionPercent: 40.7 }
        }
      }
    },
    byVariant: {
      saver: {
        totalTokens: 4200,
        tokensSaved: 3800,
        reductionPercent: 47.5
      },
      balanced: {
        totalTokens: 4900,
        tokensSaved: 3100,
        reductionPercent: 38.75
      }
    }
  },
  trend: {
    confidence: {
      score: 88,
      level: "high",
      reasons: [
        "trend window is fully populated",
        "cheapest variant stayed stable for at least three runs"
      ]
    },
    byDomain: {
      docs: {
        cheapestVariantStreak: {
          variant: "saver",
          count: 3
        },
        changeCount: 0,
        isNoisy: false
      },
      deploy: {
        cheapestVariantStreak: {
          variant: "saver",
          count: 1
        },
        changeCount: 0,
        isNoisy: false
      },
      ui: {
        cheapestVariantStreak: {
          variant: "balanced",
          count: 2
        },
        changeCount: 2,
        isNoisy: true
      },
      testing: {
        cheapestVariantStreak: {
          variant: "saver",
          count: 1
        },
        changeCount: 1,
        isNoisy: false
      }
    }
  },
  tuningComparison: {
    available: true,
    outcome: "improved",
    balancedReductionPercentDelta: 6.75,
    confidence: {
      score: 80,
      level: "high",
      reasons: [
        "all monitored cheap domains are covered",
        "monitored domains improve without visible regressions"
      ]
    },
    summary: "Post-tune benchmark improved, led by docs."
  }
});
await writeJson(path.join(statusRoot, "state/tuning/last-tuning.json"), {
  generatedAt: new Date(Date.now() - 16 * 60 * 60 * 1000).toISOString(),
  mode: "auto",
  canary: {
    status: "accepted",
    baselineBenchmark: {
      generatedAt: new Date(Date.now() - 17 * 60 * 60 * 1000).toISOString(),
      cheapestVariant: "saver",
      balancedReductionPercent: 32,
      saverReductionPercent: 41,
      byDomain: {
        docs: {
          cheapestVariant: "saver",
          balancedReductionPercent: 35,
          saverReductionPercent: 42
        }
      }
    }
  },
  applied: [
    {
      id: "tighten-value-gate"
    }
  ],
  blocked: []
});
await writeJson(path.join(statusRoot, "state/benchmarks/last-benchmark-cycle.json"), {
  generatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  suite: "mixed",
  iterations: 3,
  autoTuneBetweenRuns: true,
  summary: {
    outcome: "improved",
    recommendation: "The benchmark cycle improved by 4.50 balanced reduction points after 2 tuning checkpoints."
  },
  multiCycle: {
    available: true,
    latestOutcome: "improved",
    previousOutcome: "flat",
    latestOutcomeStreak: 2,
    averageBalancedDelta: 3.25,
    averageRollbackCount: 0,
    latestVsPreviousBalancedDelta: 2.5,
    outcomeCounts: {
      improved: 2,
      flat: 1
    },
    trendDirection: "improving",
    windowComparison: {
      available: true,
      windowSize: 2,
      currentWindowAverage: 4.25,
      previousWindowAverage: 1.25,
      delta: 3,
      direction: "improving",
      recommendation: "The last 2 cycle runs are improving by 3.00 balanced points versus the previous window."
    },
    confidence: {
      score: 90,
      level: "high",
      reasons: [
        "multiple benchmark cycles are available",
        "window-to-window comparison is available"
      ]
    },
    recommendation: "Recent benchmark cycles are consistently improving, with an average balanced delta of 3.25 points."
  }
});

const statusConfig = await readJson(path.join(statusRoot, "config/system.json"), {});
const runtimeStatus = await getRuntimeStatus(statusRoot, statusConfig);
assert.equal(runtimeStatus.queue.queued, 1);
assert.equal(runtimeStatus.metrics.counters.processedJobs, 2);
assert.equal(runtimeStatus.metrics.cost.liveTokensUsed, 0);
assert.equal(runtimeStatus.costSummary.queuePressure.balancedQueued, 1);
assert.equal(runtimeStatus.benchmarkSummary.loaded, true);
assert.equal(runtimeStatus.benchmarkSummary.cheapestVariant, "saver");
assert.equal(runtimeStatus.benchmarkSummary.domainDiagnostics[0].domain, "docs");
assert.equal(runtimeStatus.benchmarkSummary.domainDiagnostics[0].shouldTightenValueGate, true);
assert.equal(runtimeStatus.benchmarkSummary.domainDiagnostics[0].liveTokensUsed, 12000);
assert.equal(runtimeStatus.benchmarkSummary.domainDiagnostics[0].saverTrendStreak, 3);
assert.equal(runtimeStatus.benchmarkSummary.domainDiagnostics.find((item) => item.domain === "ui").isNoisy, true);
assert.equal(runtimeStatus.benchmarkSummary.domainTrend.docs.cheapestVariantStreak.count, 3);
assert.equal(runtimeStatus.benchmarkSummary.confidence.level, "high");
assert.equal(runtimeStatus.benchmarkSummary.tuningComparison.outcome, "improved");
assert.equal(runtimeStatus.benchmarkSummary.tuningComparison.confidence.level, "high");
assert.equal(runtimeStatus.benchmarkSummary.topWasteDomains[0].domain, "docs");
assert.equal(runtimeStatus.benchmarkSummary.topWasteDomains[0].riskLevel, "low");
assert.match(runtimeStatus.benchmarkSummary.topWasteDomains[0].expectedSavingsHint, /recover roughly/i);
assert.match(runtimeStatus.benchmarkSummary.topWasteDomains[0].whyRanked, /docs is consuming/i);
assert.equal(runtimeStatus.benchmarkSummary.safeSavingsOpportunities[0].domain, "docs");
assert.equal(runtimeStatus.benchmarkSummary.safeSavingsOpportunities[0].riskLevel, "low");
assert.match(runtimeStatus.benchmarkSummary.safeSavingsOpportunities[0].expectedSavingsHint, /recover roughly/i);
assert.match(runtimeStatus.benchmarkSummary.safeSavingsOpportunities[0].whyRanked, /stable saver streak/i);
assert.equal(runtimeStatus.benchmarkCycleSummary.loaded, true);
assert.equal(runtimeStatus.benchmarkCycleSummary.trendDirection, "improving");
assert.equal(runtimeStatus.benchmarkCycleSummary.latestOutcomeStreak, 2);
assert.equal(runtimeStatus.benchmarkCycleSummary.windowComparison.available, true);
assert.equal(runtimeStatus.benchmarkCycleSummary.windowComparison.direction, "improving");
assert.equal(runtimeStatus.benchmarkCycleSummary.confidence.level, "high");
assert.equal(runtimeStatus.tuningSummary.loaded, true);
assert.equal(runtimeStatus.tuningSummary.mode, "auto");
assert.equal(runtimeStatus.nextActions[0].action, "node src/cli.mjs tune --auto");
assert.ok(typeof runtimeStatus.nextActions[0].whyNow === "string");
assert.equal(runtimeStatus.nextActions[0].riskLevel, "low");
assert.ok(typeof runtimeStatus.nextActions[0].expectedOutcome === "string");
assert.match(runtimeStatus.compactSummary.whyExpensive, /docs|unknown-domain|No live token burn/i);
assert.match(runtimeStatus.compactSummary.whyTuneNow, /cheap-domain waste signal|Recent benchmark cycles|No strong tuning signal/i);
assert.match(runtimeStatus.compactSummary.whyQueueBlocked, /queued job|not currently blocked/i);
assert.match(runtimeStatus.compactSummary.whyConfident, /confidence is high/i);
assert.match(runtimeStatus.costSummary.recommendation, /no strong cost signal/i);

const runtimeDoctor = await runRuntimeDoctor(statusRoot, statusConfig);
assert.equal(runtimeDoctor.ok, true);
assert.ok(runtimeDoctor.findings.some((item) => item.code === "balanced-lane-heavier-than-benchmark"));
assert.ok(runtimeDoctor.findings.some((item) => item.code === "auto-tune-stale"));
assert.ok(runtimeDoctor.findings.some((item) => item.code === "domain-value-gate-drift-docs"));
assert.ok(runtimeDoctor.findings.some((item) => item.code === "post-tune-benchmark-improved"));
assert.ok(runtimeDoctor.findings.some((item) => item.code === "domain-signal-noisy-ui"));
assert.ok(runtimeDoctor.findings.some((item) => item.code === "benchmark-cycle-improving"));
assert.ok(runtimeDoctor.findings.some((item) => item.code === "benchmark-cycle-window-improving"));
assert.equal(runtimeDoctor.recommendedActions[0].action, "node src/cli.mjs tune --auto");
assert.ok(typeof runtimeDoctor.recommendedActions[0].whyNow === "string");
assert.equal(runtimeDoctor.recommendedActions[0].riskLevel, "medium");
assert.ok(typeof runtimeDoctor.recommendedActions[0].expectedOutcome === "string");
assert.equal(runtimeDoctor.compactSummary.highestSeverity, "info");
assert.ok(typeof runtimeDoctor.compactSummary.topFinding === "string");
assert.ok(typeof runtimeDoctor.compactSummary.whyExpensive === "string");

const saverCostConfig = applyReviewCostMode(await readJson(path.join(statusRoot, "config/system.json"), {}), {
  costMode: "saver",
  reviewProfile: "light"
});
assert.equal(saverCostConfig.runtimeCostControls.costMode, "saver");
assert.equal(saverCostConfig.runtimeCostControls.reviewProfile, "light");
assert.equal(saverCostConfig.reviewExecution.valueGate.minScore, 70);
assert.equal(saverCostConfig.reviewExecution.reviewProfiles.balanced.codexReasoningEffort, "medium");
assert.equal(saverCostConfig.reviewExecution.reviewProfiles.expensive.promptStyle, "light");
assert.equal(saverCostConfig.reviewExecution.operationRanking.maxAppliedOperations, 1);

const strictCostConfig = applyReviewCostMode(await readJson(path.join(statusRoot, "config/system.json"), {}), {
  costMode: "strict",
  reviewProfile: "heavy"
});
assert.equal(strictCostConfig.reviewExecution.reviewProfiles.balanced.promptStyle, "strict");
assert.equal(strictCostConfig.reviewExecution.reviewProfiles.expensive.codexReasoningEffort, "high");
assert.ok(strictCostConfig.reviewExecution.valueGate.minScore <= 45);

const doctorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-doctor-"));
await fs.cp(path.resolve("config"), path.join(doctorRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(doctorRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(doctorRoot, "state"), { recursive: true });
await ensureWorkspace(doctorRoot);

await writeJson(path.join(doctorRoot, "state/memory/review-queue.json"), [
  {
    id: "memjob-doctor-1",
    createdAt: "2026-04-18T05:10:00.000Z",
    finishedAt: "2026-04-18T05:11:00.000Z",
    status: "awaiting-approval",
    mode: "expensive",
    domains: ["security"],
    approval: {
      status: "pending",
      approvalPath: path.join(doctorRoot, "state/reviews/approvals/missing.json")
    }
  }
]);

const doctorStatus = await runRuntimeDoctor(doctorRoot, await readJson(path.join(doctorRoot, "config/system.json"), {}));
assert.equal(doctorStatus.ok, false);
assert.ok(doctorStatus.findings.some((finding) => finding.code === "missing-approval-file"));
assert.ok(doctorStatus.recommendedActions.some((item) => item.action === "Inspect state/reviews/approvals and rerun review or approval flow"));

const benchmarkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-benchmark-"));
await fs.cp(path.resolve("config"), path.join(benchmarkRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(benchmarkRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(benchmarkRoot, "state"), { recursive: true });
await ensureWorkspace(benchmarkRoot);

const benchmarkConfig = await readJson(path.join(benchmarkRoot, "config/system.json"), {});
benchmarkConfig.tuning.benchmarkHistoryRetentionEntries = 3;
benchmarkConfig.tuning.benchmarkTrendWindow = 3;
await writeJson(path.join(benchmarkRoot, "state/tuning/last-tuning.json"), {
  generatedAt: "2026-04-17T00:00:00.000Z",
  mode: "auto",
  canary: {
    status: "accepted",
    baselineBenchmark: {
      generatedAt: "2026-04-16T00:00:00.000Z",
      cheapestVariant: "saver",
      balancedReductionPercent: 20,
      saverReductionPercent: 28,
      byDomain: {
        docs: {
          cheapestVariant: "saver",
          balancedReductionPercent: 22,
          saverReductionPercent: 30
        },
        deploy: {
          cheapestVariant: "saver",
          balancedReductionPercent: 21,
          saverReductionPercent: 29
        },
        ui: {
          cheapestVariant: "balanced",
          balancedReductionPercent: 24,
          saverReductionPercent: 22
        },
        testing: {
          cheapestVariant: "saver",
          balancedReductionPercent: 20,
          saverReductionPercent: 27
        }
      }
    }
  },
  applied: []
});

let benchmarkResult;
for (let index = 0; index < 4; index += 1) {
  benchmarkResult = await runSyntheticBenchmark(benchmarkRoot, benchmarkConfig);
}
assert.equal(benchmarkResult.report.tasks.length, 5);
assert.ok(benchmarkResult.report.aggregate.tokensSaved > 0);
assert.ok(benchmarkResult.report.tasks.some((task) => task.savings.tokensSaved > 0));
assert.equal(benchmarkResult.report.aggregate.cheapestVariant, "saver");
assert.ok(benchmarkResult.report.aggregate.byVariant.saver.totalTokens <= benchmarkResult.report.aggregate.byVariant.strict.totalTokens);
assert.ok(benchmarkResult.report.tasks.every((task) => task.variants.saver));
assert.ok(benchmarkResult.report.tasks.every((task) => task.variants.strict));
const benchmarkReport = await readJson(path.join(benchmarkRoot, "state/benchmarks/last-benchmark.json"), null);
assert.equal(benchmarkReport.aggregate.taskCount, 5);
assert.ok(benchmarkReport.aggregate.byVariant.balanced.totalTokens > 0);
assert.equal(benchmarkReport.aggregate.byDomain.docs.cheapestVariant, "saver");
assert.ok(benchmarkReport.aggregate.byDomain.deploy.byVariant.saver.totalTokens > 0);
assert.equal(benchmarkReport.trend.historyEntries, 3);
assert.equal(benchmarkReport.trend.cheapestVariantStreak.variant, "saver");
assert.equal(benchmarkReport.trend.cheapestVariantStreak.count, 3);
assert.ok(["low", "medium", "high"].includes(benchmarkReport.trend.confidence.level));
assert.equal(benchmarkReport.trend.byDomain.docs.cheapestVariantStreak.variant, "saver");
assert.equal(benchmarkReport.trend.byDomain.docs.cheapestVariantStreak.count, 3);
assert.ok(typeof benchmarkReport.trend.byDomain.deploy.deltaByVariant.saver.totalTokensDelta === "number");
assert.equal(typeof benchmarkReport.trend.byDomain.ui.isNoisy, "boolean");
assert.match(benchmarkReport.trend.recommendation, /Saver has been the cheapest variant/i);
assert.equal(benchmarkReport.tuningComparison.available, true);
assert.equal(benchmarkReport.tuningComparison.outcome, "improved");
assert.ok(["low", "medium", "high"].includes(benchmarkReport.tuningComparison.confidence.level));
assert.ok(benchmarkReport.tuningComparison.balancedReductionPercentDelta > 0);
assert.equal(benchmarkReport.tuningComparison.byDomain.docs.outcome, "improved");
const benchmarkHistory = await fs.readFile(path.join(benchmarkRoot, "state/benchmarks/history.jsonl"), "utf8");
assert.equal(benchmarkHistory.trim().split("\n").length, 3);

const lowRiskBenchmark = await runSyntheticBenchmark(benchmarkRoot, benchmarkConfig, { suite: "low-risk" });
assert.equal(lowRiskBenchmark.report.suite, "low-risk");
assert.equal(lowRiskBenchmark.report.aggregate.taskCount, 4);
assert.equal(lowRiskBenchmark.report.tuningComparison.available, false);
const lowRiskHistory = await fs.readFile(path.join(benchmarkRoot, "state/benchmarks/history-low-risk.jsonl"), "utf8");
assert.equal(lowRiskHistory.trim().split("\n").length, 1);

const highRiskBenchmark = await runSyntheticBenchmark(benchmarkRoot, benchmarkConfig, { suite: "high-risk" });
assert.equal(highRiskBenchmark.report.suite, "high-risk");
assert.equal(highRiskBenchmark.report.aggregate.taskCount, 3);
assert.equal(highRiskBenchmark.report.tasks.every((task) => ["security", "migration", "architecture"].includes(task.domain)), true);

const benchmarkCycleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-benchmark-cycle-"));
await fs.cp(path.resolve("config"), path.join(benchmarkCycleRoot, "config"), { recursive: true });
await fs.cp(path.resolve("notes"), path.join(benchmarkCycleRoot, "notes"), { recursive: true });
await fs.cp(path.resolve("state"), path.join(benchmarkCycleRoot, "state"), { recursive: true });
await ensureWorkspace(benchmarkCycleRoot);

const cycleConfig = await readJson(path.join(benchmarkCycleRoot, "config/system.json"), {});
cycleConfig.tuning.benchmarkHistoryRetentionEntries = 5;
cycleConfig.tuning.benchmarkTrendWindow = 3;
cycleConfig.tuning.autoApplyEnabled = true;
cycleConfig.tuning.cooldownMinutes = 0;
cycleConfig.tuning.maxAutoApplySuggestionsPerRun = 2;
cycleConfig.tuning.benchmarkCycleComparisonWindow = 2;
await writeJson(path.join(benchmarkCycleRoot, "config/system.json"), cycleConfig);
await fs.writeFile(
  path.join(benchmarkCycleRoot, "state/benchmarks/history-cycle-low-risk.jsonl"),
  [
    JSON.stringify({ generatedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(), suite: "low-risk", summary: { outcome: "flat", balancedReductionPercentDelta: 1, rollbackCount: 0 } }),
    JSON.stringify({ generatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), suite: "low-risk", summary: { outcome: "flat", balancedReductionPercentDelta: 1.5, rollbackCount: 0 } }),
    JSON.stringify({ generatedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), suite: "low-risk", summary: { outcome: "improved", balancedReductionPercentDelta: 3, rollbackCount: 0 } })
  ].join("\n") + "\n",
  "utf8"
);
const benchmarkCycle = await runSyntheticBenchmarkCycle(benchmarkCycleRoot, {
  iterations: 3,
  autoTuneBetweenRuns: true,
  suite: "low-risk"
});
assert.equal(benchmarkCycle.suite, "low-risk");
assert.equal(benchmarkCycle.benchmarks.length, 3);
assert.equal(benchmarkCycle.tuningRuns.length, 2);
assert.ok(["improved", "flat", "degraded"].includes(benchmarkCycle.summary.outcome));
assert.ok(typeof benchmarkCycle.summary.recommendation === "string");
assert.ok(Number.isFinite(benchmarkCycle.summary.tuningRunCount));
assert.equal(benchmarkCycle.multiCycle.available, true);
assert.ok(["improving", "degrading", "mixed"].includes(benchmarkCycle.multiCycle.trendDirection));
assert.equal(benchmarkCycle.multiCycle.windowComparison.available, true);
assert.ok(["improving", "degrading", "flat"].includes(benchmarkCycle.multiCycle.windowComparison.direction));
assert.ok(["low", "medium", "high"].includes(benchmarkCycle.multiCycle.confidence.level));
const storedCycleReport = await readJson(path.join(benchmarkCycleRoot, "state/benchmarks/last-benchmark-cycle-low-risk.json"), null);
assert.equal(storedCycleReport.suite, "low-risk");
assert.equal(storedCycleReport.multiCycle.available, true);
const storedCycleHistory = await fs.readFile(path.join(benchmarkCycleRoot, "state/benchmarks/history-cycle-low-risk.jsonl"), "utf8");
assert.equal(storedCycleHistory.trim().split("\n").length, 4);

const staleQueuePath = path.join(tempRoot, "state/memory/review-queue.json");
const stalePolicyStatePath = path.join(tempRoot, "state/memory/policy-state.json");
const staleCreatedAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();

await fs.writeFile(staleQueuePath, JSON.stringify([
  {
    id: "memjob-stale-1",
    createdAt: staleCreatedAt,
    mode: "expensive",
    budget: 700,
    task: "re-score a stale auth migration review batch",
    domains: ["auth", "migration", "architecture"],
    reasons: ["Synthetic stale-job test."],
    sourceEventId: "evt-stale-1",
    sourceNoteId: "z-120-agent-orchestration",
    sourceEventIds: ["evt-stale-1"],
    sourceNoteIds: ["z-120-agent-orchestration"],
    tasks: [
      {
        task: "re-score a stale auth migration review batch",
        reasons: ["Synthetic stale-job test."],
        sourceEventId: "evt-stale-1",
        sourceNoteId: "z-120-agent-orchestration",
        addedAt: staleCreatedAt
      }
    ],
    mergedTaskCount: 1,
    status: "queued"
  }
], null, 2));
await fs.writeFile(stalePolicyStatePath, JSON.stringify({
  domains: {
    auth: { eventCount: 1, queuedJobs: 1, lastTask: null, lastMode: "expensive", lastUpdatedAt: staleCreatedAt }
  },
  recentModes: [],
  lastDecisionAt: staleCreatedAt
}, null, 2));

const staleRun = await processReviewQueue(tempRoot, config, { maxJobs: 1 });
assert.equal(staleRun.processedCount, 1);
assert.equal(staleRun.processed[0].adapter, "dry-run");
const staleReport = await readJson(staleRun.processed[0].reportPath, null);
assert.equal(staleReport.staleness.level, "stale");
assert.equal(staleReport.execution.adapter, "dry-run");
assert.match(staleReport.execution.output.prompt, /Job staleness: stale/);

const expiredCreatedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
await fs.writeFile(staleQueuePath, JSON.stringify([
  {
    id: "memjob-expired-1",
    createdAt: expiredCreatedAt,
    mode: "expensive",
    budget: 700,
    task: "skip an expired auth migration review batch",
    domains: ["auth", "migration", "architecture"],
    reasons: ["Synthetic expired-job test."],
    sourceEventId: "evt-expired-1",
    sourceNoteId: "z-120-agent-orchestration",
    sourceEventIds: ["evt-expired-1"],
    sourceNoteIds: ["z-120-agent-orchestration"],
    tasks: [
      {
        task: "skip an expired auth migration review batch",
        reasons: ["Synthetic expired-job test."],
        sourceEventId: "evt-expired-1",
        sourceNoteId: "z-120-agent-orchestration",
        addedAt: expiredCreatedAt
      }
    ],
    mergedTaskCount: 1,
    status: "queued"
  }
], null, 2));
await fs.writeFile(stalePolicyStatePath, JSON.stringify({
  domains: {
    auth: { eventCount: 1, queuedJobs: 1, lastTask: null, lastMode: "expensive", lastUpdatedAt: expiredCreatedAt }
  },
  recentModes: [],
  lastDecisionAt: expiredCreatedAt
}, null, 2));

const expiredRun = await processReviewQueue(tempRoot, config, { maxJobs: 1 });
assert.equal(expiredRun.processedCount, 1);
assert.equal(expiredRun.processed[0].adapter, "stale-policy");
const expiredReport = await readJson(expiredRun.processed[0].reportPath, null);
assert.equal(expiredReport.staleness.level, "expired");
assert.equal(expiredReport.execution.adapter, "stale-policy");
assert.match(expiredReport.noteChanges.reason, /too old/i);

const idempotencyResult = await applyIdempotencyGuard(tempRoot, [
  {
    type: "create_note",
    noteId: "",
    sourceNoteId: "",
    targetNoteId: "",
    title: "Atomic Zettelkasten notes",
    kind: "principle",
    summary: "Atomic Zettelkasten notes should stay small, linkable, and easy to retrieve with narrow context bundles.",
    signals: [
      "Keep each note focused on one durable idea",
      "Prefer small linked notes over large summaries"
    ],
    tagsToAdd: [],
    linksToAdd: [],
    tags: ["zettelkasten", "notes", "atomic", "linking"],
    links: ["z-000-index"]
  },
  {
    type: "create_note",
    noteId: "",
    sourceNoteId: "",
    targetNoteId: "",
    title: "Review worker contract snapshots",
    kind: "decision",
    summary: "Review workers should snapshot the contract they validated so later reruns can explain why a note update was accepted.",
    signals: [
      "Persist the validated review contract",
      "Make reruns explainable across worker revisions"
    ],
    tagsToAdd: [],
    linksToAdd: [],
    tags: ["review-worker", "contracts"],
    links: ["z-130-background-memory-sync"]
  }
], config.reviewExecution.idempotency);

assert.equal(idempotencyResult.passed, true);
assert.equal(idempotencyResult.accepted.length, 2);
assert.equal(idempotencyResult.rejected.length, 0);
assert.equal(idempotencyResult.rewritten.length, 1);
assert.equal(idempotencyResult.rewritten[0].noteId, "z-110-atomic-notes");
assert.equal(idempotencyResult.accepted[0].type, "append_note_update");
assert.equal(idempotencyResult.accepted[0].noteId, "z-110-atomic-notes");
assert.ok(!idempotencyResult.accepted[0].linksToAdd.includes("z-110-atomic-notes"));
assert.match(idempotencyResult.rewritten[0].reason, /rewrote duplicate create_note/i);

const hardRejectIdempotencyResult = await applyIdempotencyGuard(tempRoot, [
  {
    type: "create_note",
    noteId: "",
    sourceNoteId: "",
    targetNoteId: "",
    title: "Atomic Zettelkasten notes",
    kind: "principle",
    summary: "Atomic Zettelkasten notes should stay small, linkable, and easy to retrieve with narrow context bundles.",
    signals: [
      "Keep each note focused on one durable idea",
      "Prefer small linked notes over large summaries"
    ],
    tagsToAdd: [],
    linksToAdd: [],
    tags: ["zettelkasten", "notes", "atomic", "linking"],
    links: ["z-000-index"]
  }
], {
  ...config.reviewExecution.idempotency,
  rewriteDuplicatesToAppendUpdate: false
});

assert.equal(hardRejectIdempotencyResult.passed, false);
assert.equal(hardRejectIdempotencyResult.accepted.length, 0);
assert.equal(hardRejectIdempotencyResult.rewritten.length, 0);
assert.equal(hardRejectIdempotencyResult.rejected.length, 1);
assert.equal(hardRejectIdempotencyResult.rejected[0].noteId, "z-110-atomic-notes");
assert.match(hardRejectIdempotencyResult.rejected[0].reason, /too similar/i);

const applyResult = await applyReviewOperations(tempRoot, [
  {
    type: "append_note_update",
    noteId: "z-100-context-minimization",
    summary: "Prefer small note bundles when a task only touches one domain.",
    signals: ["Keep retrieval narrow before increasing the token budget."],
    tagsToAdd: ["retrieval-tuning"],
    linksToAdd: ["z-110-atomic-notes"]
  },
  {
    type: "create_note",
    title: "Review-driven note hygiene",
    kind: "principle",
    summary: "Queued reviews should create or refine notes only when local heuristics are no longer enough.",
    signals: ["Run deep cleanup only after thresholds or hard triggers fire."],
    tags: ["review", "memory", "policy"],
    links: ["z-130-background-memory-sync"]
  }
], { timestamp: "2026-04-18T00:00:00.000Z" });

assert.equal(applyResult.applied.length, 2);

const notesAfterApply = await loadNotes(tempRoot);
const updatedContextNote = notesAfterApply.find((note) => note.id === "z-100-context-minimization");
assert.ok(updatedContextNote.body.includes("Prefer small note bundles"));
assert.ok(updatedContextNote.tags.includes("retrieval-tuning"));

const createdReviewNote = notesAfterApply.find((note) => note.title === "Review-driven note hygiene");
assert.ok(createdReviewNote);
assert.equal(createdReviewNote.kind, "principle");

const mergeResult = await applyReviewOperations(tempRoot, [
  {
    type: "merge_note_into_existing",
    sourceNoteId: createdReviewNote.id,
    targetNoteId: "z-130-background-memory-sync",
    summary: "The review hygiene guidance belongs inside the background memory sync note.",
    signals: ["Keep duplicate policy notes merged into the operational memory note."],
    tagsToAdd: ["note-merge"]
  }
], { timestamp: "2026-04-18T01:00:00.000Z" });

assert.equal(mergeResult.applied.length, 1);

const invalidResult = await applyReviewOperations(tempRoot, [
  {
    type: "create_note",
    noteId: "",
    sourceNoteId: "",
    targetNoteId: "",
    title: "   ",
    kind: "",
    summary: "This operation should be skipped because the title is blank.",
    signals: [],
    tagsToAdd: [],
    linksToAdd: [],
    tags: [],
    links: []
  }
], { timestamp: "2026-04-18T01:30:00.000Z" });

assert.equal(invalidResult.applied.length, 0);
assert.equal(invalidResult.skipped.length, 1);
assert.match(invalidResult.skipped[0].reason, /requires title/);

const gateResult = await evaluateReviewOperations(tempRoot, [
  {
    type: "append_note_update",
    noteId: "z-100-context-minimization",
    sourceNoteId: "",
    targetNoteId: "",
    title: "",
    kind: "",
    summary: "Too short",
    signals: [],
    tagsToAdd: [],
    linksToAdd: [],
    tags: [],
    links: []
  },
  {
    type: "create_note",
    noteId: "",
    sourceNoteId: "",
    targetNoteId: "",
    title: "Migration-safe auth review contract",
    kind: "decision",
    summary: "Review workers should validate a versioned internal contract so auth migrations do not leak database-shape changes into memory review authorization.",
    signals: [
      "Use versioned internal auth contracts for review workers",
      "Keep worker validation stable across auth migrations"
    ],
    tagsToAdd: [],
    linksToAdd: [],
    tags: ["auth", "migration", "review-worker"],
    links: ["z-000-index"]
  }
]);

assert.equal(gateResult.passed, true);
assert.equal(gateResult.accepted.length, 1);
assert.equal(gateResult.rejected.length, 1);
assert.match(gateResult.rejected[0].reason, /too short/i);

const normalizationResult = await normalizeReviewOperations(tempRoot, [
  {
    type: "append_note_update",
    noteId: "z-000-index",
    sourceNoteId: "",
    targetNoteId: "",
    title: "",
    kind: "",
    summary: "Normalize title-based links into stable note ids before apply.",
    signals: ["Resolve note titles into real ids."],
    tagsToAdd: [],
    linksToAdd: ["Atomic Zettelkasten notes"],
    tags: [],
    links: ["Context minimization pipeline"]
  }
]);

assert.equal(normalizationResult.normalized[0].linksToAdd[0], "z-110-atomic-notes");
assert.equal(normalizationResult.normalized[0].links[0], "z-100-context-minimization");
assert.ok(normalizationResult.changes.length >= 2);

const gateAfterNormalization = await evaluateReviewOperations(tempRoot, normalizationResult.normalized);
assert.equal(gateAfterNormalization.passed, true);

const semanticGuardResult = await evaluateReviewOperations(tempRoot, [
  {
    type: "append_note_update",
    noteId: "z-000-index",
    sourceNoteId: "",
    targetNoteId: "",
    title: "",
    kind: "",
    summary: "Add a self-link to the index note even though this should be blocked.",
    signals: ["This should fail because self-links are noise."],
    tagsToAdd: ["auth"],
    linksToAdd: ["z-000-index"],
    tags: [],
    links: []
  }
]);

assert.equal(semanticGuardResult.passed, false);
assert.equal(semanticGuardResult.accepted.length, 0);
assert.equal(semanticGuardResult.rejected.length, 1);
assert.match(semanticGuardResult.rejected[0].reason, /self-link/i);

const rankingResult = await rankReviewOperations(tempRoot, [
  {
    type: "append_note_update",
    noteId: "z-000-index",
    sourceNoteId: "",
    targetNoteId: "",
    title: "",
    kind: "",
    summary: "Link a new auth architecture note from the index so retrieval can find it quickly.",
    signals: ["Index the architecture note for retrieval."],
    tagsToAdd: ["auth"],
    linksToAdd: ["z-110-atomic-notes"],
    tags: [],
    links: []
  },
  {
    type: "create_note",
    noteId: "",
    sourceNoteId: "",
    targetNoteId: "",
    title: "Versioned auth contracts for review workers",
    kind: "architecture",
    summary: "Review workers should validate versioned auth contracts so migrations do not couple authorization to provider-specific identity payloads.",
    signals: [
      "Use versioned contracts for review workers",
      "Keep migrations independent from provider payloads"
    ],
    tagsToAdd: [],
    linksToAdd: [],
    tags: ["auth", "migration", "review-worker"],
    links: ["z-000-index", "z-110-atomic-notes"]
  },
  {
    type: "append_note_update",
    noteId: "z-130-background-memory-sync",
    sourceNoteId: "",
    targetNoteId: "",
    title: "",
    kind: "",
    summary: "Background sync should preserve auth migration decisions as linked atomic notes instead of broad summaries.",
    signals: [
      "Promote auth migration decisions into atomic notes",
      "Link protected-domain notes automatically"
    ],
    tagsToAdd: ["auth", "architecture"],
    linksToAdd: ["z-000-index"],
    tags: [],
    links: []
  }
], {
  ...config.reviewExecution.operationRanking,
  minScore: 20
});

assert.equal(rankingResult.passed, true);
assert.equal(rankingResult.selected.length, 2);
assert.equal(rankingResult.deferred.length, 1);
assert.equal(rankingResult.ranked[0].type, "create_note");
assert.match(rankingResult.deferred[0].reason, /apply budget/i);

const notesAfterMerge = await loadNotes(tempRoot);
const mergeTarget = notesAfterMerge.find((note) => note.id === "z-130-background-memory-sync");
assert.ok(mergeTarget.body.includes("Review Merge"));
assert.ok(mergeTarget.tags.includes("note-merge"));

const deprecatedSource = notesAfterMerge.find((note) => note.id === createdReviewNote.id);
assert.equal(deprecatedSource.kind, "deprecated");
assert.ok(deprecatedSource.tags.includes("deprecated"));
assert.ok(deprecatedSource.links.includes("z-130-background-memory-sync"));

const compactTaskOne = "design an auth migration review queue compaction pass";
const compactTaskTwo = "design a follow-up auth migration review queue compaction pass";
const compactProfileOne = classifyTask(compactTaskOne);
const compactProfileTwo = classifyTask(compactTaskTwo);
const compactDecisionOne = await evaluateMemoryPolicy(tempRoot, compactProfileOne, config);
const compactDecisionTwo = await evaluateMemoryPolicy(tempRoot, compactProfileTwo, config);

const compactSyncOne = await syncMemory(
  tempRoot,
  {
    task: compactTaskOne,
    summary: "Queue the first review job that should become the compaction anchor.",
    artifacts: ["runner", "compaction"]
  },
  config
);
const compactOutcomeOne = await applyMemoryPolicyOutcome(tempRoot, compactDecisionOne, compactProfileOne, compactSyncOne, config);

const compactSyncTwo = await syncMemory(
  tempRoot,
  {
    task: compactTaskTwo,
    summary: "Queue the second similar review job so the queue can compact it into the first one.",
    artifacts: ["runner", "compaction", "follow-up"]
  },
  config
);
const compactOutcomeTwo = await applyMemoryPolicyOutcome(tempRoot, compactDecisionTwo, compactProfileTwo, compactSyncTwo, config);

assert.equal(compactOutcomeOne.queuedJob.id, compactOutcomeTwo.queuedJob.id);

const compactedQueue = await readJson(path.join(tempRoot, "state/memory/review-queue.json"), []);
const queuedCompactedJobs = compactedQueue.filter((job) => job.status === "queued");
assert.equal(queuedCompactedJobs.length, 1);
assert.equal(queuedCompactedJobs[0].mergedTaskCount, 2);
assert.equal(queuedCompactedJobs[0].tasks.length, 2);
assert.equal(queuedCompactedJobs[0].sourceEventIds.length, 2);
assert.equal(queuedCompactedJobs[0].compaction.mergeCount, 1);

const runnerResult = await runReviewWorker(tempRoot, config, {
  maxJobs: 1
});
assert.equal(runnerResult.mode, "once");
assert.equal(runnerResult.processedCount, 1);

const compactedReport = await readJson(runnerResult.processed[0].reportPath, null);
assert.equal(compactedReport.payload.job.mergedTaskCount, 2);
assert.match(compactedReport.execution.output.prompt, /Merged tasks in this review job: 2/);
assert.match(compactedReport.execution.output.prompt, /design an auth migration review queue compaction pass/);
assert.match(compactedReport.execution.output.prompt, /design a follow-up auth migration review queue compaction pass/);

const workerState = await getWorkerState(tempRoot);
assert.equal(workerState.status, "idle");
assert.equal(workerState.lastRunMode, "once");
assert.ok(workerState.runs >= 1);

const taskFlowResult = await runTaskFlow(tempRoot, config, {
  task: "document a medium-risk auth review handoff",
  summary: "Capture the handoff and immediately process the queued review in one flow.",
  artifacts: ["task-flow", "review"],
  reviewNow: true,
  reviewConfig: config
});

assert.equal(taskFlowResult.review.status, "processed");
assert.equal(taskFlowResult.review.result.processedCount, 1);
assert.equal(taskFlowResult.review.result.processed[0].adapter, "dry-run");
assert.equal(taskFlowResult.policyOutcome.queuedJob.id, taskFlowResult.review.queuedJobId);

const cursorStubDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-cursor-stub-"));
const cursorStubPath = path.join(cursorStubDir, "cursor-stub.mjs");
await fs.writeFile(cursorStubPath, `#!/usr/bin/env node
console.log("Cursor helper preface");
console.log(JSON.stringify({
  summary: "Cursor proposed one safe note update.",
  operations: [
    {
      type: "append_note_update",
      noteId: "z-130-background-memory-sync",
      sourceNoteId: "",
      targetNoteId: "",
      title: "",
      kind: "",
      summary: "Cursor can run in read-only review mode and still propose safe memory updates.",
      signals: ["Use Cursor ask mode for read-only memory review"],
      tagsToAdd: ["cursor"],
      linksToAdd: ["z-000-index"],
      tags: [],
      links: []
    }
  ]
}, null, 2));
`, "utf8");
await fs.chmod(cursorStubPath, 0o755);

const cursorExecution = await executeReviewPayload(tempRoot, {
  job: {
    id: "memjob-cursor-1",
    mode: "balanced",
    budget: 300,
    task: "capture Cursor review learnings",
    domains: ["docs", "memory"],
    reasons: ["Synthetic Cursor provider test."]
  },
  contextBundle: {
    selectedNotes: [
      {
        id: "z-130-background-memory-sync",
        title: "Background Memory Sync",
        tags: ["memory", "sync"],
        snippet: "Background sync should update atomic notes instead of broad summaries."
      }
    ]
  }
}, {
  reviewExecution: {
    providerByMode: {
      balanced: "cursor"
    },
    nativeCursor: {
      enabled: true,
      binary: cursorStubPath,
      mode: "ask",
      sandbox: "enabled",
      trustWorkspace: true,
      force: false,
      maxAttempts: 1,
      retryBackoffMs: 0,
      extraArgs: []
    }
  }
});

assert.equal(cursorExecution.provider, "cursor");
assert.equal(cursorExecution.adapter, "cursor-native");
assert.equal(cursorExecution.status, "completed");
assert.equal(cursorExecution.output.parsed.summary, "Cursor proposed one safe note update.");
assert.equal(cursorExecution.output.parsed.operations[0].noteId, "z-130-background-memory-sync");
assert.ok(cursorExecution.output.args.includes("--mode"));
assert.ok(cursorExecution.output.args.includes("ask"));

const codexStubDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-codex-stub-"));
const codexStubPath = path.join(codexStubDir, "codex-stub.mjs");
await fs.writeFile(codexStubPath, `#!/usr/bin/env node
import fs from "node:fs/promises";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "";

if (outputPath) {
  await fs.writeFile(outputPath, JSON.stringify({
    summary: "Codex light lane returned one compact update.",
    operations: [
      {
        type: "append_note_update",
        noteId: "z-130-background-memory-sync",
        sourceNoteId: "",
        targetNoteId: "",
        title: "",
        kind: "",
        summary: "Balanced reviews can use a lighter prompt and lower reasoning effort.",
        signals: ["Use a lighter balanced review lane"],
        tagsToAdd: ["balanced-review"],
        linksToAdd: ["z-000-index"],
        tags: [],
        links: []
      }
    ]
  }, null, 2));
}

console.log("tokens used");
console.log("123");
`, "utf8");
await fs.chmod(codexStubPath, 0o755);

const codexLightExecution = await executeReviewPayload(tempRoot, {
  job: {
    id: "memjob-codex-light-1",
    mode: "balanced",
    budget: 300,
    task: "capture balanced review lane learnings",
    domains: ["docs", "memory"],
    reasons: ["Synthetic Codex light-lane test."]
  },
  contextBundle: {
    selectedNotes: [
      {
        id: "z-130-background-memory-sync",
        title: "Background Memory Sync",
        tags: ["memory", "sync"],
        snippet: "Background sync should update atomic notes instead of broad summaries."
      }
    ]
  }
}, {
  reviewExecution: {
    providerByMode: {
      balanced: "codex"
    },
    nativeCodex: {
      enabled: true,
      binary: codexStubPath,
      sandbox: "workspace-write",
      maxAttempts: 1,
      retryBackoffMs: 0,
      extraArgs: []
    },
    reviewProfiles: {
      balanced: {
        promptStyle: "light",
        maxOperations: 2,
        codexReasoningEffort: "medium"
      }
    }
  }
});

assert.equal(codexLightExecution.provider, "codex");
assert.equal(codexLightExecution.adapter, "codex-native");
assert.equal(codexLightExecution.status, "completed");
assert.equal(codexLightExecution.output.usage.totalTokens, 123);
assert.equal(codexLightExecution.output.reviewProfile.promptStyle, "light");
assert.ok(codexLightExecution.output.args.includes("-c"));
assert.ok(codexLightExecution.output.args.includes('model_reasoning_effort="medium"'));

console.log("smoke test passed");
