import { classifyTask } from "./task-engine.mjs";
import { planAgents } from "./agent-engine.mjs";
import { assembleContext, loadNotes } from "./context-engine.mjs";
import { syncMemory } from "./memory-engine.mjs";
import { applyMemoryPolicyOutcome, evaluateMemoryPolicy } from "./policy-engine.mjs";
import { processReviewQueue } from "./review-worker.mjs";

// This module provides the first end-to-end "finish a task" flow.
// Before this file existed, callers had to manually compose:
// 1. sync
// 2. queue inspection
// 3. review
//
// A newbie-friendly CLI needs one explicit entrypoint that says:
// "I finished work on a task, now update memory and optionally run review."

export async function runTaskFlow(rootDir, config, options = {}) {
  const task = options.task ?? "";
  const summary = options.summary ?? "No explicit summary provided.";
  const artifacts = options.artifacts ?? [];
  const reviewNow = Boolean(options.reviewNow);
  const taskProfile = classifyTask(task);
  const plan = await planAgents(rootDir, taskProfile, config);
  const memoryPolicy = await evaluateMemoryPolicy(rootDir, taskProfile, config);
  const notes = await loadNotes(rootDir);
  const contextBundle = assembleContext(task, notes, {
    tokenBudget: Number(options.budget) || config.retrieval?.defaultTokenBudget || 1200,
    maxNotes: config.retrieval?.maxNotesPerBundle ?? 6
  });
  const syncResult = await syncMemory(
    rootDir,
    {
      task,
      summary,
      artifacts
    },
    config
  );
  const policyOutcome = await applyMemoryPolicyOutcome(rootDir, memoryPolicy, taskProfile, syncResult, config);

  const result = {
    taskProfile,
    plan,
    contextBundle,
    memoryPolicy,
    sync: syncResult,
    policyOutcome
  };

  if (!reviewNow) {
    return {
      ...result,
      review: {
        status: "not-requested",
        reason: "Immediate review was not requested."
      }
    };
  }

  if (!policyOutcome.queuedJob) {
    return {
      ...result,
      review: {
        status: "skipped",
        reason: "This task did not queue a review job."
      }
    };
  }

  const reviewResult = await processReviewQueue(rootDir, config, {
    maxJobs: 1,
    jobId: policyOutcome.queuedJob.id,
    reviewConfig: options.reviewConfig
  });

  return {
    ...result,
    review: {
      status: reviewResult.processedCount > 0 ? "processed" : "skipped",
      queuedJobId: policyOutcome.queuedJob.id,
      result: reviewResult
    }
  };
}
