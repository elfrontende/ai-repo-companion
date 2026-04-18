import fs from "node:fs/promises";
import path from "node:path";
import { getReviewMetrics } from "./review-metrics-engine.mjs";
import { appendLine, readJson, writeJson } from "./store.mjs";

// The tuner is intentionally conservative.
// It only suggests a handful of bounded changes so the repo owner can nudge
// the system with data instead of rewriting policy by gut feel.

export async function analyzePolicyTuning(rootDir) {
  const configPath = path.join(rootDir, "config/system.json");
  const benchmarkPath = path.join(rootDir, "state/benchmarks/last-benchmark.json");
  const config = await readJson(configPath, {});
  const metrics = await getReviewMetrics(rootDir);
  const benchmark = await readJson(benchmarkPath, null);
  const suggestions = buildPolicySuggestions(config, metrics, benchmark);

  return {
    configPath,
    benchmarkPath,
    metrics,
    benchmark,
    suggestions,
    summary: {
      benchmarkLoaded: Boolean(benchmark?.aggregate),
      suggestionCount: suggestions.length,
      applyableCount: suggestions.filter((item) => item.canApply).length,
      autoApplicableCount: suggestions.filter((item) => item.canAutoApply).length
    }
  };
}

export async function applyPolicyTuning(rootDir) {
  const analysis = await analyzePolicyTuning(rootDir);
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

export async function runAutoPolicyTuning(rootDir) {
  const analysis = await analyzePolicyTuning(rootDir);
  const config = await readJson(analysis.configPath, {});
  const tuningConfig = config.tuning ?? {};
  const statePath = path.join(rootDir, "state/tuning/auto-tune-state.json");
  const lastTuningPath = path.join(rootDir, "state/tuning/last-tuning.json");
  const historyPath = path.join(rootDir, "state/tuning/history.jsonl");
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
      blocked: []
    };
  }

  const cooldownMinutes = Number(tuningConfig.cooldownMinutes) || 720;
  const autoIds = new Set(tuningConfig.autoApplySuggestionIds ?? []);
  const candidates = analysis.suggestions.map((suggestion) => ({
    ...suggestion,
    canAutoApply: suggestion.canApply && autoIds.has(suggestion.id)
  }));
  const blocked = [];
  const applied = [];

  for (const suggestion of candidates) {
    if (!suggestion.canAutoApply) {
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
      proposedValue: suggestion.proposedValue
    });
    state.lastAppliedById ??= {};
    state.lastAppliedById[suggestion.id] = now;
  }

  if (applied.length > 0) {
    await writeJson(analysis.configPath, config);
  }

  const result = {
    ...analysis,
    mode: "auto",
    enabled: true,
    cooldownMinutes,
    applied,
    blocked
  };

  await writeJson(statePath, state);
  await writeJson(lastTuningPath, {
    generatedAt: now,
    mode: "auto",
    summary: {
      suggestionCount: analysis.summary.suggestionCount,
      applyableCount: analysis.summary.applyableCount,
      autoApplicableCount: candidates.filter((item) => item.canAutoApply).length
    },
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
    canAutoApply: true
  });

  maybePushSuggestion(suggestions, {
    id: "tighten-ranking-floor",
    condition: rejectedOps >= Math.max(3, appliedOps + 2),
    reason: "Rejected operations are outnumbering applied operations, so the review gate can start stricter.",
    path: ["reviewExecution", "operationRanking", "minScore"],
    currentValue: config.reviewExecution?.operationRanking?.minScore ?? 35,
    proposedValue: Math.min(80, (config.reviewExecution?.operationRanking?.minScore ?? 35) + 5),
    canAutoApply: true
  });

  maybePushSuggestion(suggestions, {
    id: "raise-apply-budget",
    condition: deferredOps >= 3 && appliedOps >= 2,
    reason: "Valid operations are being deferred often enough that the apply budget may be too tight.",
    path: ["reviewExecution", "operationRanking", "maxAppliedOperations"],
    currentValue: config.reviewExecution?.operationRanking?.maxAppliedOperations ?? 2,
    proposedValue: Math.min(5, (config.reviewExecution?.operationRanking?.maxAppliedOperations ?? 2) + 1),
    canAutoApply: false
  });

  maybePushSuggestion(suggestions, {
    id: "extend-approval-ttl",
    condition: (counters.approvalsExpiredRequeued ?? 0) + (counters.approvalsExpiredClosed ?? 0) > 0,
    reason: "Pending approvals are expiring, so the manual checkpoint is probably too short for real usage.",
    path: ["reviewExecution", "approval", "pendingApprovalTtlMinutes"],
    currentValue: config.reviewExecution?.approval?.pendingApprovalTtlMinutes ?? 240,
    proposedValue: Math.min(1440, (config.reviewExecution?.approval?.pendingApprovalTtlMinutes ?? 240) + 60),
    canAutoApply: false
  });

  maybePushSuggestion(suggestions, {
    id: "widen-expiry-action",
    condition: approvalLatencyAvg >= 120 && (counters.approvalsExpiredClosed ?? 0) > 0,
    reason: "Approval latency is high and approvals are expiring closed, so requeue is safer than silent closure.",
    path: ["reviewExecution", "approval", "onExpired"],
    currentValue: config.reviewExecution?.approval?.onExpired ?? "requeue",
    proposedValue: "requeue",
    canAutoApply: false
  });

  maybePushSuggestion(suggestions, {
    id: "tighten-value-gate",
    condition: (counters.processedJobs ?? 0) >= 3 && avgTokensPerSelectedOperation >= 30000,
    reason: "Live review is expensive relative to the amount of useful note work getting through, so more weak balanced jobs should be skipped before model execution.",
    path: ["reviewExecution", "valueGate", "minScore"],
    currentValue: config.reviewExecution?.valueGate?.minScore ?? 60,
    proposedValue: Math.min(90, (config.reviewExecution?.valueGate?.minScore ?? 60) + 5),
    canAutoApply: true
  });

  maybePushSuggestion(suggestions, {
    id: "relax-value-gate",
    condition: (counters.skippedJobs ?? 0) >= 3 && avgTokensPerSelectedOperation > 0 && avgTokensPerSelectedOperation <= 8000,
    reason: "Many jobs are being skipped while live review is already cheap enough, so the value gate can be relaxed slightly.",
    path: ["reviewExecution", "valueGate", "minScore"],
    currentValue: config.reviewExecution?.valueGate?.minScore ?? 60,
    proposedValue: Math.max(30, (config.reviewExecution?.valueGate?.minScore ?? 60) - 5),
    canAutoApply: true
  });

  // Runtime metrics tell us whether the current policy wastes live calls.
  // Benchmark variants tell us whether the cheaper review lane consistently
  // wins on the same synthetic workload. We use both signals so the tuner
  // does not overreact to one noisy day of real runs.
  const balancedVariant = benchmark?.aggregate?.byVariant?.balanced;
  const saverVariant = benchmark?.aggregate?.byVariant?.saver;

  maybePushSuggestion(suggestions, {
    id: "benchmark-lower-balanced-effort",
    condition: benchmark?.aggregate?.cheapestVariant === "saver"
      && Number(saverVariant?.totalTokens) > 0
      && Number(balancedVariant?.totalTokens) > Number(saverVariant?.totalTokens) * 1.08,
    reason: "Synthetic benchmark says the saver profile is clearly cheaper than balanced, so the default balanced Codex reasoning effort can be lowered.",
    path: ["reviewExecution", "reviewProfiles", "balanced", "codexReasoningEffort"],
    currentValue: config.reviewExecution?.reviewProfiles?.balanced?.codexReasoningEffort ?? "medium",
    proposedValue: "low",
    canAutoApply: true
  });

  maybePushSuggestion(suggestions, {
    id: "benchmark-lean-balanced-operations",
    condition: benchmark?.aggregate?.cheapestVariant === "saver"
      && Number(saverVariant?.totalTokens) > 0
      && Number(balancedVariant?.totalTokens) > Number(saverVariant?.totalTokens) * 1.12,
    reason: "Synthetic benchmark shows balanced is still materially heavier than saver, so its operation budget should shrink toward the cheaper lane.",
    path: ["reviewExecution", "reviewProfiles", "balanced", "maxOperations"],
    currentValue: config.reviewExecution?.reviewProfiles?.balanced?.maxOperations ?? 2,
    proposedValue: 1,
    canAutoApply: true
  });

  return suggestions;
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
    canApply: suggestion.currentValue !== suggestion.proposedValue,
    canAutoApply: suggestion.currentValue !== suggestion.proposedValue && suggestion.canAutoApply === true
  });
}

function applyConfigPatch(config, pathSegments, value) {
  let cursor = config;
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    const segment = pathSegments[index];
    cursor[segment] ??= {};
    cursor = cursor[segment];
  }
  cursor[pathSegments[pathSegments.length - 1]] = value;
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
