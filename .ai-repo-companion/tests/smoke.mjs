import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureWorkspace } from "../src/lib/bootstrap.mjs";
import { readJson } from "../src/lib/store.mjs";
import { classifyTask } from "../src/lib/task-engine.mjs";
import { planAgents } from "../src/lib/agent-engine.mjs";
import { assembleContext, loadNotes } from "../src/lib/context-engine.mjs";
import { syncMemory } from "../src/lib/memory-engine.mjs";
import { applyMemoryPolicyOutcome, evaluateMemoryPolicy } from "../src/lib/policy-engine.mjs";
import { inspectReviewQueue, processReviewQueue } from "../src/lib/review-worker.mjs";
import { applyReviewOperations } from "../src/lib/review-note-engine.mjs";

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

const policyOutcome = await applyMemoryPolicyOutcome(tempRoot, memoryPolicy, taskProfile, sync);
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

console.log("smoke test passed");
