import fs from "node:fs/promises";
import path from "node:path";
import { loadNotes, assembleContext } from "./context-engine.mjs";
import { classifyTask } from "./task-engine.mjs";
import { evaluateMemoryPolicy } from "./policy-engine.mjs";
import { appendLine, writeJson } from "./store.mjs";
import { applyReviewCostMode } from "./review-cost-mode-engine.mjs";
import { assessReviewValueGate } from "./review-value-gate-engine.mjs";

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

const benchmarkVariants = [
  { id: "saver", costMode: "saver", reviewProfile: "light" },
  { id: "balanced", costMode: "balanced", reviewProfile: "auto" },
  { id: "strict", costMode: "strict", reviewProfile: "heavy" }
];

export async function runSyntheticBenchmark(rootDir, config) {
  const notes = augmentWithNoiseNotes(await loadNotes(rootDir));
  const allNoteTokens = notes.reduce((total, note) => total + note.tokenEstimate, 0);
  const allNoteCount = notes.length;
  const taskResults = [];

  for (const sample of defaultBenchmarkTasks) {
    const baseline = buildBaselineBenchmark(sample, allNoteTokens, allNoteCount);
    const variants = {};

    for (const variant of benchmarkVariants) {
      variants[variant.id] = await buildVariantBenchmark(rootDir, config, notes, sample, variant);
    }

    taskResults.push({
      id: sample.id,
      difficulty: sample.difficulty,
      task: sample.task,
      mode: variants.balanced.mode,
      reviewQueued: variants.balanced.reviewQueued,
      withSystem: variants.balanced,
      baseline,
      variants,
      savings: {
        tokensSaved: baseline.totalTokens - variants.balanced.totalTokens,
        reductionPercent: baseline.totalTokens > 0
          ? Number((((baseline.totalTokens - variants.balanced.totalTokens) / baseline.totalTokens) * 100).toFixed(2))
          : 0
      },
      profileSavings: buildProfileSavings(variants, baseline)
    });
  }

  const aggregate = aggregateBenchmarkResults(taskResults);
  const report = {
    generatedAt: new Date().toISOString(),
    variants: benchmarkVariants,
    tasks: taskResults,
    aggregate
  };
  const reportPath = path.join(rootDir, "state/benchmarks/last-benchmark.json");
  const historyPath = path.join(rootDir, "state/benchmarks/history.jsonl");
  const historyRetentionEntries = Number(config.tuning?.benchmarkHistoryRetentionEntries) || 50;
  const trendWindow = Number(config.tuning?.benchmarkTrendWindow) || 5;
  await writeJson(reportPath, report);
  await appendLine(historyPath, JSON.stringify({
    generatedAt: report.generatedAt,
    aggregate
  }));
  await trimBenchmarkHistory(historyPath, historyRetentionEntries);
  report.trend = await buildBenchmarkTrend(historyPath, trendWindow);
  await writeJson(reportPath, report);

  return {
    reportPath,
    report
  };
}

