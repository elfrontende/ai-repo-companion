import fs from "node:fs/promises";
import path from "node:path";
import { loadNotes, assembleContext } from "./context-engine.mjs";
import { classifyTask } from "./task-engine.mjs";
import { evaluateMemoryPolicy } from "./policy-engine.mjs";
import { appendLine, readJson, writeJson } from "./store.mjs";
import { applyReviewCostMode } from "./review-cost-mode-engine.mjs";
import { assessReviewValueGate } from "./review-value-gate-engine.mjs";

const benchmarkSuites = {
  mixed: [
    {
      id: "docs-small",
      task: "fix a typo and tighten wording in the deployment README",
      difficulty: "small",
      domain: "docs"
    },
    {
      id: "ui-medium",
      task: "add validation rules and error states for a login form component",
      difficulty: "medium",
      domain: "ui"
    },
    {
      id: "auth-hard",
      task: "design a security-focused migration plan for auth middleware and permission checks",
      difficulty: "hard",
      domain: "security"
    },
    {
      id: "testing-medium",
      task: "investigate a flaky regression test around API retries and timeouts",
      difficulty: "medium",
      domain: "testing"
    },
    {
      id: "deploy-hard",
      task: "prepare a migration-safe CI/CD rollout and deployment fallback checklist",
      difficulty: "hard",
      domain: "deploy"
    }
  ],
  "low-risk": [
    {
      id: "docs-small",
      task: "fix a typo and tighten wording in the deployment README",
      difficulty: "small",
      domain: "docs"
    },
    {
      id: "ui-medium",
      task: "add validation rules and error states for a login form component",
      difficulty: "medium",
      domain: "ui"
    },
    {
      id: "testing-medium",
      task: "investigate a flaky regression test around API retries and timeouts",
      difficulty: "medium",
      domain: "testing"
    },
    {
      id: "deploy-medium",
      task: "prepare a deployment handoff checklist and rollback notes for a routine release",
      difficulty: "medium",
      domain: "deploy"
    }
  ],
  "high-risk": [
    {
      id: "auth-hard",
      task: "design a security-focused migration plan for auth middleware and permission checks",
      difficulty: "hard",
      domain: "security"
    },
    {
      id: "migration-hard",
      task: "plan a migration-safe database rollout with fallback checkpoints and recovery notes",
      difficulty: "hard",
      domain: "migration"
    },
    {
      id: "architecture-hard",
      task: "review an event-bus architecture refactor for failure isolation and rollback safety",
      difficulty: "hard",
      domain: "architecture"
    }
  ]
};

const benchmarkVariants = [
  { id: "saver", costMode: "saver", reviewProfile: "light" },
  { id: "balanced", costMode: "balanced", reviewProfile: "auto" },
  { id: "strict", costMode: "strict", reviewProfile: "heavy" }
];

