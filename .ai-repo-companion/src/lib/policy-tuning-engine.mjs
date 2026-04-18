import path from "node:path";
import { getReviewMetrics } from "./review-metrics-engine.mjs";
import { readJson, writeJson } from "./store.mjs";

// The tuner is intentionally conservative.
// It only suggests a handful of bounded changes so the repo owner can nudge
// the system with data instead of rewriting policy by gut feel.

export async function analyzePolicyTuning(rootDir) {
  const configPath = path.join(rootDir, "config/system.json");
  const config = await readJson(configPath, {});
  const metrics = await getReviewMetrics(rootDir);
  const suggestions = buildPolicySuggestions(config, metrics);

  return {
    configPath,
    metrics,
    suggestions,
    summary: {
      suggestionCount: suggestions.length,
      applyableCount: suggestions.filter((item) => item.canApply).length
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

function buildPolicySuggestions(config, metrics) {
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
    proposedValue: Math.min(8, (config.memoryPolicy?.sameDomainEventThreshold ?? 3) + 1)
  });

  maybePushSuggestion(suggestions, {
    id: "tighten-ranking-floor",
    condition: rejectedOps >= Math.max(3, appliedOps + 2),
    reason: "Rejected operations are outnumbering applied operations, so the review gate can start stricter.",
    path: ["reviewExecution", "operationRanking", "minScore"],
    currentValue: config.reviewExecution?.operationRanking?.minScore ?? 35,
    proposedValue: Math.min(80, (config.reviewExecution?.operationRanking?.minScore ?? 35) + 5)
  });

  maybePushSuggestion(suggestions, {
    id: "raise-apply-budget",
    condition: deferredOps >= 3 && appliedOps >= 2,
    reason: "Valid operations are being deferred often enough that the apply budget may be too tight.",
    path: ["reviewExecution", "operationRanking", "maxAppliedOperations"],
    currentValue: config.reviewExecution?.operationRanking?.maxAppliedOperations ?? 2,
    proposedValue: Math.min(5, (config.reviewExecution?.operationRanking?.maxAppliedOperations ?? 2) + 1)
  });

  maybePushSuggestion(suggestions, {
    id: "extend-approval-ttl",
    condition: (counters.approvalsExpiredRequeued ?? 0) + (counters.approvalsExpiredClosed ?? 0) > 0,
    reason: "Pending approvals are expiring, so the manual checkpoint is probably too short for real usage.",
    path: ["reviewExecution", "approval", "pendingApprovalTtlMinutes"],
    currentValue: config.reviewExecution?.approval?.pendingApprovalTtlMinutes ?? 240,
    proposedValue: Math.min(1440, (config.reviewExecution?.approval?.pendingApprovalTtlMinutes ?? 240) + 60)
  });

  maybePushSuggestion(suggestions, {
    id: "widen-expiry-action",
    condition: approvalLatencyAvg >= 120 && (counters.approvalsExpiredClosed ?? 0) > 0,
    reason: "Approval latency is high and approvals are expiring closed, so requeue is safer than silent closure.",
    path: ["reviewExecution", "approval", "onExpired"],
    currentValue: config.reviewExecution?.approval?.onExpired ?? "requeue",
    proposedValue: "requeue"
  });

  maybePushSuggestion(suggestions, {
    id: "tighten-value-gate",
    condition: (counters.processedJobs ?? 0) >= 3 && avgTokensPerSelectedOperation >= 30000,
    reason: "Live review is expensive relative to the amount of useful note work getting through, so more weak balanced jobs should be skipped before model execution.",
    path: ["reviewExecution", "valueGate", "minScore"],
    currentValue: config.reviewExecution?.valueGate?.minScore ?? 60,
    proposedValue: Math.min(90, (config.reviewExecution?.valueGate?.minScore ?? 60) + 5)
  });

  maybePushSuggestion(suggestions, {
    id: "relax-value-gate",
    condition: (counters.skippedJobs ?? 0) >= 3 && avgTokensPerSelectedOperation > 0 && avgTokensPerSelectedOperation <= 8000,
    reason: "Many jobs are being skipped while live review is already cheap enough, so the value gate can be relaxed slightly.",
    path: ["reviewExecution", "valueGate", "minScore"],
    currentValue: config.reviewExecution?.valueGate?.minScore ?? 60,
    proposedValue: Math.max(30, (config.reviewExecution?.valueGate?.minScore ?? 60) - 5)
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
    canApply: suggestion.currentValue !== suggestion.proposedValue
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