async function buildVariantBenchmark(rootDir, config, notes, sample, variant) {
  const variantConfig = applyReviewCostMode(config, variant);
  const taskProfile = classifyTask(sample.task);
  const memoryPolicy = await evaluateMemoryPolicy(rootDir, taskProfile, variantConfig);
  const context = assembleContext(sample.task, notes, {
    tokenBudget: variantConfig.retrieval?.defaultTokenBudget ?? 1200,
    maxNotes: variantConfig.retrieval?.maxNotesPerBundle ?? 6
  });
  const reviewQueued = Boolean(memoryPolicy.shouldQueueReview);
  const valueGatePayload = {
    job: {
      mode: memoryPolicy.mode,
      mergedTaskCount: 1,
      domains: memoryPolicy.domains,
      reasons: memoryPolicy.reasons,
      sourceEventIds: ["evt-synthetic-benchmark-1"]
    },
    contextBundle: context
  };
  const valueGate = reviewQueued
    ? assessReviewValueGate(
      valueGatePayload.job,
      valueGatePayload,
      variantConfig.reviewExecution?.valueGate ?? {}
    )
    : null;
  const reviewProfile = reviewQueued && !valueGate?.shouldSkip
    ? resolveBenchmarkReviewProfile(memoryPolicy.mode, variantConfig.reviewExecution)
    : null;
  const estimatedLiveReviewTokens = reviewQueued && !valueGate?.shouldSkip
    ? estimateLiveReviewTokens(context.usedTokens, reviewProfile, memoryPolicy.mode)
    : 0;

  return {
    costMode: variant.costMode,
    reviewProfile: variant.reviewProfile,
    mode: memoryPolicy.mode,
    reviewQueued,
    selectedNotes: context.selectedNotes.length,
    contextTokens: context.usedTokens,
    reviewPath: reviewQueued
      ? (valueGate?.shouldSkip ? "value-policy" : `live-${reviewProfile.promptStyle}`)
      : "not-queued",
    estimatedLiveReviewTokens,
    totalTokens: context.usedTokens + estimatedLiveReviewTokens,
    valueGateScore: valueGate?.score ?? null,
    valueGateSkipped: Boolean(valueGate?.shouldSkip),
    reasoningEffort: reviewProfile?.codexReasoningEffort ?? null,
    maxOperations: reviewProfile?.maxOperations ?? 0
  };
}

function buildBaselineBenchmark(sample, allNoteTokens, allNoteCount) {
  const taskProfile = classifyTask(sample.task);
  const reviewQueued = taskProfile.effort !== "low";
  const estimatedLiveReviewTokens = reviewQueued
    ? estimateLiveReviewTokens(allNoteTokens, {
      promptStyle: "strict",
      codexReasoningEffort: "high",
      maxOperations: 3
    }, taskProfile.risk === "high" ? "expensive" : "balanced")
    : 0;

  return {
    selectedNotes: allNoteCount,
    contextTokens: allNoteTokens,
    reviewQueued,
    reviewPath: reviewQueued ? "live-strict-full-context" : "not-queued",
    estimatedLiveReviewTokens,
    totalTokens: allNoteTokens + estimatedLiveReviewTokens
  };
}

function buildProfileSavings(variants, baseline) {
  return Object.fromEntries(
    Object.entries(variants).map(([key, variant]) => [
      key,
      {
        tokensSaved: baseline.totalTokens - variant.totalTokens,
        reductionPercent: baseline.totalTokens > 0
          ? Number((((baseline.totalTokens - variant.totalTokens) / baseline.totalTokens) * 100).toFixed(2))
          : 0
      }
    ])
  );
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
  const byVariant = {};

  for (const variant of benchmarkVariants) {
    const totalTokens = taskResults.reduce((total, item) => total + item.variants[variant.id].totalTokens, 0);
    byVariant[variant.id] = {
      totalTokens,
      tokensSaved: baselineTokens - totalTokens,
      reductionPercent: baselineTokens > 0
        ? Number((((baselineTokens - totalTokens) / baselineTokens) * 100).toFixed(2))
        : 0
    };
  }

  return {
    taskCount: taskResults.length,
    baselineTotalTokens: baselineTokens,
    systemTotalTokens: byVariant.balanced.totalTokens,
    tokensSaved: byVariant.balanced.tokensSaved,
    reductionPercent: byVariant.balanced.reductionPercent,
    averageReductionPercent: Number((
      taskResults.reduce((total, item) => total + item.savings.reductionPercent, 0) / taskResults.length
    ).toFixed(2)),
    byVariant,
    cheapestVariant: Object.entries(byVariant)
      .sort((left, right) => left[1].totalTokens - right[1].totalTokens)[0]?.[0] ?? "balanced"
  };
}

