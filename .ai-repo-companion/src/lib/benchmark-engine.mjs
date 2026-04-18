import path from "node:path";
import { loadNotes, assembleContext } from "./context-engine.mjs";
import { classifyTask } from "./task-engine.mjs";
import { evaluateMemoryPolicy } from "./policy-engine.mjs";
import { appendLine, writeJson } from "./store.mjs";

const defaultBenchmarkTasks = [
  {
    id: "docs-small",
    task: "fix a typo and tighten wording in the deployment README",
    difficulty: "small"
  },
  {
    id: "ui-medium",
    task: "add validation rules and error states for a login form component",
    difficulty: "medium"
  },
  {
    id: "auth-hard",
    task: "design a security-focused migration plan for auth middleware and permission checks",
    difficulty: "hard"
  },
  {
    id: "testing-medium",
    task: "investigate a flaky regression test around API retries and timeouts",
    difficulty: "medium"
  },
  {
    id: "deploy-hard",
    task: "prepare a migration-safe CI/CD rollout and deployment fallback checklist",
    difficulty: "hard"
  }
];

export async function runSyntheticBenchmark(rootDir, config) {
  const notes = augmentWithNoiseNotes(await loadNotes(rootDir));
  const allNoteTokens = notes.reduce((total, note) => total + note.tokenEstimate, 0);
  const allNoteCount = notes.length;
  const taskResults = [];

  for (const sample of defaultBenchmarkTasks) {
    const taskProfile = classifyTask(sample.task);
    const memoryPolicy = await evaluateMemoryPolicy(rootDir, taskProfile, config);
    const context = assembleContext(sample.task, notes, {
      tokenBudget: config.retrieval?.defaultTokenBudget ?? 1200,
      maxNotes: config.retrieval?.maxNotesPerBundle ?? 6
    });
    const reviewQueued = Boolean(memoryPolicy.shouldQueueReview);
    const systemReviewTokens = reviewQueued ? memoryPolicy.reviewBudget ?? 0 : 0;
    const baselineReviewTokens = reviewQueued ? allNoteTokens : 0;
    const systemTotal = context.usedTokens;
    const baselineTotal = allNoteTokens;

    taskResults.push({
      id: sample.id,
      difficulty: sample.difficulty,
      task: sample.task,
      mode: memoryPolicy.mode,
      reviewQueued,
      withSystem: {
        selectedNotes: context.selectedNotes.length,
        contextTokens: context.usedTokens,
        reviewTokens: systemReviewTokens,
        totalTokens: systemTotal
      },
      baseline: {
        selectedNotes: allNoteCount,
        contextTokens: allNoteTokens,
        reviewTokens: baselineReviewTokens,
        totalTokens: baselineTotal
      },
      savings: {
        tokensSaved: baselineTotal - systemTotal,
        reductionPercent: baselineTotal > 0
          ? Number((((baselineTotal - systemTotal) / baselineTotal) * 100).toFixed(2))
          : 0
      },
      reviewComparison: {
        reviewQueued,
        withSystemReviewTokens: systemReviewTokens,
        baselineReviewTokens
      }
    });
  }

  const aggregate = aggregateBenchmarkResults(taskResults);
  const report = {
    generatedAt: new Date().toISOString(),
    tasks: taskResults,
    aggregate
  };
  const reportPath = path.join(rootDir, "state/benchmarks/last-benchmark.json");
  const historyPath = path.join(rootDir, "state/benchmarks/history.jsonl");
  await writeJson(reportPath, report);
  await appendLine(historyPath, JSON.stringify({
    generatedAt: report.generatedAt,
    aggregate
  }));

  return {
    reportPath,
    report
  };
}

function augmentWithNoiseNotes(notes) {
  const noiseNotes = Array.from({ length: 18 }, (_, index) => ({
    id: `z-noise-${index + 1}`,
    title: `Synthetic unrelated note ${index + 1}`,
    kind: "noise",
    tags: ["noise", "benchmark", `topic-${index + 1}`],
    links: [],
    body: "Synthetic benchmark note about an unrelated domain that should not be retrieved for focused engineering tasks.",
    tokenEstimate: 160,
    filePath: ""
  }));

  return [...notes, ...noiseNotes];
}

function aggregateBenchmarkResults(taskResults) {
  const baselineTokens = taskResults.reduce((total, item) => total + item.baseline.totalTokens, 0);
  const systemTokens = taskResults.reduce((total, item) => total + item.withSystem.totalTokens, 0);

  return {
    taskCount: taskResults.length,
    baselineTotalTokens: baselineTokens,
    systemTotalTokens: systemTokens,
    tokensSaved: baselineTokens - systemTokens,
    reductionPercent: baselineTokens > 0
      ? Number((((baselineTokens - systemTokens) / baselineTokens) * 100).toFixed(2))
      : 0,
    averageReductionPercent: Number((
      taskResults.reduce((total, item) => total + item.savings.reductionPercent, 0) / taskResults.length
    ).toFixed(2))
  };
}
