import fs from "node:fs/promises";
import path from "node:path";
import { getReviewMetrics } from "./review-metrics-engine.mjs";
import { appendLine, readJson, writeJson } from "./store.mjs";

// The tuner is intentionally conservative.
// It only suggests a handful of bounded changes so the repo owner can nudge
// the system with data instead of rewriting policy by gut feel.

export async function analyzePolicyTuning(rootDir, options = {}) {
  // Analysis is read-only. It turns raw runtime evidence into bounded tuning
  // suggestions without mutating config.
  const configPath = path.join(rootDir, "config/system.json");
  const benchmarkPath = path.join(rootDir, "state/benchmarks/last-benchmark.json");
  const config = await readJson(configPath, {});
  const metrics = await getReviewMetrics(rootDir);
  const benchmark = await readJson(benchmarkPath, null);
  const allSuggestions = buildPolicySuggestions(config, metrics, benchmark);
  const fullTuningPlan = buildTuningPlan(allSuggestions);
  const selectedPhase = options.phase ?? null;
  const suggestions = filterSuggestionsByPhase(allSuggestions, fullTuningPlan, selectedPhase);
  const tuningPlan = selectedPhase
    ? buildTuningPlan(suggestions)
    : fullTuningPlan;

  return {
    configPath,
    benchmarkPath,
    metrics,
    benchmark,
    selectedPhase,
    suggestions: suggestions.map((suggestion) => ({
      ...suggestion,
      riskLevel: inferSuggestionRisk(suggestion),
      expectedImpactSummary: summarizeSuggestionImpact(suggestion)
    })),
    tuningPlan,
    workflow: buildTuningWorkflow(tuningPlan, selectedPhase),
    summary: {
      benchmarkLoaded: Boolean(benchmark?.aggregate),
      selectedPhase,
      suggestionCount: suggestions.length,
      applyableCount: suggestions.filter((item) => item.canApply).length,
      autoApplicableCount: suggestions.filter((item) => item.canAutoApply).length,
      tuningPlanSteps: tuningPlan.steps.length
    }
  };
}

export async function applyPolicyTuning(rootDir, options = {}) {
  // Manual apply is intentionally boring: apply only suggestions already
  // produced by analysis, and only along allowlisted config paths.
  const analysis = await analyzePolicyTuning(rootDir, options);
  const config = await readJson(analysis.configPath, {});
  const applied = [];

  for (const suggestion of analysis.suggestions) {
    if (!suggestion.canApply) {
      continue;
    }
    applyConfigPatch(config, suggestion.path, suggestion.proposedValue);
    applied.push({
      id: suggestion.id,
      path: suggestion.path,
      previousValue: suggestion.currentValue,
      proposedValue: suggestion.proposedValue
    });
  }

  if (applied.length > 0) {
    await writeJson(analysis.configPath, config);
  }

  return {
    ...analysis,
    applied
  };
}

export async function runAutoPolicyTuning(rootDir, options = {}) {
  // Auto-tune is still bounded and conservative.
  // It only applies a small number of pre-approved suggestions per run,
  // records a canary, and expects a later reconcile step to judge the result.
  const reconciliation = await reconcileAutoPolicyTuning(rootDir, { silentNoop: true });
  const analysis = await analyzePolicyTuning(rootDir, { phase: options.phase ?? null });
  const config = await readJson(analysis.configPath, {});
  const tuningConfig = config.tuning ?? {};
  const statePath = path.join(rootDir, "state/tuning/auto-tune-state.json");
  const lastTuningPath = path.join(rootDir, "state/tuning/last-tuning.json");
  const historyPath = path.join(rootDir, "state/tuning/history.jsonl");
  const previousLastTuning = await readJson(lastTuningPath, null);
  const state = await readJson(statePath, {
    schemaVersion: 1,
    lastAppliedById: {}
  });

  const now = new Date().toISOString();
  const enabled = tuningConfig.autoApplyEnabled !== false;
  if (!enabled) {
    return {
      ...analysis,
      mode: "auto",
      enabled: false,
      skippedReason: "auto-apply-disabled",
      applied: [],
      blocked: [],
      reconciliation
    };
  }

  const cooldownMinutes = Number(tuningConfig.cooldownMinutes) || 720;
  const maxAutoApplySuggestionsPerRun = Number(tuningConfig.maxAutoApplySuggestionsPerRun) || 4;
  const autoIds = new Set(tuningConfig.autoApplySuggestionIds ?? []);
  const candidates = analysis.suggestions.map((suggestion) => ({
    ...suggestion,
    canAutoApply: suggestion.canApply && autoIds.has(suggestion.id)
  })).sort(compareAutoTuneSuggestions);
  const blocked = [];
  const applied = [];
  let autoApplySlotsRemaining = maxAutoApplySuggestionsPerRun;

  for (const suggestion of candidates) {
    if (!suggestion.canAutoApply) {
      continue;
    }

    if (autoApplySlotsRemaining <= 0) {
      blocked.push({
        id: suggestion.id,
        reason: "auto-apply-budget-exhausted",
        priority: suggestion.priority ?? 0
      });
      continue;
    }

    const lastAppliedAt = state.lastAppliedById?.[suggestion.id] ?? null;
    const coolingDown = isWithinCooldown(lastAppliedAt, now, cooldownMinutes);
    if (coolingDown) {
      blocked.push({
        id: suggestion.id,
        reason: "cooldown-active",
        lastAppliedAt
      });
      continue;
    }

    applyConfigPatch(config, suggestion.path, suggestion.proposedValue);
    applied.push({
      id: suggestion.id,
      path: suggestion.path,
      previousValue: suggestion.currentValue,
      proposedValue: suggestion.proposedValue,
      priority: suggestion.priority ?? 0,
      phase: findSuggestionPhase(analysis.tuningPlan, suggestion.id)
    });
    state.lastAppliedById ??= {};
    state.lastAppliedById[suggestion.id] = now;
    autoApplySlotsRemaining -= 1;
  }

  if (applied.length > 0) {
    await writeJson(analysis.configPath, config);
  }

  const result = {
    ...analysis,
    mode: "auto",
    enabled: true,
    selectedPhase: analysis.selectedPhase,
    cooldownMinutes,
    maxAutoApplySuggestionsPerRun,
    applied,
    blocked,
    reconciliation
  };

  await writeJson(statePath, state);
  const nextCanary = applied.length > 0
    ? {
      status: "pending",
      baselineBenchmark: summarizeBenchmarkForCanary(analysis.benchmark),
      rollbackPlan: applied,
      reconciledAt: null,
      reconciliation: null
    }
    : preserveExistingCanary(previousLastTuning?.canary);

  await writeJson(lastTuningPath, {
    generatedAt: now,
    mode: "auto",
    selectedPhase: analysis.selectedPhase,
    summary: {
      selectedPhase: analysis.selectedPhase,
      suggestionCount: analysis.summary.suggestionCount,
      applyableCount: analysis.summary.applyableCount,
      autoApplicableCount: candidates.filter((item) => item.canAutoApply).length,
      maxAutoApplySuggestionsPerRun
    },
    canary: nextCanary,
    applied,
    blocked
  });
  await appendLine(historyPath, JSON.stringify({
    generatedAt: now,
    mode: "auto",
    applied,
    blocked
  }));
  await trimHistoryFile(historyPath, Number(tuningConfig.historyRetentionEntries) || 100);

  return result;
}