export async function runSyntheticBenchmark(rootDir, config, options = {}) {
  const suite = resolveBenchmarkSuite(options.suite);
  const suiteTasks = benchmarkSuites[suite];
  const notes = augmentWithNoiseNotes(await loadNotes(rootDir));
  const allNoteTokens = notes.reduce((total, note) => total + note.tokenEstimate, 0);
  const allNoteCount = notes.length;
  const taskResults = [];

  for (const sample of suiteTasks) {
    const baseline = buildBaselineBenchmark(sample, allNoteTokens, allNoteCount);
    const variants = {};

    for (const variant of benchmarkVariants) {
      variants[variant.id] = await buildVariantBenchmark(rootDir, config, notes, sample, variant);
    }

    taskResults.push({
      id: sample.id,
      domain: sample.domain,
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
    suite,
    variants: benchmarkVariants,
    tasks: taskResults,
    aggregate
  };
  const reportPath = getBenchmarkReportPath(rootDir, suite);
  const historyPath = getBenchmarkHistoryPath(rootDir, suite);
  const historyRetentionEntries = Number(config.tuning?.benchmarkHistoryRetentionEntries) || 50;
  const trendWindow = Number(config.tuning?.benchmarkTrendWindow) || 5;
  await writeJson(reportPath, report);
  await appendLine(historyPath, JSON.stringify({
    generatedAt: report.generatedAt,
    suite,
    aggregate
  }));
  await trimBenchmarkHistory(historyPath, historyRetentionEntries);
  report.trend = await buildBenchmarkTrend(historyPath, trendWindow);
  report.tuningComparison = suite === "mixed"
    ? buildTuningComparison(
      report,
      await readJson(path.join(rootDir, "state/tuning/last-tuning.json"), null),
      config.tuning?.canaryDomains ?? ["docs", "deploy", "ui", "testing"]
    )
    : {
      available: false,
      reason: "suite-specific-benchmark"
    };
  await writeJson(reportPath, report);
  if (suite === "mixed") {
    await writeJson(path.join(rootDir, "state/benchmarks/last-benchmark.json"), report);
  }

  return {
    reportPath,
    report
  };
}

export async function runSyntheticBenchmarkCycle(rootDir, options = {}) {
  const iterations = Math.max(1, Number(options.iterations) || 3);
  const autoTuneBetweenRuns = options.autoTuneBetweenRuns === true;
  const suite = resolveBenchmarkSuite(options.suite);
  const benchmarkRuns = [];
  const tuningRuns = [];

  for (let index = 0; index < iterations; index += 1) {
    const config = await readJson(path.join(rootDir, "config/system.json"), {});
    const benchmark = await runSyntheticBenchmark(rootDir, config, { suite });
    benchmarkRuns.push({
      iteration: index + 1,
      suite,
      generatedAt: benchmark.report.generatedAt,
      cheapestVariant: benchmark.report.aggregate.cheapestVariant,
      balancedReductionPercent: benchmark.report.aggregate.byVariant?.balanced?.reductionPercent ?? null,
      saverReductionPercent: benchmark.report.aggregate.byVariant?.saver?.reductionPercent ?? null,
      tuningComparison: benchmark.report.tuningComparison ?? null
    });

    if (!autoTuneBetweenRuns || index === iterations - 1) {
      continue;
    }

    const { runAutoPolicyTuning } = await import("./policy-tuning-engine.mjs");
    const tuning = await runAutoPolicyTuning(rootDir);
    tuningRuns.push({
      iteration: index + 1,
      generatedAt: new Date().toISOString(),
      appliedCount: Array.isArray(tuning.applied) ? tuning.applied.length : 0,
      blockedCount: Array.isArray(tuning.blocked) ? tuning.blocked.length : 0,
      reconciliation: tuning.reconciliation ?? null
    });
  }

  const config = await readJson(path.join(rootDir, "config/system.json"), {});
  const cycleReport = {
    generatedAt: new Date().toISOString(),
    iterations,
    suite,
    autoTuneBetweenRuns,
    benchmarks: benchmarkRuns,
    tuningRuns,
    summary: buildBenchmarkCycleSummary(benchmarkRuns, tuningRuns)
  };
  const cycleReportPath = getBenchmarkCycleReportPath(rootDir, suite);
  const cycleHistoryPath = getBenchmarkCycleHistoryPath(rootDir, suite);
  const cycleHistoryRetentionEntries = Number(config.tuning?.benchmarkCycleHistoryRetentionEntries)
    || Number(config.tuning?.benchmarkHistoryRetentionEntries)
    || 20;
  const cycleTrendWindow = Number(config.tuning?.benchmarkCycleTrendWindow)
    || Number(config.tuning?.benchmarkTrendWindow)
    || 5;
  await writeJson(cycleReportPath, cycleReport);
  await appendLine(cycleHistoryPath, JSON.stringify({
    generatedAt: cycleReport.generatedAt,
    suite,
    summary: cycleReport.summary
  }));
  await trimBenchmarkHistory(cycleHistoryPath, cycleHistoryRetentionEntries);
  cycleReport.multiCycle = await buildBenchmarkCycleComparison(
    cycleHistoryPath,
    cycleTrendWindow,
    Number(config.tuning?.benchmarkCycleComparisonWindow) || 2
  );
  await writeJson(cycleReportPath, cycleReport);
  if (suite === "mixed") {
    await writeJson(path.join(rootDir, "state/benchmarks/last-benchmark-cycle.json"), cycleReport);
  }

  return {
    reportPath: cycleReportPath,
    report: cycleReport,
    iterations,
    suite,
    autoTuneBetweenRuns,
    benchmarks: benchmarkRuns,
    tuningRuns,
    summary: cycleReport.summary,
    multiCycle: cycleReport.multiCycle
  };
}

function resolveBenchmarkSuite(requestedSuite) {
  return Object.prototype.hasOwnProperty.call(benchmarkSuites, requestedSuite ?? "")
    ? requestedSuite
    : "mixed";
}

function getBenchmarkReportPath(rootDir, suite) {
  return suite === "mixed"
    ? path.join(rootDir, "state/benchmarks/last-benchmark.json")
    : path.join(rootDir, `state/benchmarks/last-benchmark-${suite}.json`);
}

function getBenchmarkHistoryPath(rootDir, suite) {
  return suite === "mixed"
    ? path.join(rootDir, "state/benchmarks/history.jsonl")
    : path.join(rootDir, `state/benchmarks/history-${suite}.jsonl`);
}

function getBenchmarkCycleReportPath(rootDir, suite) {
  return suite === "mixed"
    ? path.join(rootDir, "state/benchmarks/last-benchmark-cycle.json")
    : path.join(rootDir, `state/benchmarks/last-benchmark-cycle-${suite}.json`);
}

function getBenchmarkCycleHistoryPath(rootDir, suite) {
  return suite === "mixed"
    ? path.join(rootDir, "state/benchmarks/history-cycle.jsonl")
    : path.join(rootDir, `state/benchmarks/history-cycle-${suite}.jsonl`);
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
    byDomain: aggregateBenchmarkByDomain(taskResults),
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
  const deltaByVariant = buildVariantDelta(previous?.aggregate?.byVariant, latest?.aggregate?.byVariant);
  const byDomain = buildDomainTrend(recent);

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
    deltaByVariant,
    byDomain,
    confidence: buildBenchmarkTrendConfidence({
      historyEntries: entries.length,
      trendWindow,
      cheapestVariantStreak,
      deltaByVariant,
      byDomain
    }),
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

function buildDomainTrend(entries) {
  const latestByDomain = entries.at(-1)?.aggregate?.byDomain ?? {};
  const previousByDomain = entries.at(-2)?.aggregate?.byDomain ?? {};
  const domains = new Set([
    ...Object.keys(latestByDomain),
    ...Object.keys(previousByDomain)
  ]);

  return Object.fromEntries(
    [...domains].map((domain) => {
      const recentEntries = entries.filter((entry) => entry?.aggregate?.byDomain?.[domain]);
      const latestVariant = recentEntries.at(-1)?.aggregate?.byDomain?.[domain]?.cheapestVariant ?? null;
      return [
        domain,
        {
          latestCheapestVariant: latestVariant,
          cheapestVariantStreak: countDomainCheapestVariantStreak(recentEntries, domain),
          recentCheapestVariants: recentEntries.map((entry) => entry?.aggregate?.byDomain?.[domain]?.cheapestVariant ?? null),
          changeCount: countDomainVariantChanges(recentEntries, domain),
          isNoisy: countDomainVariantChanges(recentEntries, domain) >= 2,
          deltaByVariant: buildVariantDelta(
            previousByDomain?.[domain]?.byVariant,
            latestByDomain?.[domain]?.byVariant
          )
        }
      ];
    })
  );
}

function countDomainCheapestVariantStreak(entries, domain) {
  const latestVariant = entries.at(-1)?.aggregate?.byDomain?.[domain]?.cheapestVariant ?? null;
  if (!latestVariant) {
    return {
      variant: null,
      count: 0
    };
  }
  let count = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.aggregate?.byDomain?.[domain]?.cheapestVariant !== latestVariant) {
      break;
    }
    count += 1;
  }
  return {
    variant: latestVariant,
    count
  };
}

function countDomainVariantChanges(entries, domain) {
  let changes = 0;
  let previousVariant = null;
  for (const entry of entries) {
    const currentVariant = entry?.aggregate?.byDomain?.[domain]?.cheapestVariant ?? null;
    if (!currentVariant) {
      continue;
    }
    if (previousVariant && previousVariant !== currentVariant) {
      changes += 1;
    }
    previousVariant = currentVariant;
  }
  return changes;
}

function aggregateBenchmarkByDomain(taskResults) {
  const grouped = new Map();
  for (const task of taskResults) {
    const domain = task.domain ?? "unknown";
    const bucket = grouped.get(domain) ?? [];
    bucket.push(task);
    grouped.set(domain, bucket);
  }

  return Object.fromEntries(
    [...grouped.entries()].map(([domain, tasks]) => {
      // Per-domain totals give the tuner a more honest canary signal.
      // Cheap domains can regress on their own, and a single global average
      // would let heavy security/auth workloads hide that drift.
      const baselineTotalTokens = tasks.reduce((total, item) => total + item.baseline.totalTokens, 0);
      const byVariant = Object.fromEntries(
        benchmarkVariants.map((variant) => {
          const totalTokens = tasks.reduce((total, item) => total + item.variants[variant.id].totalTokens, 0);
          return [
            variant.id,
            {
              totalTokens,
              tokensSaved: baselineTotalTokens - totalTokens,
              reductionPercent: baselineTotalTokens > 0
                ? Number((((baselineTotalTokens - totalTokens) / baselineTotalTokens) * 100).toFixed(2))
                : 0
            }
          ];
        })
      );

      return [
        domain,
        {
          taskCount: tasks.length,
          baselineTotalTokens,
          byVariant,
          cheapestVariant: Object.entries(byVariant)
            .sort((left, right) => left[1].totalTokens - right[1].totalTokens)[0]?.[0] ?? "balanced"
        }
      ];
    })
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

function buildBenchmarkCycleSummary(benchmarkRuns, tuningRuns) {
  const first = benchmarkRuns[0] ?? null;
  const last = benchmarkRuns.at(-1) ?? null;
  const balancedDelta = toFixedDelta(
    Number(last?.balancedReductionPercent),
    Number(first?.balancedReductionPercent)
  );
  const saverDelta = toFixedDelta(
    Number(last?.saverReductionPercent),
    Number(first?.saverReductionPercent)
  );

  let outcome = "flat";
  if (Number.isFinite(balancedDelta) && balancedDelta >= 1) {
    outcome = "improved";
  } else if (Number.isFinite(balancedDelta) && balancedDelta <= -1) {
    outcome = "degraded";
  }

  return {
    firstCheapestVariant: first?.cheapestVariant ?? null,
    lastCheapestVariant: last?.cheapestVariant ?? null,
    balancedReductionPercentDelta: balancedDelta,
    saverReductionPercentDelta: saverDelta,
    tuningRunCount: tuningRuns.length,
    acceptedCanaryCount: tuningRuns.filter((run) => run.reconciliation?.accepted === true).length,
    rollbackCount: tuningRuns.filter((run) => Array.isArray(run.reconciliation?.rolledBack) && run.reconciliation.rolledBack.length > 0).length,
    outcome,
    recommendation: buildBenchmarkCycleRecommendation(outcome, balancedDelta, tuningRuns.length)
  };
}

function buildBenchmarkCycleRecommendation(outcome, balancedDelta, tuningRunCount) {
  if (outcome === "improved") {
    return `The benchmark cycle improved by ${balancedDelta.toFixed(2)} balanced reduction points after ${tuningRunCount} tuning checkpoints.`;
  }
  if (outcome === "degraded") {
    return `The benchmark cycle regressed by ${Math.abs(balancedDelta).toFixed(2)} balanced reduction points. Reconcile or tighten the auto-tune lane before trusting more changes.`;
  }
  return "The benchmark cycle stayed effectively flat. Collect more iterations before changing policy based on cycle data alone.";
}

async function buildBenchmarkCycleComparison(historyPath, trendWindow, comparisonWindow) {
  const entries = await readHistoryEntries(historyPath);
  const recentEntries = entries.slice(-Math.max(2, trendWindow));
  const summaries = recentEntries
    .map((entry) => ({
      generatedAt: entry.generatedAt ?? null,
      ...entry.summary
    }))
    .filter((entry) => typeof entry.outcome === "string");

  if (summaries.length === 0) {
    return {
      available: false,
      reason: "no-cycle-history"
    };
  }

  const latest = summaries.at(-1);
  const previous = summaries.at(-2) ?? null;
  const outcomeCounts = summaries.reduce((counts, entry) => {
    counts[entry.outcome] = (counts[entry.outcome] ?? 0) + 1;
    return counts;
  }, {});
  const averageBalancedDelta = Number((
    summaries.reduce((total, entry) => total + (Number(entry.balancedReductionPercentDelta) || 0), 0)
    / summaries.length
  ).toFixed(2));
  const averageRollbackCount = Number((
    summaries.reduce((total, entry) => total + (Number(entry.rollbackCount) || 0), 0)
    / summaries.length
  ).toFixed(2));
  const latestOutcomeStreak = countCycleOutcomeStreak(summaries, latest.outcome);
  const latestVsPreviousBalancedDelta = previous
    ? toFixedDelta(
      Number(latest.balancedReductionPercentDelta),
      Number(previous.balancedReductionPercentDelta)
    )
    : null;
  const trendDirection = resolveCycleTrendDirection({
    averageBalancedDelta,
    latestOutcome: latest.outcome,
    improvedCount: outcomeCounts.improved ?? 0,
    degradedCount: outcomeCounts.degraded ?? 0
  });
  const windowComparison = buildCycleWindowComparison(entries, comparisonWindow);
  const confidence = buildBenchmarkCycleConfidence({
    recentCycleCount: summaries.length,
    latestOutcomeStreak,
    trendDirection,
    averageRollbackCount,
    windowComparison
  });

  return {
    available: true,
    recentCycleCount: summaries.length,
    latestGeneratedAt: latest.generatedAt ?? null,
    latestOutcome: latest.outcome,
    previousOutcome: previous?.outcome ?? null,
    latestOutcomeStreak,
    averageBalancedDelta,
    averageRollbackCount,
    latestVsPreviousBalancedDelta,
    outcomeCounts,
    trendDirection,
    windowComparison,
    confidence,
    recommendation: buildCycleTrendRecommendation({
      trendDirection,
      latestOutcome: latest.outcome,
      latestOutcomeStreak,
      averageBalancedDelta,
      latestVsPreviousBalancedDelta
    })
  };
}

function buildCycleWindowComparison(entries, comparisonWindow) {
  const windowSize = Math.max(1, Number(comparisonWindow) || 2);
  const requiredEntries = windowSize * 2;
  if (entries.length < requiredEntries) {
    return {
      available: false,
      reason: "insufficient-cycle-history",
      requiredEntries,
      currentEntries: entries.length
    };
  }

  const currentWindow = entries.slice(-windowSize);
  const previousWindow = entries.slice(-(windowSize * 2), -windowSize);
  const currentAverage = averageCycleOutcomeMetric(currentWindow);
  const previousAverage = averageCycleOutcomeMetric(previousWindow);
  const delta = toFixedDelta(currentAverage, previousAverage);
  const direction = Number.isFinite(delta) && delta >= 1
    ? "improving"
    : Number.isFinite(delta) && delta <= -1
      ? "degrading"
      : "flat";

  return {
    available: true,
    windowSize,
    currentWindowAverage: currentAverage,
    previousWindowAverage: previousAverage,
    delta,
    direction,
    recommendation: buildCycleWindowRecommendation(direction, delta, windowSize)
  };
}

function averageCycleOutcomeMetric(entries) {
  return Number((
    entries.reduce((total, entry) => total + (Number(entry?.summary?.balancedReductionPercentDelta) || 0), 0)
    / Math.max(1, entries.length)
  ).toFixed(2));
}

function buildCycleWindowRecommendation(direction, delta, windowSize) {
  if (direction === "improving") {
    return `The last ${windowSize} cycle runs are improving by ${delta.toFixed(2)} balanced points versus the previous window.`;
  }
  if (direction === "degrading") {
    return `The last ${windowSize} cycle runs are degrading by ${Math.abs(delta).toFixed(2)} balanced points versus the previous window.`;
  }
  return `The last ${windowSize} cycle runs are effectively flat versus the previous window.`;
}

function countCycleOutcomeStreak(summaries, outcome) {
  let count = 0;
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    if (summaries[index].outcome !== outcome) {
      break;
    }
    count += 1;
  }
  return count;
}

function resolveCycleTrendDirection({ averageBalancedDelta, latestOutcome, improvedCount, degradedCount }) {
  if (Number.isFinite(averageBalancedDelta) && averageBalancedDelta >= 1 && improvedCount >= degradedCount) {
    return "improving";
  }
  if (Number.isFinite(averageBalancedDelta) && averageBalancedDelta <= -1 && degradedCount >= improvedCount) {
    return "degrading";
  }
  if (latestOutcome === "improved") {
    return "improving";
  }
  if (latestOutcome === "degraded") {
    return "degrading";
  }
  return "mixed";
}

function buildCycleTrendRecommendation({
  trendDirection,
  latestOutcome,
  latestOutcomeStreak,
  averageBalancedDelta,
  latestVsPreviousBalancedDelta
}) {
  if (trendDirection === "improving") {
    return latestOutcomeStreak >= 2
      ? `Recent benchmark cycles are consistently improving, with an average balanced delta of ${averageBalancedDelta.toFixed(2)} points.`
      : `The latest benchmark cycle improved, and the recent average balanced delta is ${averageBalancedDelta.toFixed(2)} points.`;
  }
  if (trendDirection === "degrading") {
    return Number.isFinite(latestVsPreviousBalancedDelta)
      ? `Recent benchmark cycles are degrading, and the latest cycle moved ${Math.abs(latestVsPreviousBalancedDelta).toFixed(2)} points in the wrong direction versus the previous cycle.`
      : "Recent benchmark cycles are degrading. Reconcile recent tuning changes before trusting more automation.";
  }
  if (latestOutcome === "flat") {
    return "Recent benchmark cycles are mostly flat. Collect more cycles before widening the tuning blast radius.";
  }
  return "Recent benchmark cycles are mixed. Treat the signal as directional, not yet conclusive.";
}

function buildTuningComparison(report, lastTuning, monitoredDomains) {
  const baseline = lastTuning?.canary?.baselineBenchmark ?? null;
  const tuningGeneratedAt = lastTuning?.generatedAt ?? null;
  if (!baseline) {
    return {
      available: false,
      reason: "no-tuning-baseline"
    };
  }

  const currentGeneratedAt = report?.generatedAt ?? null;
  if (Date.parse(currentGeneratedAt ?? "") <= Date.parse(tuningGeneratedAt ?? "")) {
    return {
      available: false,
      reason: "waiting-for-post-tune-benchmark",
      tuningGeneratedAt,
      baselineBenchmarkGeneratedAt: baseline.generatedAt ?? null,
      currentBenchmarkGeneratedAt: currentGeneratedAt
    };
  }

  const currentBalancedReduction = Number(report?.aggregate?.byVariant?.balanced?.reductionPercent);
  const baselineBalancedReduction = Number(baseline?.balancedReductionPercent);
  const currentSaverReduction = Number(report?.aggregate?.byVariant?.saver?.reductionPercent);
  const baselineSaverReduction = Number(baseline?.saverReductionPercent);
  const balancedReductionPercentDelta = toFixedDelta(currentBalancedReduction, baselineBalancedReduction);
  const saverReductionPercentDelta = toFixedDelta(currentSaverReduction, baselineSaverReduction);
  const byDomain = buildTuningComparisonByDomain(
    report?.aggregate?.byDomain ?? {},
    baseline?.byDomain ?? {},
    monitoredDomains
  );
  const degradedDomains = Object.values(byDomain).filter((domain) => domain.outcome === "degraded");
  const improvedDomains = Object.values(byDomain).filter((domain) => domain.outcome === "improved");
  const cheapestVariantBaseline = baseline?.cheapestVariant ?? null;
  const cheapestVariantCurrent = report?.aggregate?.cheapestVariant ?? null;

  let outcome = "flat";
  if ((Number.isFinite(balancedReductionPercentDelta) && balancedReductionPercentDelta <= -1) || degradedDomains.length > 0) {
    outcome = "degraded";
  } else if ((Number.isFinite(balancedReductionPercentDelta) && balancedReductionPercentDelta >= 1) || improvedDomains.length > 0) {
    outcome = "improved";
  }

  return {
    available: true,
    tuningGeneratedAt,
    baselineBenchmarkGeneratedAt: baseline.generatedAt ?? null,
    currentBenchmarkGeneratedAt: currentGeneratedAt,
    outcome,
    cheapestVariant: {
      baseline: cheapestVariantBaseline,
      current: cheapestVariantCurrent,
      changed: cheapestVariantBaseline !== cheapestVariantCurrent
    },
    balancedReductionPercentDelta,
    saverReductionPercentDelta,
    byDomain,
    confidence: buildTuningComparisonConfidence({
      balancedReductionPercentDelta,
      saverReductionPercentDelta,
      monitoredDomainCount: monitoredDomains.length,
      improvedDomainCount: improvedDomains.length,
      degradedDomainCount: degradedDomains.length
    }),
    summary: buildTuningComparisonSummary(outcome, balancedReductionPercentDelta, degradedDomains, improvedDomains)
  };
}

function buildTuningComparisonByDomain(currentByDomain, baselineByDomain, monitoredDomains) {
  return Object.fromEntries(
    monitoredDomains
      .filter((domain) => currentByDomain?.[domain] && baselineByDomain?.[domain])
      .map((domain) => {
        const currentBalancedReduction = Number(currentByDomain?.[domain]?.byVariant?.balanced?.reductionPercent);
        const baselineBalancedReduction = Number(baselineByDomain?.[domain]?.balancedReductionPercent);
        const delta = toFixedDelta(currentBalancedReduction, baselineBalancedReduction);
        let outcome = "flat";
        if (Number.isFinite(delta) && delta <= -1) {
          outcome = "degraded";
        } else if (Number.isFinite(delta) && delta >= 1) {
          outcome = "improved";
        }
        return [
          domain,
          {
            domain,
            baselineCheapestVariant: baselineByDomain?.[domain]?.cheapestVariant ?? null,
            currentCheapestVariant: currentByDomain?.[domain]?.cheapestVariant ?? null,
            balancedReductionPercentDelta: delta,
            outcome
          }
        ];
      })
  );
}

function buildTuningComparisonSummary(outcome, balancedDelta, degradedDomains, improvedDomains) {
  if (outcome === "degraded") {
    const domainLabel = degradedDomains[0]?.domain ?? null;
    if (domainLabel) {
      return `Post-tune benchmark regressed in ${domainLabel}; review the last auto-tune or run reconcile.`;
    }
    return `Post-tune benchmark regressed by ${Math.abs(balancedDelta).toFixed(2)} balanced reduction points.`;
  }
  if (outcome === "improved") {
    const domainLabel = improvedDomains[0]?.domain ?? null;
    if (domainLabel) {
      return `Post-tune benchmark improved, led by ${domainLabel}.`;
    }
    return `Post-tune benchmark improved by ${balancedDelta.toFixed(2)} balanced reduction points.`;
  }
  return "Post-tune benchmark is effectively flat so the latest tuning looks neutral.";
}

function buildBenchmarkTrendConfidence({
  historyEntries,
  trendWindow,
  cheapestVariantStreak,
  deltaByVariant,
  byDomain
}) {
  let score = 0;
  const reasons = [];
  const noisyDomains = Object.values(byDomain ?? {}).filter((item) => item.isNoisy).length;
  const totalDomains = Math.max(1, Object.keys(byDomain ?? {}).length);
  const balancedDeltaMagnitude = Math.abs(Number(deltaByVariant?.balanced?.reductionPercentDelta) || 0);

  if (historyEntries >= trendWindow) {
    score += 35;
    reasons.push("trend window is fully populated");
  } else {
    score += Math.min(25, historyEntries * 8);
    reasons.push("trend window is only partially populated");
  }

  if ((cheapestVariantStreak?.count ?? 0) >= 3) {
    score += 25;
    reasons.push("cheapest variant stayed stable for at least three runs");
  } else if ((cheapestVariantStreak?.count ?? 0) >= 2) {
    score += 15;
    reasons.push("cheapest variant has a short but usable streak");
  } else {
    reasons.push("cheapest variant still flips too often");
  }

  if (balancedDeltaMagnitude >= 2) {
    score += 20;
    reasons.push("balanced reduction delta is large enough to be directional");
  } else if (balancedDeltaMagnitude >= 1) {
    score += 10;
    reasons.push("balanced reduction delta is modest but visible");
  } else {
    reasons.push("balanced reduction delta is still weak");
  }

  if (noisyDomains === 0) {
    score += 20;
    reasons.push("cheap-domain trend signals are stable");
  } else if ((noisyDomains / totalDomains) <= 0.25) {
    score += 10;
    reasons.push("only a small fraction of cheap-domain signals are noisy");
  } else {
    reasons.push("too many cheap-domain signals are noisy");
  }

  return finalizeConfidence(score, reasons);
}

function buildBenchmarkCycleConfidence({
  recentCycleCount,
  latestOutcomeStreak,
  trendDirection,
  averageRollbackCount,
  windowComparison
}) {
  let score = 0;
  const reasons = [];

  if (recentCycleCount >= 4) {
    score += 30;
    reasons.push("multiple benchmark cycles are available");
  } else if (recentCycleCount >= 2) {
    score += 15;
    reasons.push("only a short cycle history is available");
  } else {
    reasons.push("cycle history is still too short");
  }

  if (windowComparison?.available) {
    score += 25;
    reasons.push("window-to-window comparison is available");
  } else {
    reasons.push("window-to-window comparison is not available yet");
  }

  if (trendDirection === "improving" || trendDirection === "degrading") {
    score += 20;
    reasons.push("cycle direction is clear instead of mixed");
  } else {
    reasons.push("cycle direction is still mixed");
  }

  if ((latestOutcomeStreak ?? 0) >= 2) {
    score += 15;
    reasons.push("recent cycle outcomes are repeating consistently");
  } else {
    reasons.push("recent cycle outcomes have not formed a stable streak");
  }

  if ((averageRollbackCount ?? 0) <= 0.5) {
    score += 10;
    reasons.push("rollback pressure is low");
  } else {
    reasons.push("rollback pressure is elevated");
  }

  return finalizeConfidence(score, reasons);
}

function buildTuningComparisonConfidence({
  balancedReductionPercentDelta,
  saverReductionPercentDelta,
  monitoredDomainCount,
  improvedDomainCount,
  degradedDomainCount
}) {
  let score = 0;
  const reasons = [];
  const dominantDelta = Math.max(
    Math.abs(Number(balancedReductionPercentDelta) || 0),
    Math.abs(Number(saverReductionPercentDelta) || 0)
  );

  if (monitoredDomainCount >= 4) {
    score += 30;
    reasons.push("all monitored cheap domains are covered");
  } else if (monitoredDomainCount >= 2) {
    score += 15;
    reasons.push("only part of the cheap-domain set is covered");
  } else {
    reasons.push("too few monitored domains are available");
  }

  if (dominantDelta >= 3) {
    score += 25;
    reasons.push("post-tune token delta is large enough to be convincing");
  } else if (dominantDelta >= 1) {
    score += 10;
    reasons.push("post-tune token delta is visible but still modest");
  } else {
    reasons.push("post-tune token delta is still weak");
  }

  if (improvedDomainCount > 0 && degradedDomainCount === 0) {
    score += 25;
    reasons.push("monitored domains improve without visible regressions");
  } else if (degradedDomainCount === 0) {
    score += 10;
    reasons.push("no monitored domains regress after tuning");
  } else {
    reasons.push("one or more monitored domains regress after tuning");
  }

  if (degradedDomainCount === 0) {
    score += 20;
    reasons.push("rollback evidence does not point to harm");
  } else {
    reasons.push("rollback evidence suggests tuning harm is possible");
  }

  return finalizeConfidence(score, reasons);
}

function finalizeConfidence(score, reasons) {
  const normalizedScore = Math.max(0, Math.min(100, Math.round(score)));
  const level = normalizedScore >= 75
    ? "high"
    : normalizedScore >= 45
      ? "medium"
      : "low";

  return {
    score: normalizedScore,
    level,
    reasons
  };
}

function toFixedDelta(currentValue, baselineValue) {
  if (!Number.isFinite(currentValue) || !Number.isFinite(baselineValue)) {
    return null;
  }
  return Number((currentValue - baselineValue).toFixed(2));
}
