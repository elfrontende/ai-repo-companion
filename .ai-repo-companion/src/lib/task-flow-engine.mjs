import { classifyTask } from "./task-engine.mjs";
import { planAgents } from "./agent-engine.mjs";
import { assembleContext, loadNotes } from "./context-engine.mjs";
import { syncMemory } from "./memory-engine.mjs";
import { applyMemoryPolicyOutcome, evaluateMemoryPolicy } from "./policy-engine.mjs";
import { processReviewQueue } from "./review-worker.mjs";
import { completeTaskRun, failTaskRun, startTaskRun, updateTaskRun } from "./run-engine.mjs";
import { runOrchestratedTask } from "./orchestrator-engine.mjs";

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
  const runState = await startTaskRun(rootDir, {
    task,
    summary,
    artifacts,
    taskProfile
  });
  let run = runState.run;

  try {
    const plan = await planAgents(rootDir, taskProfile, config);
    run = await updateTaskRun(rootDir, run.id, { plan }, {
      stage: "planned",
      note: "Planned the initial agent roster and background jobs."
    });

    const memoryPolicy = await evaluateMemoryPolicy(rootDir, taskProfile, config);
    run = await updateTaskRun(rootDir, run.id, { memoryPolicy }, {
      stage: "policy-evaluated",
      note: "Evaluated memory policy for the task."
    });

    const notes = await loadNotes(rootDir);
    const contextBundle = assembleContext(task, notes, {
      tokenBudget: Number(options.budget) || config.retrieval?.defaultTokenBudget || 1200,
      maxNotes: config.retrieval?.maxNotesPerBundle ?? 6
    });
    run = await updateTaskRun(rootDir, run.id, { contextBundle }, {
      stage: "context-assembled",
      note: "Assembled bounded context for the task."
    });

    const orchestration = await runOrchestratedTask(rootDir, config, {
      runId: run.id,
      task,
      summary,
      artifacts,
      taskProfile,
      plan,
      contextBundle
    });
    run = await updateTaskRun(rootDir, run.id, {
      multiAgent: {
        enabled: orchestration.enabled,
        rolloutMode: orchestration.rolloutMode,
        status: orchestration.status,
        finalVerdict: orchestration.finalVerdict
      }
    }, {
      stage: "multi-agent-executed",
      note: "Executed the multi-agent runtime for the task."
    });

    const syncResult = await syncMemory(
      rootDir,
      {
        task,
        summary: orchestration.rolloutMode === "advisory"
          ? summary
          : (orchestration.memoryCapture?.summary ?? summary),
        artifacts: orchestration.rolloutMode === "advisory"
          ? artifacts
          : (orchestration.memoryCapture?.kind
          ? uniqueArtifacts([...(artifacts ?? []), orchestration.memoryCapture.kind])
          : artifacts)
      },
      config
    );
    run = await updateTaskRun(rootDir, run.id, { sync: syncResult }, {
      stage: "memory-synced",
      note: "Synced task output into durable memory."
    });

    const policyOutcome = await applyMemoryPolicyOutcome(rootDir, memoryPolicy, taskProfile, syncResult, config);
    run = await updateTaskRun(rootDir, run.id, { policyOutcome }, {
      stage: "policy-applied",
      note: "Applied memory policy outcome and updated the queue."
    });

    const result = {
      taskProfile,
      plan,
      contextBundle,
      orchestration,
      memoryPolicy,
      sync: syncResult,
      policyOutcome
    };

    if (!reviewNow) {
      const review = {
        status: "not-requested",
        reason: "Immediate review was not requested."
      };
      run = await completeTaskRun(rootDir, run.id, {
        review
      }, {
        stage: "completed",
        note: "Completed task flow without immediate review."
      });
      return {
        ...result,
        review,
        run: summarizeRun(run, runState.runPath)
      };
    }

    if (!policyOutcome.queuedJob) {
      const review = {
        status: "skipped",
        reason: "This task did not queue a review job."
      };
      run = await completeTaskRun(rootDir, run.id, {
        review
      }, {
        stage: "completed",
        note: "Completed task flow without a queued review job."
      });
      return {
        ...result,
        review,
        run: summarizeRun(run, runState.runPath)
      };
    }

    const reviewResult = await processReviewQueue(rootDir, config, {
      maxJobs: 1,
      jobId: policyOutcome.queuedJob.id,
      reviewConfig: options.reviewConfig
    });
    const review = {
      status: reviewResult.processedCount > 0 ? "processed" : "skipped",
      queuedJobId: policyOutcome.queuedJob.id,
      result: reviewResult
    };
    run = await completeTaskRun(rootDir, run.id, {
      review
    }, {
      stage: "completed",
      note: "Completed task flow with immediate review processing."
    });

    return {
      ...result,
      review,
      run: summarizeRun(run, runState.runPath)
    };
  } catch (error) {
    const failedRun = await failTaskRun(rootDir, run.id, error, {}, {
      stage: "failed"
    });
    throw Object.assign(error, {
      run: summarizeRun(failedRun, runState.runPath)
    });
  }
}

function summarizeRun(run, runPath) {
  return {
    id: run.id,
    status: run.status,
    currentStage: run.currentStage,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt ?? null,
    failedAt: run.failedAt ?? null,
    runPath
  };
}

function uniqueArtifacts(values = []) {
  return [...new Set(values.filter(Boolean))];
}