export async function reconcileAutoPolicyTuning(rootDir, options = {}) {
  // Reconcile is the "did our last auto-tune actually help?" step.
  // It looks at a newer benchmark than the one the canary was created from
  // and decides whether to accept or roll back the previous auto-change set.
  const configPath = path.join(rootDir, "config/system.json");
  const lastTuningPath = path.join(rootDir, "state/tuning/last-tuning.json");
  const historyPath = path.join(rootDir, "state/tuning/history.jsonl");
  const statePath = path.join(rootDir, "state/tuning/auto-tune-state.json");
  const config = await readJson(configPath, {});
  const tuningConfig = config.tuning ?? {};
  const lastTuning = await readJson(lastTuningPath, null);
  const benchmark = await readJson(path.join(rootDir, "state/benchmarks/last-benchmark.json"), null);
  const state = await readJson(statePath, {
    schemaVersion: 1,
    lastAppliedById: {}
  });
  const now = new Date().toISOString();
  const selectedPhase = options.phase ?? null;

  if (tuningConfig.autoRollbackEnabled === false) {
    return {
      mode: "reconcile",
      enabled: false,
      skippedReason: "auto-rollback-disabled",
      rolledBack: [],
      accepted: false
    };
  }

  const canary = lastTuning?.canary ?? null;
  if (!lastTuning || lastTuning.mode !== "auto" || !canary || canary.status !== "pending") {
    return {
      mode: "reconcile",
      enabled: true,
      skippedReason: options.silentNoop ? "no-pending-canary" : "no-pending-canary",
      rolledBack: [],
      accepted: false
    };
  }

  const benchmarkGeneratedAt = benchmark?.generatedAt ?? null;
  if (!benchmarkGeneratedAt || Date.parse(benchmarkGeneratedAt) <= Date.parse(lastTuning.generatedAt ?? "")) {
    return {
      mode: "reconcile",
      enabled: true,
      skippedReason: "waiting-for-new-benchmark",
      rolledBack: [],
      accepted: false
    };
  }

  const evaluation = evaluateCanaryRegression(
    canary.baselineBenchmark,
    summarizeBenchmarkForCanary(benchmark),
    tuningConfig
  );

  if (!evaluation.shouldRollback) {
    lastTuning.canary = {
      ...canary,
      status: "accepted",
      reconciledAt: now,
      reconciliation: {
        benchmarkGeneratedAt,
        reasons: evaluation.reasons
      }
    };
    await writeJson(lastTuningPath, lastTuning);
    await appendLine(historyPath, JSON.stringify({
      generatedAt: now,
      mode: "auto-reconcile",
      accepted: true,
      reasons: evaluation.reasons
    }));
    await trimHistoryFile(historyPath, Number(tuningConfig.historyRetentionEntries) || 100);
    return {
      mode: "reconcile",
      enabled: true,
      accepted: true,
      rolledBack: [],
      reasons: evaluation.reasons
    };
  }

  const fullRollbackPlan = Array.isArray(canary.rollbackPlan) ? [...canary.rollbackPlan] : [];
  const rollbackPlan = fullRollbackPlan
    .filter((change) => !selectedPhase || change.phase === selectedPhase)
    .reverse();
  const remainingRollbackPlan = fullRollbackPlan.filter((change) => selectedPhase && change.phase !== selectedPhase);
  const rolledBack = [];
  for (const change of rollbackPlan) {
    applyConfigPatch(config, change.path, change.previousValue);
    rolledBack.push({
      id: change.id,
      path: change.path,
      restoredValue: change.previousValue
    });
    if (state.lastAppliedById) {
      delete state.lastAppliedById[change.id];
    }
  }

  await writeJson(configPath, config);
  await writeJson(statePath, state);
  lastTuning.canary = {
    ...canary,
    status: remainingRollbackPlan.length > 0 ? "pending" : "rolled-back",
    rollbackPlan: remainingRollbackPlan,
    reconciledAt: now,
    reconciliation: {
      benchmarkGeneratedAt,
      reasons: evaluation.reasons,
      selectedPhase,
      remainingRollbackCount: remainingRollbackPlan.length
    }
  };
  await writeJson(lastTuningPath, lastTuning);
  await appendLine(historyPath, JSON.stringify({
    generatedAt: now,
    mode: "auto-rollback",
    rolledBack,
    reasons: evaluation.reasons
  }));
  await trimHistoryFile(historyPath, Number(tuningConfig.historyRetentionEntries) || 100);

  return {
    mode: "reconcile",
    enabled: true,
    selectedPhase,
    accepted: false,
    rolledBack,
    remainingRollbackCount: remainingRollbackPlan.length,
    reasons: evaluation.reasons
  };
}

