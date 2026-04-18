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
import { applyReviewRetention, inspectReviewQueue, processReviewQueue } from "../src/lib/review-worker.mjs";
import { applyReviewOperations } from "../src/lib/review-note-engine.mjs";
import { getWorkerState, runReviewWorker } from "../src/lib/review-runner.mjs";
import { runTaskFlow } from "../src/lib/task-flow-engine.mjs";
import { evaluateReviewOperations } from "../src/lib/review-quality-engine.mjs";
import { normalizeReviewOperations } from "../src/lib/review-normalization-engine.mjs";
import { rankReviewOperations } from "../src/lib/review-ranking-engine.mjs";
import { applyIdempotencyGuard } from "../src/lib/review-idempotency-engine.mjs";
import {
  beginReviewApplyRecovery,
  recoverInterruptedReviewRun
} from "../src/lib/review-recovery-engine.mjs";

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

console.log("smoke test passed");