async function buildBenchmarkTrend(historyPath, trendWindow) {
  const entries = await readHistoryEntries(historyPath);
  const recent = entries.slice(-trendWindow);
  const latest = recent.at(-1) ?? null;
  const previous = recent.at(-2) ?? null;
  const cheapestVariantStreak = countCheapestVariantStreak(recent);

  return {
    historyEntries: entries.length,
    trendWindow,
    recentRuns: recent.map((entry) => ({
      generatedAt: entry.generatedAt,
      cheapestVariant: entry.aggregate?.cheapestVariant ?? null,
      reductionPercent: entry.aggregate?.reductionPercent ?? null
    })),
    cheapestVariantStreak,
    latestCheapestVariant: latest?.aggregate?.cheapestVariant ?? null,
    deltaByVariant: buildVariantDelta(previous?.aggregate?.byVariant, latest?.aggregate?.byVariant),
    recommendation: buildTrendRecommendation(cheapestVariantStreak, latest?.aggregate?.cheapestVariant ?? null)
  };
}

function resolveBenchmarkReviewProfile(mode, executionConfig = {}) {
  const profiles = executionConfig.reviewProfiles ?? {};
  return mode === "expensive"
    ? {
      promptStyle: profiles.expensive?.promptStyle ?? "strict",
      codexReasoningEffort: profiles.expensive?.codexReasoningEffort ?? "high",
      maxOperations: profiles.expensive?.maxOperations ?? 3
    }
    : {
      promptStyle: profiles.balanced?.promptStyle ?? "light",
      codexReasoningEffort: profiles.balanced?.codexReasoningEffort ?? "medium",
      maxOperations: profiles.balanced?.maxOperations ?? 2
    };
}

function estimateLiveReviewTokens(contextTokens, reviewProfile, mode) {
  const promptOverhead = reviewProfile.promptStyle === "strict" ? 340 : 180;
  const reasoningOverhead = reviewProfile.codexReasoningEffort === "high"
    ? 620
    : reviewProfile.codexReasoningEffort === "low"
      ? 140
      : 280;
  const modeOverhead = mode === "expensive" ? 180 : 60;
  const operationOverhead = Math.max(1, Number(reviewProfile.maxOperations) || 1) * 80;
  return contextTokens + promptOverhead + reasoningOverhead + modeOverhead + operationOverhead;
}

async function trimBenchmarkHistory(historyPath, maxEntries) {
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
    return;
  }
  const lines = await readTextLines(historyPath);
  const retained = lines.slice(-maxEntries);
  const payload = retained.length > 0 ? `${retained.join("\n")}\n` : "";
  await fs.writeFile(historyPath, payload, "utf8");
}

async function readHistoryEntries(historyPath) {
  const lines = await readTextLines(historyPath);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readTextLines(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function countCheapestVariantStreak(entries) {
  const latestVariant = entries.at(-1)?.aggregate?.cheapestVariant ?? null;
  if (!latestVariant) {
    return {
      variant: null,
      count: 0
    };
  }
  let count = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.aggregate?.cheapestVariant !== latestVariant) {
      break;
    }
    count += 1;
  }
  return {
    variant: latestVariant,
    count
  };
}

function buildVariantDelta(previousByVariant = {}, latestByVariant = {}) {
  const keys = new Set([
    ...Object.keys(previousByVariant ?? {}),
    ...Object.keys(latestByVariant ?? {})
  ]);
  return Object.fromEntries(
    [...keys].map((key) => [
      key,
      {
        totalTokensDelta: Number(latestByVariant?.[key]?.totalTokens ?? 0) - Number(previousByVariant?.[key]?.totalTokens ?? 0),
        reductionPercentDelta: Number(latestByVariant?.[key]?.reductionPercent ?? 0) - Number(previousByVariant?.[key]?.reductionPercent ?? 0)
      }
    ])
  );
}

function buildTrendRecommendation(streak, latestVariant) {
  if (streak.variant === "saver" && streak.count >= 3) {
    return "Saver has been the cheapest variant for multiple benchmark runs. Prefer it as the default balanced lane until live metrics disagree.";
  }
  if (latestVariant === "balanced") {
    return "Balanced is currently the cheapest benchmark variant, so the default lane already matches the synthetic trend.";
  }
  return "Collect more benchmark history before changing the default cost lane purely from synthetic runs.";
}