function buildPolicySuggestions(config, metrics, benchmark) {
  const suggestions = [];
  const counters = metrics.counters ?? {};
  const queueLatencyAvg = averageLatency(metrics.latencies?.queueMinutes);
  const approvalLatencyAvg = averageLatency(metrics.latencies?.approvalMinutes);
  const appliedOps = counters.appliedOperations ?? 0;
  const rejectedOps = counters.rejectedOperations ?? 0;
  const deferredOps = counters.deferredOperations ?? 0;
  const avgTokensPerSelectedOperation = (counters.selectedOperations ?? 0) > 0
    ? (metrics.cost?.liveTokensUsed ?? 0) / counters.selectedOperations
    : 0;

  maybePushSuggestion(suggestions, {
    id: "raise-domain-threshold",
    condition: queueLatencyAvg >= 45 && (counters.processedJobs ?? 0) >= 5,
    reason: "Average queue latency is high, so review jobs are probably piling up faster than they are consumed.",
    path: ["memoryPolicy", "sameDomainEventThreshold"],
    currentValue: config.memoryPolicy?.sameDomainEventThreshold ?? 3,
    proposedValue: Math.min(8, (config.memoryPolicy?.sameDomainEventThreshold ?? 3) + 1),
    canAutoApply: true,
    priority: 40
  });

  maybePushSuggestion(suggestions, {
    id: "tighten-ranking-floor",
    condition: rejectedOps >= Math.max(3, appliedOps + 2),
    reason: "Rejected operations are outnumbering applied operations, so the review gate can start stricter.",
    path: ["reviewExecution", "operationRanking", "minScore"],
    currentValue: config.reviewExecution?.operationRanking?.minScore ?? 35,
    proposedValue: Math.min(80, (config.reviewExecution?.operationRanking?.minScore ?? 35) + 5),
    canAutoApply: true,
    priority: 35
  });

  maybePushSuggestion(suggestions, {
    id: "raise-apply-budget",
    condition: deferredOps >= 3 && appliedOps >= 2,
    reason: "Valid operations are being deferred often enough that the apply budget may be too tight.",
    path: ["reviewExecution", "operationRanking", "maxAppliedOperations"],
    currentValue: config.reviewExecution?.operationRanking?.maxAppliedOperations ?? 2,
    proposedValue: Math.min(5, (config.reviewExecution?.operationRanking?.maxAppliedOperations ?? 2) + 1),
    canAutoApply: false,
    priority: 15
  });

  maybePushSuggestion(suggestions, {
    id: "extend-approval-ttl",
    condition: (counters.approvalsExpiredRequeued ?? 0) + (counters.approvalsExpiredClosed ?? 0) > 0,
    reason: "Pending approvals are expiring, so the manual checkpoint is probably too short for real usage.",
    path: ["reviewExecution", "approval", "pendingApprovalTtlMinutes"],
    currentValue: config.reviewExecution?.approval?.pendingApprovalTtlMinutes ?? 240,
    proposedValue: Math.min(1440, (config.reviewExecution?.approval?.pendingApprovalTtlMinutes ?? 240) + 60),
    canAutoApply: false,
    priority: 10
  });

  maybePushSuggestion(suggestions, {
    id: "widen-expiry-action",
    condition: approvalLatencyAvg >= 120 && (counters.approvalsExpiredClosed ?? 0) > 0,
    reason: "Approval latency is high and approvals are expiring closed, so requeue is safer than silent closure.",
    path: ["reviewExecution", "approval", "onExpired"],
    currentValue: config.reviewExecution?.approval?.onExpired ?? "requeue",
    proposedValue: "requeue",
    canAutoApply: false,
    priority: 10
  });

  maybePushSuggestion(suggestions, {
    id: "tighten-value-gate",
    condition: (counters.processedJobs ?? 0) >= 3 && avgTokensPerSelectedOperation >= 30000,
    reason: "Live review is expensive relative to the amount of useful note work getting through, so more weak balanced jobs should be skipped before model execution.",
    path: ["reviewExecution", "valueGate", "minScore"],
    currentValue: config.reviewExecution?.valueGate?.minScore ?? 60,
    proposedValue: Math.min(90, (config.reviewExecution?.valueGate?.minScore ?? 60) + 5),
    canAutoApply: true,
    priority: 60
  });

  maybePushSuggestion(suggestions, {
    id: "relax-value-gate",
    condition: (counters.skippedJobs ?? 0) >= 3 && avgTokensPerSelectedOperation > 0 && avgTokensPerSelectedOperation <= 8000,
    reason: "Many jobs are being skipped while live review is already cheap enough, so the value gate can be relaxed slightly.",
    path: ["reviewExecution", "valueGate", "minScore"],
    currentValue: config.reviewExecution?.valueGate?.minScore ?? 60,
    proposedValue: Math.max(30, (config.reviewExecution?.valueGate?.minScore ?? 60) - 5),
    canAutoApply: true,
    priority: 45
  });

  // Runtime metrics tell us whether the current policy wastes live calls.
  // Benchmark variants tell us whether the cheaper review lane consistently
  // wins on the same synthetic workload. We use both signals so the tuner
  // does not overreact to one noisy day of real runs.
  const balancedVariant = benchmark?.aggregate?.byVariant?.balanced;
  const saverVariant = benchmark?.aggregate?.byVariant?.saver;
  const balancedVsSaverTokenDelta = Number(balancedVariant?.totalTokens ?? 0) - Number(saverVariant?.totalTokens ?? 0);
  const domainSignal = buildDomainLeanSignal(
    benchmark?.aggregate?.byDomain ?? {},
    config.tuning?.canaryDomains ?? ["docs", "deploy", "ui", "testing"],
    metrics?.tokensByDomain ?? {},
    benchmark?.trend?.byDomain ?? {}
  );

  maybePushSuggestion(suggestions, {
    id: "benchmark-lower-balanced-effort",
    condition: (
      benchmark?.aggregate?.cheapestVariant === "saver"
      && Number(saverVariant?.totalTokens) > 0
      && Number(balancedVariant?.totalTokens) > Number(saverVariant?.totalTokens) * 1.08
    ) || domainSignal.shouldLeanBalancedLane,
    reason: domainSignal.shouldLeanBalancedLane
      ? `Low-risk domains (${domainSignal.matchedDomains.join(", ")}) keep favoring saver, so the default balanced Codex reasoning effort can be lowered without using high-risk benchmark data as the main signal.`
      : "Synthetic benchmark says the saver profile is clearly cheaper than balanced, so the default balanced Codex reasoning effort can be lowered.",
    path: ["reviewExecution", "reviewProfiles", "balanced", "codexReasoningEffort"],
    currentValue: config.reviewExecution?.reviewProfiles?.balanced?.codexReasoningEffort ?? "medium",
    proposedValue: "low",
    canAutoApply: true,
    priority: domainSignal.shouldLeanBalancedLane ? 75 : 50,
    expectedImpact: {
      type: "balanced-lane",
      estimatedTokenDelta: Math.max(0, balancedVsSaverTokenDelta),
      affectedDomains: domainSignal.matchedDomains,
      reductionGap: Math.max(0, Number(
        ((Number(saverVariant?.reductionPercent) || 0) - (Number(balancedVariant?.reductionPercent) || 0)).toFixed(2)
      ))
    }
  });

  maybePushSuggestion(suggestions, {
    id: "benchmark-lean-balanced-operations",
    condition: (
      benchmark?.aggregate?.cheapestVariant === "saver"
      && Number(saverVariant?.totalTokens) > 0
      && Number(balancedVariant?.totalTokens) > Number(saverVariant?.totalTokens) * 1.12
    ) || domainSignal.shouldLeanBalancedLane,
    reason: domainSignal.shouldLeanBalancedLane
      ? `Low-risk domains (${domainSignal.matchedDomains.join(", ")}) still show a meaningfully cheaper saver lane, so balanced should keep a leaner operation budget.`
      : "Synthetic benchmark shows balanced is still materially heavier than saver, so its operation budget should shrink toward the cheaper lane.",
    path: ["reviewExecution", "reviewProfiles", "balanced", "maxOperations"],
    currentValue: config.reviewExecution?.reviewProfiles?.balanced?.maxOperations ?? 2,
    proposedValue: 1,
    canAutoApply: true,
    priority: domainSignal.shouldLeanBalancedLane ? 78 : 52,
    expectedImpact: {
      type: "balanced-lane",
      estimatedTokenDelta: Math.max(0, balancedVsSaverTokenDelta),
      affectedDomains: domainSignal.matchedDomains,
      reductionGap: Math.max(0, Number(
        ((Number(saverVariant?.reductionPercent) || 0) - (Number(balancedVariant?.reductionPercent) || 0)).toFixed(2)
      ))
    }
  });

  for (const domain of domainSignal.matchedDomains) {
    // This is intentionally domain-scoped.
    // We tighten the cheap balanced lane for docs/deploy/ui/testing without
    // making auth/security jobs pay for that stricter threshold.
    const currentStoredValue = config.reviewExecution?.valueGate?.minScoreByDomain?.[domain];
    const effectiveThreshold = Number(currentStoredValue)
      || (config.reviewExecution?.valueGate?.minScore ?? 60);
    maybePushSuggestion(suggestions, {
      id: `domain-tighten-value-gate-${domain}`,
      condition: true,
      reason: `${domain} benchmark samples keep favoring saver over balanced, so this low-risk domain should clear a stricter local value gate before it spends live tokens.`,
      path: ["reviewExecution", "valueGate", "minScoreByDomain", domain],
      currentValue: currentStoredValue,
      proposedValue: Math.min(90, effectiveThreshold + 5),
      canAutoApply: true,
      priority: domainSignal.domainPriorities[domain] ?? 50,
      expectedImpact: {
        type: "domain-value-gate",
        domain,
        liveTokensUsed: Number(metrics?.tokensByDomain?.[domain]) || 0,
        reductionGap: Number((Number(benchmark?.aggregate?.byDomain?.[domain]?.byVariant?.saver?.reductionPercent ?? 0)
          - Number(benchmark?.aggregate?.byDomain?.[domain]?.byVariant?.balanced?.reductionPercent ?? 0)).toFixed(2)),
        thresholdDelta: Math.max(0, Math.min(90, effectiveThreshold + 5) - effectiveThreshold)
      }
    });
  }

  return suggestions;
}

function buildDomainLeanSignal(byDomain, monitoredDomains, tokensByDomain, trendByDomain) {
  const matchedDomains = [];
  const domainPriorities = {};

  for (const domain of monitoredDomains) {
    const summary = byDomain?.[domain];
    if (!summary) {
      continue;
    }
    const saverReduction = Number(summary?.byVariant?.saver?.reductionPercent);
    const balancedReduction = Number(summary?.byVariant?.balanced?.reductionPercent);
    const reductionGap = saverReduction - balancedReduction;
    const saverTrendStreak = Number(trendByDomain?.[domain]?.cheapestVariantStreak?.count) || 0;
    const saverTrendConfirmed = saverTrendStreak >= 2 || Object.keys(trendByDomain ?? {}).length === 0;
    if (summary?.cheapestVariant === "saver" && Number.isFinite(reductionGap) && reductionGap >= 4 && saverTrendConfirmed) {
      matchedDomains.push(domain);
      const liveTokensUsed = Number(tokensByDomain?.[domain]) || 0;
      domainPriorities[domain] = Math.round(liveTokensUsed + (reductionGap * 1000) + (saverTrendStreak * 500));
    }
  }

  return {
    matchedDomains,
    domainPriorities,
    shouldLeanBalancedLane: matchedDomains.length >= Math.max(2, Math.ceil(monitoredDomains.length / 2))
  };
}

function summarizeBenchmarkForCanary(benchmark) {
  // Canary reconciliation should not look only at one global number.
  // We also keep a small per-domain summary so cheap domains like docs/deploy
  // can trigger a rollback even when auth/security keeps the global average flat.
  const monitoredDomains = Object.fromEntries(
    Object.entries(benchmark?.aggregate?.byDomain ?? {}).map(([domain, summary]) => [
      domain,
      {
        cheapestVariant: summary?.cheapestVariant ?? null,
        balancedReductionPercent: summary?.byVariant?.balanced?.reductionPercent ?? null,
        saverReductionPercent: summary?.byVariant?.saver?.reductionPercent ?? null
      }
    ])
  );

  return {
    generatedAt: benchmark?.generatedAt ?? null,
    cheapestVariant: benchmark?.aggregate?.cheapestVariant ?? null,
    balancedReductionPercent: benchmark?.aggregate?.byVariant?.balanced?.reductionPercent ?? null,
    saverReductionPercent: benchmark?.aggregate?.byVariant?.saver?.reductionPercent ?? null,
    byVariant: Object.fromEntries(
      Object.entries(benchmark?.aggregate?.byVariant ?? {}).map(([variant, summary]) => [
        variant,
        {
          totalTokens: summary?.totalTokens ?? null,
          reductionPercent: summary?.reductionPercent ?? null
        }
      ])
    ),
    byDomain: monitoredDomains
  };
}

function preserveExistingCanary(canary) {
  if (canary?.status === "pending") {
    return canary;
  }
  return {
    status: "idle",
    baselineBenchmark: null,
    rollbackPlan: [],
    reconciledAt: canary?.reconciledAt ?? null,
    reconciliation: canary?.reconciliation ?? null
  };
}

function evaluateCanaryRegression(previousBenchmark, nextBenchmark, tuningConfig = {}) {
  const reasons = [];
  const rollbackThreshold = Number(tuningConfig.rollbackRegressionThresholdPercent) || 3;
  const rollbackOnCheapestVariantShift = tuningConfig.rollbackOnCheapestVariantShift !== false;
  const monitoredDomains = tuningConfig.canaryDomains ?? ["docs", "deploy", "ui", "testing"];
  const domainReasons = buildDomainCanaryReasons(
    previousBenchmark?.byDomain ?? {},
    nextBenchmark?.byDomain ?? {},
    monitoredDomains,
    rollbackThreshold,
    rollbackOnCheapestVariantShift
  );
  reasons.push(...domainReasons);

  if (reasons.length === 0) {
    const previousBalancedReduction = Number(previousBenchmark?.balancedReductionPercent);
    const nextBalancedReduction = Number(nextBenchmark?.balancedReductionPercent);

    if (rollbackOnCheapestVariantShift
      && previousBenchmark?.cheapestVariant
      && nextBenchmark?.cheapestVariant
      && previousBenchmark.cheapestVariant !== nextBenchmark.cheapestVariant) {
      reasons.push(`cheapest variant changed from ${previousBenchmark.cheapestVariant} to ${nextBenchmark.cheapestVariant}`);
    }

    if (Number.isFinite(previousBalancedReduction) && Number.isFinite(nextBalancedReduction)) {
      const delta = nextBalancedReduction - previousBalancedReduction;
      if (delta <= -rollbackThreshold) {
        reasons.push(`balanced reduction percent dropped by ${Math.abs(delta).toFixed(2)} points`);
      }
    }
  }

  return {
    shouldRollback: reasons.length > 0,
    reasons
  };
}

function buildDomainCanaryReasons(previousDomains, nextDomains, monitoredDomains, rollbackThreshold, rollbackOnCheapestVariantShift) {
  const reasons = [];

  for (const domain of monitoredDomains) {
    const previous = previousDomains?.[domain];
    const next = nextDomains?.[domain];
    if (!previous || !next) {
      continue;
    }

    if (rollbackOnCheapestVariantShift
      && previous.cheapestVariant
      && next.cheapestVariant
      && previous.cheapestVariant !== next.cheapestVariant) {
      reasons.push(`${domain} cheapest variant changed from ${previous.cheapestVariant} to ${next.cheapestVariant}`);
      continue;
    }

    const previousBalancedReduction = Number(previous.balancedReductionPercent);
    const nextBalancedReduction = Number(next.balancedReductionPercent);
    if (!Number.isFinite(previousBalancedReduction) || !Number.isFinite(nextBalancedReduction)) {
      continue;
    }

    const delta = nextBalancedReduction - previousBalancedReduction;
    if (delta <= -rollbackThreshold) {
      reasons.push(`${domain} balanced reduction percent dropped by ${Math.abs(delta).toFixed(2)} points`);
    }
  }

  return reasons;
}

function maybePushSuggestion(suggestions, suggestion) {
  if (!suggestion.condition) {
    return;
  }
  suggestions.push({
    id: suggestion.id,
    reason: suggestion.reason,
    path: suggestion.path,
    currentValue: suggestion.currentValue,
    proposedValue: suggestion.proposedValue,
    expectedImpact: suggestion.expectedImpact ?? null,
    priority: Number(suggestion.priority) || 0,
    canApply: suggestion.currentValue !== suggestion.proposedValue,
    canAutoApply: suggestion.currentValue !== suggestion.proposedValue && suggestion.canAutoApply === true
  });
}

function compareAutoTuneSuggestions(left, right) {
  const priorityDelta = (Number(right.priority) || 0) - (Number(left.priority) || 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return String(left.id).localeCompare(String(right.id));
}

function buildTuningPlan(suggestions) {
  const steps = [
    {
      phase: "cheap-domains",
      title: "Tighten low-risk domains first",
      suggestions: suggestions.filter((item) => item.id.startsWith("domain-tighten-value-gate-"))
    },
    {
      phase: "balanced-lane",
      title: "Lean the balanced lane",
      suggestions: suggestions.filter((item) => item.id.startsWith("benchmark-") || item.id === "tighten-value-gate" || item.id === "relax-value-gate")
    },
    {
      phase: "global-policy",
      title: "Adjust global queue and ranking pressure",
      suggestions: suggestions.filter((item) => ["raise-domain-threshold", "tighten-ranking-floor", "raise-apply-budget"].includes(item.id))
    },
    {
      phase: "manual-checkpoints",
      title: "Revisit approval timing and manual controls",
      suggestions: suggestions.filter((item) => ["extend-approval-ttl", "widen-expiry-action"].includes(item.id))
    }
  ]
    .map((step) => ({
      ...step,
      suggestions: [...step.suggestions].sort(compareAutoTuneSuggestions)
    }))
    .filter((step) => step.suggestions.length > 0);

  return {
    steps: steps.map((step, index) => ({
      order: index + 1,
      phase: step.phase,
      title: step.title,
      suggestionIds: step.suggestions.map((item) => item.id),
      expectedImpact: summarizePlanStepImpact(step.suggestions),
      deltaBreakdown: summarizePlanStepDeltaBreakdown(step.suggestions),
      expectedImpactSummary: summarizePlanStepText(step.suggestions),
      confidence: buildPlanPhaseConfidence(step.phase, step.suggestions),
      riskLevel: inferPlanPhaseRisk(step.phase),
      whyThisPhase: explainPlanPhase(step.phase, step.suggestions),
      autoApplicableCount: step.suggestions.filter((item) => item.canAutoApply).length,
      applyableCount: step.suggestions.filter((item) => item.canApply).length
    })),
    recommendation: steps[0]
      ? `Start with ${steps[0].title.toLowerCase()} before moving to broader policy changes.`
      : "No bounded tuning plan is needed right now."
  };
}

function explainPlanPhase(phase, suggestions) {
  if (phase === "cheap-domains") {
    const first = suggestions[0]?.expectedImpact;
    if (first?.domain) {
      return `${first.domain} is currently the lead cheap-domain savings target, so bounded tuning starts there before broader balanced-lane changes.`;
    }
    return "Cheap low-risk domains are tuned first because they usually offer the safest token savings.";
  }
  if (phase === "balanced-lane") {
    const estimatedTokenDelta = suggestions.reduce((total, item) => total + (Number(item.expectedImpact?.estimatedTokenDelta) || 0), 0);
    return estimatedTokenDelta > 0
      ? `Balanced-lane tuning is next because the current benchmark suggests about ${estimatedTokenDelta} extra tokens versus the leaner saver lane.`
      : "Balanced-lane tuning comes after cheap domains because it changes broader review behavior.";
  }
  if (phase === "global-policy") {
    return "Global policy changes are delayed until after cheap-domain and balanced-lane fixes because they have wider blast radius.";
  }
  if (phase === "manual-checkpoints") {
    return "Manual checkpoint changes come last because they alter operator workflow rather than the cheapest runtime lane.";
  }
  return "This phase contains bounded follow-up tuning work.";
}

function findSuggestionPhase(tuningPlan, suggestionId) {
  return tuningPlan?.steps?.find((step) => step.suggestionIds.includes(suggestionId))?.phase ?? null;
}

function filterSuggestionsByPhase(suggestions, tuningPlan, selectedPhase) {
  if (!selectedPhase) {
    return suggestions;
  }
  const phase = tuningPlan.steps.find((step) => step.phase === selectedPhase);
  if (!phase) {
    return [];
  }
  const ids = new Set(phase.suggestionIds);
  return suggestions.filter((item) => ids.has(item.id));
}

function summarizePlanStepImpact(suggestions) {
  const domainImpacts = suggestions
    .map((item) => item.expectedImpact)
    .filter((impact) => impact?.type === "domain-value-gate");
  const balancedImpacts = suggestions
    .map((item) => item.expectedImpact)
    .filter((impact) => impact?.type === "balanced-lane");

  return {
    domains: domainImpacts.map((impact) => ({
      domain: impact.domain,
      liveTokensUsed: impact.liveTokensUsed,
      reductionGap: impact.reductionGap,
      thresholdDelta: impact.thresholdDelta
    })),
    estimatedTokenDelta: balancedImpacts.reduce((total, impact) => total + (Number(impact.estimatedTokenDelta) || 0), 0),
    affectedDomains: [...new Set(balancedImpacts.flatMap((impact) => impact.affectedDomains ?? []))]
  };
}

function summarizePlanStepText(suggestions) {
  const domainImpacts = suggestions
    .map((item) => item.expectedImpact)
    .filter((impact) => impact?.type === "domain-value-gate");
  if (domainImpacts.length > 0) {
    const domains = domainImpacts.map((impact) => impact.domain).join(", ");
    const liveTokens = domainImpacts.reduce((total, impact) => total + (Number(impact.liveTokensUsed) || 0), 0);
    return `Targets cheap domains (${domains}) with about ${liveTokens} recent live tokens attached to the current drift signal.`;
  }

  const balancedImpacts = suggestions
    .map((item) => item.expectedImpact)
    .filter((impact) => impact?.type === "balanced-lane");
  if (balancedImpacts.length > 0) {
    const estimatedTokenDelta = balancedImpacts.reduce((total, impact) => total + (Number(impact.estimatedTokenDelta) || 0), 0);
    return `Targets broader balanced-lane behavior with an estimated ${estimatedTokenDelta} token gap versus the leaner saver lane.`;
  }

  return "Targets bounded policy changes that should have limited blast radius but still improve operator control.";
}

function summarizePlanStepDeltaBreakdown(suggestions) {
  const domainImpacts = suggestions
    .map((item) => item.expectedImpact)
    .filter((impact) => impact?.type === "domain-value-gate");
  const balancedImpacts = suggestions
    .map((item) => item.expectedImpact)
    .filter((impact) => impact?.type === "balanced-lane");

  return {
    domainCount: domainImpacts.length,
    totalThresholdDelta: domainImpacts.reduce((total, impact) => total + (Number(impact.thresholdDelta) || 0), 0),
    totalLiveTokensUsed: domainImpacts.reduce((total, impact) => total + (Number(impact.liveTokensUsed) || 0), 0),
    maxReductionGap: domainImpacts.reduce((max, impact) => Math.max(max, Number(impact.reductionGap) || 0), 0),
    estimatedTokenDelta: balancedImpacts.reduce((total, impact) => total + (Number(impact.estimatedTokenDelta) || 0), 0),
    affectedDomainCount: [...new Set(balancedImpacts.flatMap((impact) => impact.affectedDomains ?? []))].length
  };
}

function buildPlanPhaseConfidence(phase, suggestions) {
  const deltaBreakdown = summarizePlanStepDeltaBreakdown(suggestions);
  let score = 0;
  const reasons = [];

  if (phase === "cheap-domains") {
    if (deltaBreakdown.domainCount >= 2) {
      score += 35;
      reasons.push("multiple cheap domains agree on the same direction");
    } else if (deltaBreakdown.domainCount === 1) {
      score += 20;
      reasons.push("one cheap domain shows a strong local drift signal");
    }

    if (deltaBreakdown.totalLiveTokensUsed >= 10000) {
      score += 30;
      reasons.push("the phase targets a meaningful amount of live token burn");
    } else if (deltaBreakdown.totalLiveTokensUsed > 0) {
      score += 15;
      reasons.push("the phase targets some measured live token burn");
    }

    if (deltaBreakdown.maxReductionGap >= 6) {
      score += 20;
      reasons.push("the saver-vs-balanced reduction gap is wide");
    } else if (deltaBreakdown.maxReductionGap >= 4) {
      score += 10;
      reasons.push("the saver-vs-balanced reduction gap is usable");
    }

    if (deltaBreakdown.totalThresholdDelta >= 5) {
      score += 15;
      reasons.push("the phase has a concrete local gate delta to apply");
    }
  } else if (phase === "balanced-lane") {
    if (deltaBreakdown.estimatedTokenDelta >= 2000) {
      score += 45;
      reasons.push("the balanced lane still carries a large synthetic token gap");
    } else if (deltaBreakdown.estimatedTokenDelta >= 500) {
      score += 25;
      reasons.push("the balanced lane still carries a measurable synthetic token gap");
    }

    if (deltaBreakdown.affectedDomainCount >= 2) {
      score += 30;
      reasons.push("the balanced lane signal spans multiple domains");
    } else if (deltaBreakdown.affectedDomainCount === 1) {
      score += 15;
      reasons.push("the balanced lane signal is visible in at least one domain");
    }

    if (suggestions.length >= 2) {
      score += 15;
      reasons.push("multiple bounded suggestions point at the same lane");
    }
  } else {
    if (suggestions.length >= 2) {
      score += 35;
      reasons.push("multiple suggestions support this phase");
    } else if (suggestions.length === 1) {
      score += 20;
      reasons.push("this phase currently relies on a single bounded suggestion");
    }
    score += 15;
    reasons.push("the phase is intentionally bounded even if its signal is weaker");
  }

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

function inferSuggestionRisk(suggestion) {
  const effectType = suggestion.expectedImpact?.type ?? "other";
  if (effectType === "domain-value-gate") {
    return "low";
  }
  if (effectType === "balanced-lane") {
    return "medium";
  }
  if (suggestion.id === "extend-approval-ttl" || suggestion.id === "widen-expiry-action") {
    return "medium";
  }
  return "medium";
}

function summarizeSuggestionImpact(suggestion) {
  const impact = suggestion.expectedImpact ?? null;
  if (impact?.type === "domain-value-gate") {
    return `${impact.domain} is carrying ${impact.liveTokensUsed} live tokens with a ${impact.reductionGap.toFixed(2)} point saver advantage, so this raises only that cheap-domain gate by ${impact.thresholdDelta}.`;
  }
  if (impact?.type === "balanced-lane") {
    const domains = (impact.affectedDomains ?? []).join(", ");
    return domains
      ? `Touches the balanced lane across ${domains} and aims to recover about ${impact.estimatedTokenDelta} tokens from the current saver gap.`
      : `Touches the balanced lane and aims to recover about ${impact.estimatedTokenDelta} tokens from the current saver gap.`;
  }
  return "Applies a bounded runtime-policy change with limited surface area.";
}

function inferPlanPhaseRisk(phase) {
  if (phase === "cheap-domains") {
    return "low";
  }
  if (phase === "balanced-lane") {
    return "medium";
  }
  return "medium";
}

function buildTuningWorkflow(tuningPlan, selectedPhase) {
  const phases = tuningPlan.steps.map((step) => ({
    phase: step.phase,
    title: step.title,
    riskLevel: step.riskLevel,
    confidence: step.confidence,
    objective: inferWorkflowObjective(step.phase, step.expectedImpact, step.deltaBreakdown),
    readyState: inferWorkflowReadyState(step),
    gatingReason: inferWorkflowGatingReason(step),
    deltaBreakdown: step.deltaBreakdown,
    expectedDeltaCard: buildWorkflowDeltaCard(step.expectedImpact, step.deltaBreakdown),
    expectedImpactSummary: step.expectedImpactSummary,
    whyThisPhase: step.whyThisPhase,
    commands: {
      preview: `node src/cli.mjs tune --phase ${step.phase}`,
      apply: `node src/cli.mjs tune --apply --phase ${step.phase}`,
      auto: `node src/cli.mjs tune --auto --phase ${step.phase}`,
      benchmark: "node src/cli.mjs benchmark --iterations 3 --autoTuneBetweenRuns",
      reconcile: `node src/cli.mjs tune --reconcile --phase ${step.phase}`
    },
    recommendedLoop: [
      `Preview ${step.phase} suggestions`,
      `Apply only the ${step.phase} phase`,
      "Run a short benchmark cycle",
      `Reconcile or roll back ${step.phase} if the canary regresses`
    ]
  }));

  return {
    selectedPhase,
    recommendation: selectedPhase
      ? `Work only the ${selectedPhase} phase, then re-benchmark before moving to the next phase.`
      : "Work phases in order: preview, apply one phase, benchmark, then reconcile before widening the blast radius.",
    phases
  };
}

function inferWorkflowObjective(phase, expectedImpact, deltaBreakdown) {
  if (phase === "cheap-domains") {
    return `Tighten cheap-domain gates first so weak low-risk review jobs stop before they reach the live lane.`;
  }
  if (phase === "balanced-lane") {
    return `Lean the balanced lane so medium-risk review work stays cheaper without touching the expensive path.`;
  }
  if (phase === "global-policy") {
    return `Adjust broader runtime pressure only after cheap-domain and balanced-lane fixes stop most obvious waste.`;
  }
  return `Revisit manual checkpoints after the automated cheap savings phases are stable.`;
}

function inferWorkflowReadyState(step) {
  if ((step.applyableCount ?? 0) === 0) {
    return "watch";
  }
  if ((step.autoApplicableCount ?? 0) > 0) {
    return "ready";
  }
  return "manual";
}

function inferWorkflowGatingReason(step) {
  if ((step.applyableCount ?? 0) === 0) {
    return "No bounded change is currently applyable in this phase, so the operator should wait for fresher benchmark evidence.";
  }
  if ((step.autoApplicableCount ?? 0) > 0) {
    return "At least one bounded change in this phase is auto-applicable, so this phase is ready for a preview/apply cycle.";
  }
  return "This phase has applyable changes, but they still require a manual checkpoint rather than auto-apply.";
}

function buildWorkflowDeltaCard(expectedImpact, deltaBreakdown) {
  return {
    estimatedTokenDelta: Number(expectedImpact?.estimatedTokenDelta) || 0,
    affectedDomainCount: Array.isArray(expectedImpact?.domains)
      ? expectedImpact.domains.length
      : Array.isArray(expectedImpact?.affectedDomains)
        ? expectedImpact.affectedDomains.length
        : 0,
    totalThresholdDelta: Number(deltaBreakdown?.totalThresholdDelta) || 0,
    applyableChanges: Number(deltaBreakdown?.applyableChanges) || 0,
    autoApplicableChanges: Number(deltaBreakdown?.autoApplicableChanges) || 0
  };
}

function applyConfigPatch(config, pathSegments, value) {
  let cursor = config;
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    const segment = pathSegments[index];
    cursor[segment] ??= {};
    cursor = cursor[segment];
  }
  const leaf = pathSegments[pathSegments.length - 1];
  if (value === undefined) {
    delete cursor[leaf];
    return;
  }
  cursor[leaf] = value;
}

function averageLatency(bucket) {
  const count = Number(bucket?.count) || 0;
  const total = Number(bucket?.total) || 0;
  return count > 0 ? total / count : 0;
}

function isWithinCooldown(lastAppliedAt, now, cooldownMinutes) {
  const lastMs = Date.parse(lastAppliedAt ?? "");
  const nowMs = Date.parse(now);
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  return (nowMs - lastMs) < cooldownMinutes * 60 * 1000;
}

async function trimHistoryFile(filePath, maxEntries) {
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
    return;
  }
  const raw = await readJsonLines(filePath);
  const retained = raw.slice(-maxEntries);
  const next = retained.length > 0 ? `${retained.join("\n")}\n` : "";
  await writeHistoryText(filePath, next);
}

async function readJsonLines(filePath) {
  const raw = await readText(filePath);
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function writeHistoryText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}
